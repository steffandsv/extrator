/* eslint-disable no-console */
const { workerData, parentPort } = require('worker_threads');
const puppeteer = require('puppeteer');
const mysql = require('mysql2/promise');

const { db: dbConfig, headless, workerId, cities } = workerData;

// =======================
//  Reuso da sua LÓGICA
// =======================

/**
 * Converte 'dd/mm/yyyy hh:mi' -> 'yyyy-mm-dd hh:mi:ss'
 * (IDÊNTICO AO SEU SCRIPT)  [fonte: extrator.js]
 */
function convertDateTime(dateTimeStr) {
  if (!dateTimeStr || !dateTimeStr.includes('/')) return null;
  const parts = dateTimeStr.match(/(\d{2})\/(\d{2})\/(\d{4})\s*(\d{2}):(\d{2})/);
  if (!parts) return null;
  return `${parts[3]}-${parts[2]}-${parts[1]} ${parts[4]}:${parts[5]}:00`;
}

/**
 * Extrai licitações de um município via Puppeteer, seguindo exatamente
 * o fluxo de navegação e seletores do seu script original.  [fonte: extrator.js]
 */
async function extractBidsForCity(page, city) {
  let bidData = [];
  try {
    await page.goto(`${city.DS_DOMAIN}/comprasedital`, { waitUntil: 'networkidle2', timeout: 60000 });

    await page.evaluate(() => {
      const publicoLink = Array.from(document.querySelectorAll('a')).find(el => el.textContent.includes('03. Público'));
      if (publicoLink) publicoLink.click();
    });

    await page.waitForSelector('a', { timeout: 10000 });
    await page.evaluate(() => {
      const licitacaoEletronicaLink = Array.from(document.querySelectorAll('a')).find(el => el.textContent.includes('03.01. Licitação Eletrônica'));
      if (licitacaoEletronicaLink) licitacaoEletronicaLink.click();
    });

    const dataResponse = await page.waitForResponse(
      response =>
        response.url().includes('comprasedital.dll/HandleEvent?IsEvent=1') &&
        response.url().includes('Evt=data') &&
        response.status() === 200,
      { timeout: 30000 }
    );

    const json = await dataResponse.json();
    if (json && json.rows) bidData = json.rows;
  } catch (error) {
    // Mantemos a semântica do original: retornar [] e logar o erro no chamador
    throw new Error(error.message || 'Falha ao extrair JSON');
  }
  return bidData;
}

/**
 * Monta os valores para insert/update.
 * OBS: id = `${bid[4]}-${bid[3]}` (idêntico ao original)  [fonte: extrator.js]
 */
function buildInsertValuesFromBids(bids, cd_ibge) {
  return bids
    .filter(bid => bid && bid[4] && bid[3])
    .map(bid => {
      const id = `${bid[4]}-${bid[3]}`;
      const data_final_convertida = convertDateTime(bid[6]);
      return [id, cd_ibge, bid[3], bid[4], bid[5], data_final_convertida, bid[7], bid[9]];
    });
}

/**
 * Persiste licitações (ON DUPLICATE KEY UPDATE), preservando a semântica
 * do seu SQL original.  [fonte: extrator.js + schema]
 */
async function saveBidsToDatabase(connection, values) {
  if (values.length === 0) return { affectedRows: 0 };
  const query = `
    INSERT INTO licitacoes (id, cd_ibge, numero_processo, orgao, status, data_final, objeto, modalidade)
    VALUES ?
    ON DUPLICATE KEY UPDATE
      cd_ibge = VALUES(cd_ibge),
      status = VALUES(status),
      data_final = VALUES(data_final),
      objeto = VALUES(objeto),
      modalidade = VALUES(modalidade),
      updated_at = CURRENT_TIMESTAMP
  `;
  const [result] = await connection.query(query, [values]);
  return result;
}

// =======================
//  WORKER MAIN
// =======================
(async () => {
  const connection = await mysql.createConnection(dbConfig);
  const browser = await puppeteer.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36');

  for (const city of cities) {
    const t0 = Date.now();
    try {
      const bids = await extractBidsForCity(page, city); // lógica intacta
      const values = buildInsertValuesFromBids(bids, city.CD_IBGE);

      // Para métricas "novas vs atualizadas": checamos IDs existentes antes do insert
      let newCount = 0;
      let updatedCount = 0;
      if (values.length > 0) {
        const ids = values.map(v => v[0]);
        // MySQL2 expande arrays corretamente em IN (?)
        const [existing] = await connection.query(`SELECT id FROM licitacoes WHERE id IN (?)`, [ids]);
        const existingSet = new Set(existing.map(r => r.id));
        updatedCount = existingSet.size;
        newCount = ids.length - updatedCount;

        await saveBidsToDatabase(connection, values);
      }

      parentPort.postMessage({
        type: 'city_done',
        city: { CD_IBGE: city.CD_IBGE, DS_LABEL: city.DS_LABEL },
        counts: {
          found: bids.length,
          newCount,
          updatedCount,
          error: null,
        },
        tookMs: Date.now() - t0,
      });
    } catch (err) {
      parentPort.postMessage({
        type: 'city_done',
        city: { CD_IBGE: city.CD_IBGE, DS_LABEL: city.DS_LABEL },
        counts: { found: 0, newCount: 0, updatedCount: 0, error: err.message },
        tookMs: Date.now() - t0,
      });
    }
  }

  await browser.close();
  await connection.end();
  parentPort.postMessage({ type: 'done', workerId });
  process.exit(0);
})();

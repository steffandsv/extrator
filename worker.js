/* eslint-disable no-console */
const { workerData, parentPort } = require('worker_threads');
const puppeteer = require('puppeteer');
const mysql = require('mysql2/promise');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

const { db: dbConfig, headless, workerId, cities, force } = workerData;

// --- Helper Functions ---

/**
 * Converte 'dd/mm/yyyy hh:mi' -> 'yyyy-mm-dd hh:mi:ss'
 */
function convertDateTime(dateTimeStr) {
  if (!dateTimeStr || !dateTimeStr.includes('/')) return null;
  const parts = dateTimeStr.match(/(\d{2})\/(\d{2})\/(\d{4})\s*(\d{2}):(\d{2})/);
  if (!parts) return null;
  return `${parts[3]}-${parts[2]}-${parts[1]} ${parts[4]}:${parts[5]}:00`;
}

function parseCurrency(val) {
    if (typeof val !== 'string') return 0;
    // R$ 1.234,56 -> 1234.56
    let s = val.replace('R$', '').trim();
    s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

/**
 * Helper to click a tab by its text content
 */
async function clickTab(page, tabName) {
    return page.evaluate((name) => {
        // Look for the inner text in standard tab structure
        const tabs = Array.from(document.querySelectorAll('.x-tab-inner'));
        const target = tabs.find(t => t.innerText.trim().includes(name));
        if (target) {
            target.click();
            return true;
        }
        return false;
    }, tabName);
}

/**
 * Extract data from the "Informações" tab (KeyValue pairs)
 */
async function extractInformacoes(page) {
    return page.evaluate(() => {
        const info = {};
        // Find visible labels in the active form context
        const labels = Array.from(document.querySelectorAll('label.x-form-item-label'));

        labels.forEach(label => {
            if (!label.offsetParent) return; // Skip hidden labels

            const labelText = label.innerText.replace(':', '').trim();
            const itemWrapper = label.closest('.x-form-item');
            if (itemWrapper) {
                const input = itemWrapper.querySelector('input, textarea, .x-form-display-field');
                if (input) {
                    let val = input.value || input.innerText || '';
                    info[labelText] = val.trim();
                }
            }
        });
        return info;
    });
}

/**
 * Extract full text from "Objeto" tab (usually a textarea)
 */
async function extractObjetoFull(page) {
    return page.evaluate(() => {
        const textareas = Array.from(document.querySelectorAll('textarea'));
        for (const ta of textareas) {
            if (ta.offsetParent !== null) {
                 return ta.value || ta.innerText;
            }
        }
        return null;
    });
}

/**
 * Extract Items from the "Itens" tab grid
 */
async function extractItems(page, licitacaoId) {
    const items = [];
    try {
        await new Promise(r => setTimeout(r, 2000));

        // Target grid rows in the active window (detail view)
        // If ExtJS opens a window, it will likely be .x-window.
        // If it replaces the center pane, it might be in a specific panel.
        // We prioritize rows inside a window, then fallback to visible rows.

        const rows = await page.$$('.x-window .x-grid-row');
        const fallbackRows = rows.length ? rows : await page.$$('.x-grid-row');

        for (const row of fallbackRows) {
            const isVisible = await row.evaluate(el => {
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
            });
            if (!isVisible) continue;

            const cells = await row.$$('.x-grid-cell');
            if (cells.length < 5) continue;

            const rowData = [];
            for (const cell of cells) {
                const text = await cell.evaluate(el => el.innerText.trim());
                rowData.push(text);
            }

            // Heuristic mapping
            // [0]=Item, [1]=Cod, [2]=Desc, [3]=Unid, [4]=Qtde, [5]=VlrMedio, [6]=VlrTotal, [7]=Lote

            items.push({
                licitacao_id: licitacaoId,
                item: rowData[0] || '',
                codigo: rowData[1] || '',
                descricao: rowData[2] || '',
                unidade: rowData[3] || '',
                quantidade: parseCurrency(rowData[4]),
                valor_medio: parseCurrency(rowData[5]),
                valor_total: parseCurrency(rowData[6]),
                lote: rowData[7] || null,
                descricao_lote: rowData[8] || null
            });
        }
    } catch (e) {
        // console.error('Error items:', e);
    }
    return items;
}

/**
 * Main process for a city
 */
async function processCity(connection, page, city) {
    try {
        await page.goto(`${city.DS_DOMAIN}/comprasedital`, { waitUntil: 'networkidle2', timeout: 60000 });

        await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const publico = links.find(el => el.textContent.includes('03. Público'));
            if (publico) publico.click();
        });
        await page.waitForSelector('a', { timeout: 10000 });
        await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const link = links.find(el => el.textContent.includes('03.01. Licitação Eletrônica'));
            if (link) link.click();
        });

        // Wait for main grid
        const response = await page.waitForResponse(
            r => r.url().includes('Evt=data') && r.status() === 200,
            { timeout: 30000 }
        );
        const json = await response.json();
        const rows = json.rows || [];

        const now = dayjs();
        const bidsToExplore = [];
        const basicValues = [];

        // Identify bids to process
        for (const bid of rows) {
            // Check indices based on debug output:
            // 3: Processo ("023416/25")
            // 4: Orgao ("PREFEITURA...")
            // 6: Data ("26/09/2025 08:01") - Note: debug said index 6! Not 8.
            // 7: Objeto
            // 9: Modalidade

            if (!bid || !bid[4] || !bid[3]) continue;

            const id = `${bid[4]}-${bid[3]}`;

            // Adjust index for date. In debug sample it was index 6.
            // Previous code assumed 8. Let's try 6, fallback to 8 if needed or regex.
            let dataFinalStr = bid[6];
            // Sanity check: is it a date?
            if (!dataFinalStr || !dataFinalStr.includes('/')) {
                dataFinalStr = bid[8]; // Try old index
            }

            const dataFinal = convertDateTime(dataFinalStr);

            let shouldExplore = false;

            if (force) {
                shouldExplore = true;
            } else if (dataFinal) {
                const d = dayjs(dataFinal);
                if (d.isAfter(now)) {
                    shouldExplore = true;
                }
            }

            if (shouldExplore) {
                bidsToExplore.push({ id, procNum: bid[3] });
            }

            // Insert basic data
            // Schema expects: id, cd_ibge, numero_processo, orgao, status, data_final, objeto, modalidade
            // From sample: 3=Processo, 4=Orgao, 5=Status, 6=Data, 7=Objeto, 9=Modalidade
            basicValues.push([
                id, city.CD_IBGE, bid[3], bid[4], bid[5], dataFinal, bid[7], bid[9]
            ]);
        }

        if (basicValues.length > 0) {
             const query = `
                INSERT INTO licitacoes (id, cd_ibge, numero_processo, orgao, status, data_final, objeto, modalidade)
                VALUES ?
                ON DUPLICATE KEY UPDATE
                status = VALUES(status),
                data_final = VALUES(data_final),
                objeto = VALUES(objeto),
                modalidade = VALUES(modalidade),
                updated_at = CURRENT_TIMESTAMP
            `;
            await connection.query(query, [basicValues]);
        }

        // Deep Dive
        let newItemsCount = 0;

        for (const target of bidsToExplore) {
            const clicked = await page.evaluate((procNum) => {
                 const rows = Array.from(document.querySelectorAll('.x-grid-row'));
                 // Try to match process number in text
                 const targetRow = rows.find(r => r.innerText.includes(procNum));
                 if (targetRow) {
                     const event = new MouseEvent('dblclick', {
                        'view': window,
                        'bubbles': true,
                        'cancelable': true
                     });
                     targetRow.dispatchEvent(event);
                     return true;
                 }
                 return false;
            }, target.procNum);

            if (!clicked) continue;

            await new Promise(r => setTimeout(r, 4000));

            // 1. Objeto Tab
            await clickTab(page, 'Objeto');
            await new Promise(r => setTimeout(r, 1000));
            const fullObjeto = await extractObjetoFull(page);
            if (fullObjeto) {
                await connection.query(
                    `UPDATE licitacoes SET objeto=? WHERE id=?`,
                    [fullObjeto, target.id]
                );
            }

            // 2. Informações Tab
            const infoTabClicked = await clickTab(page, 'Informações');
            if (infoTabClicked) {
                await new Promise(r => setTimeout(r, 2000));
                const infoData = await extractInformacoes(page);

                const updateData = [
                    infoData['Período de lançamento da proposta'] || infoData['Período de lançamento'] || null,
                    infoData['Modo de Disputa'] || null,
                    parseCurrency(infoData['Valor Previsto'] || '0'),
                    infoData['Registro de Preços'] === 'Sim' ? 1 : 0,
                    infoData['Obra'] === 'Sim' ? 1 : 0,
                    target.id
                ];

                await connection.query(
                    `UPDATE licitacoes SET periodo_lancamento=?, modo_disputa=?, valor_previsto=?, registro_precos=?, obra=? WHERE id=?`,
                    updateData
                );
            }

            // 3. Itens Tab
            const itemsTabClicked = await clickTab(page, 'Itens');
            if (itemsTabClicked) {
                await new Promise(r => setTimeout(r, 2000));
                const items = await extractItems(page, target.id);

                if (items.length > 0) {
                    newItemsCount += items.length;
                    const itemValues = items.map(i => [
                        i.licitacao_id, i.item, i.codigo, i.descricao, i.unidade, i.quantidade, i.valor_medio, i.valor_total, i.lote
                    ]);

                    await connection.query('DELETE FROM licitacao_itens WHERE licitacao_id = ?', [target.id]);
                    await connection.query(
                        `INSERT INTO licitacao_itens (licitacao_id, item, codigo, descricao, unidade, quantidade, valor_medio, valor_total, lote) VALUES ?`,
                        [itemValues]
                    );
                }
            }

            // Close (Voltar/Fechar)
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('.x-btn-inner'));
                const close = buttons.find(b => b.innerText.includes('Voltar') || b.innerText.includes('Fechar'));
                if (close) close.click();
            });
            await new Promise(r => setTimeout(r, 1500));
        }

        return { found: rows.length, newCount: newItemsCount, updatedCount: bidsToExplore.length };

    } catch (e) {
        throw e;
    }
}

// --- Worker Entry ---

(async () => {
  const connection = await mysql.createConnection(dbConfig);
  const browser = await puppeteer.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  for (const city of cities) {
    const t0 = Date.now();
    try {
      const stats = await processCity(connection, page, city);
      parentPort.postMessage({
        type: 'city_done',
        city: { CD_IBGE: city.CD_IBGE, DS_LABEL: city.DS_LABEL },
        counts: stats,
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

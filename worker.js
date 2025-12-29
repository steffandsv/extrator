/* eslint-disable no-console */
const { workerData, parentPort } = require('worker_threads');
const puppeteer = require('puppeteer');
const mysql = require('mysql2/promise');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

const { db: dbConfig, headless, workerId, cities, force } = workerData;

// --- Helper Functions ---

function convertDateTime(dateTimeStr) {
  if (!dateTimeStr) return null;
  // Try parsing strictly with DD/MM/YYYY HH:mm
  const d = dayjs(dateTimeStr, 'DD/MM/YYYY HH:mm', true);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm:00') : null;
}

function parseCurrency(val) {
    if (typeof val !== 'string') return 0;
    let s = val.replace('R$', '').trim();
    s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

async function clickTab(page, tabName) {
    return page.evaluate((name) => {
        const tabs = Array.from(document.querySelectorAll('.x-tab-inner'));
        const target = tabs.find(t => t.innerText.trim().includes(name));
        if (target) {
            target.click();
            return true;
        }
        return false;
    }, tabName);
}

async function extractInformacoes(page) {
    return page.evaluate(() => {
        const info = {};
        const labels = Array.from(document.querySelectorAll('label.x-form-item-label'));
        labels.forEach(label => {
            if (!label.offsetParent) return;
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

async function extractItems(page, licitacaoId) {
    const items = [];
    try {
        await new Promise(r => setTimeout(r, 2000));
        const rows = await page.$$('.x-window .x-grid-row');
        const fallbackRows = rows.length ? rows : await page.$$('.x-tabpanel-child[aria-hidden=false] .x-grid-row');
        const targetRows = fallbackRows.length > 0 ? fallbackRows : await page.$$('.x-grid-row');

        for (const row of targetRows) {
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

            // Map columns (standard layout):
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
 * Scrape the main grid from DOM with dynamic column detection.
 */
async function scrapeMainGrid(page) {
    // Wait for rows (at least one)
    try {
        await page.waitForSelector('.x-grid-row', { timeout: 30000 });
    } catch(e) {
        return [];
    }

    const rows = await page.$$('.x-grid-row');
    const scrapedData = [];

    for (const row of rows) {
        const texts = await row.evaluate(el => {
            const cells = Array.from(el.querySelectorAll('.x-grid-cell'));
            return cells.map(c => c.innerText.trim());
        });

        // Filter out empty/grouping rows (usually just 1-2 cells)
        if (texts.length < 5) continue;

        // Dynamic Column Mapping Logic
        // Find Date: Regex matches DD/MM/YYYY HH:mm
        const dateIndex = texts.findIndex(t => /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}/.test(t));

        let processoIndex = -1;
        let orgaoIndex = -1;
        let objetoIndex = -1;
        let statusIndex = -1;
        let modalidadeIndex = -1;

        if (dateIndex !== -1) {
             // Standard Jaborandi/Botucatu layout relative to Date
             // Jaborandi: [3]Processo [4]Orgao [5]Status [6]Date [7]Objeto ... [9]Modalidade
             // Date is at 6.
             // Processo is Date - 3
             // Orgao is Date - 2
             // Status is Date - 1
             // Objeto is Date + 1
             // Modalidade is Date + 3

             processoIndex = dateIndex - 3;
             orgaoIndex = dateIndex - 2;
             statusIndex = dateIndex - 1;
             objetoIndex = dateIndex + 1;
             modalidadeIndex = dateIndex + 3; // or search for text "PREGÃO", "CONCORRÊNCIA"

             // Fallback for Modalidade if index out of bounds or empty
             if (!texts[modalidadeIndex]) {
                 modalidadeIndex = texts.findIndex(t =>
                    t.toUpperCase().includes('PREGÃO') ||
                    t.toUpperCase().includes('CONCORRÊNCIA') ||
                    t.toUpperCase().includes('DISPENSA')
                 );
             }
        } else {
             // Fallback: try to find by content
             processoIndex = texts.findIndex(t => /^\d+\/\d+$/.test(t) || /^\d{6}\/\d{2}$/.test(t));
             if (processoIndex === -1) processoIndex = 3; // Default
        }

        const bid = {
            processo: texts[processoIndex],
            orgao: texts[orgaoIndex],
            status: texts[statusIndex],
            dataStr: texts[dateIndex],
            objeto: texts[objetoIndex],
            modalidade: texts[modalidadeIndex],
            element: row,
            fullText: texts.join(' ')
        };

        // Final sanity check
        if (bid.processo && bid.dataStr) {
             scrapedData.push(bid);
        }
    }
    return scrapedData;
}


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

        // Wait for data load
        await new Promise(r => setTimeout(r, 5000));

        const rows = await scrapeMainGrid(page);

        const now = dayjs();
        const bidsToExplore = [];
        const basicValues = [];

        for (const bid of rows) {
            const id = `${bid.orgao}-${bid.processo}`;
            const dataFinal = convertDateTime(bid.dataStr);

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
                bidsToExplore.push({ id, element: bid.element });
            }

            basicValues.push([
                id, city.CD_IBGE, bid.processo, bid.orgao, bid.status, dataFinal, bid.objeto, bid.modalidade
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

        let newItemsCount = 0;

        for (const target of bidsToExplore) {
            let handle = target.element;
            const isConnected = await handle.evaluate(el => el.isConnected);

            if (!isConnected) {
                 const freshRows = await page.$$('.x-grid-row');
                 for (const r of freshRows) {
                     const txt = await r.evaluate(el => el.innerText);
                     if (txt.includes(target.id.split('-')[1])) { // Match process number part
                         handle = r;
                         break;
                     }
                 }
            }

            if (handle) {
                try {
                    await handle.click({ count: 2 });
                } catch (clickErr) {
                    continue;
                }

                await new Promise(r => setTimeout(r, 4000));

                // 1. Objeto
                await clickTab(page, 'Objeto');
                await new Promise(r => setTimeout(r, 1000));
                const fullObjeto = await extractObjetoFull(page);
                if (fullObjeto) {
                    await connection.query(
                        `UPDATE licitacoes SET objeto=? WHERE id=?`,
                        [fullObjeto, target.id]
                    );
                }

                // 2. Informações
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

                // 3. Itens
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

                // Close
                await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('.x-btn-inner'));
                    const close = buttons.find(b => b.innerText.includes('Voltar') || b.innerText.includes('Fechar'));
                    if (close) close.click();
                });
                await new Promise(r => setTimeout(r, 1500));
            }
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

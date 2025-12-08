#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const mysql = require('mysql2/promise');
const blessed = require('blessed');
const contrib = require('blessed-contrib');
const chalk = require('chalk'); // usando chalk v4

// ---------- CONFIG ----------
const DB = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() === 'true';

// Dimensionamento padrão
const CPU_THREADS = os.cpus().length || 8;
const DEFAULT_WORKERS = Math.min(
  Math.max(4, Math.floor(CPU_THREADS / 2)),
  16
);
const WORKERS = Number(process.env.WORKERS || DEFAULT_WORKERS);

// Flag pra evitar rodar múltiplas ações em paralelo
let isRunning = false;

// ---------- UI ----------
const screen = blessed.screen({
  smartCSR: true,
  fullUnicode: true,
  dockBorders: true,
});
screen.title = 'FIOMB // EXTRATOR — Painel Hacker';

const grid = new contrib.grid({ rows: 12, cols: 12, screen });

const header = grid.set(0, 0, 2, 12, blessed.box, {
  tags: true,
  style: { fg: 'green', bg: 'black' },
  content:
    chalk.green(
      require('figlet').textSync('FIOMB EXTRATOR', { font: 'ANSI Shadow' })
    ) +
    '\n{green-fg}Node + Puppeteer + MySQL  //  Multiworker  //  TUI{/green-fg}',
});

const menu = grid.set(2, 0, 4, 5, blessed.list, {
  label: ' {bold}MENU{/bold} ',
  tags: true,
  width: '100%',
  keys: true,
  mouse: true,
  vi: true,
  style: {
    bg: 'black',
    item: { fg: 'green', bg: 'black' },
    selected: { fg: 'black', bg: 'green' },
    border: { fg: 'green' },
    label: { fg: 'green' },
  },
  items: [
    '1) Atualizar TODAS as licitações',
    '2) Atualizar licitações com cláusula WHERE',
    '3) Consultar última atualização',
    '4) Estatísticas',
  ],
});

const logBox = grid.set(6, 0, 6, 7, blessed.log, {
  label: ' {bold}LOG{/bold} ',
  tags: true,
  mouse: true,
  keys: true,
  vi: true,
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { ch: ' ', inverse: true },
  style: {
    fg: 'green',
    bg: 'black',
    border: { fg: 'green' },
    label: { fg: 'green' },
  },
});

const kpis = grid.set(2, 5, 2, 7, contrib.gauge, {
  label: ' {bold}Progresso{/bold} ',
  tags: true,
  stroke: 'green',
  fill: 'black',
});

const summaryTable = grid.set(4, 5, 2, 7, contrib.table, {
  label: ' {bold}Resumo{/bold} ',
  tags: true,
  keys: false,
  fg: 'green',
  columnWidth: [28, 12],
  columnSpacing: 3,
});

const barRanking = grid.set(6, 7, 6, 5, contrib.bar, {
  label: ' {bold}Top “Novas” por Município (sessão){/bold} ',
  tags: true,
  barWidth: 6,
  barSpacing: 3,
  xOffset: 2,
  stack: false,
  maxHeight: 20,
  style: { fg: 'green', barFgColor: 'green' },
});

const help = grid.set(10, 0, 2, 12, blessed.box, {
  tags: true,
  content:
    '{bold}{green-fg}↑/↓{/green-fg}{/bold} navegar  ' +
    '{bold}{green-fg}ENTER{/green-fg}{/bold} selecionar  ' +
    '{bold}{green-fg}1–4{/green-fg}{/bold} atalho direto  ·  ' +
    '{bold}{green-fg}Q{/green-fg}{/bold} sair  ·  ' +
    `{bold}{green-fg}Workers:{/green-fg}{/bold} ${WORKERS}  ·  ` +
    `{bold}{green-fg}Headless:{/green-fg}{/bold} ${HEADLESS}`,
  style: { fg: 'green', bg: 'black' },
});

// Render inicial
screen.render();
menu.focus();

// ---------- UTILS ----------
function formatSummary(stats) {
  return [
    ['Cidades processadas', String(stats.citiesProcessed || 0)],
    ['Novas licitações (sessão)', String(stats.totalNew || 0)],
    ['Atualizações (sessão)', String(stats.totalUpdated || 0)],
    ['Cidades com erros', String(stats.errorCities.size || 0)],
    ['Cidades sem novidades', String(stats.zeroCities.size || 0)],
    ['Duração (mm:ss)', stats.elapsed || '—'],
  ];
}

function sanitizeWhereClause(raw) {
  if (!raw || !raw.trim()) return '';
  let clause = raw.trim();

  clause = clause.replace(/\bmunicipios\./gi, 'municipios.');

  clause = clause.replace(
    /\bsg_uf\s*=\s*([a-z]{2})\b/gi,
    (_, uf) => `SG_UF = '${uf.toUpperCase()}'`
  );

  clause = clause
    .replace(/\bis not null\b/gi, 'IS NOT NULL')
    .replace(/\bis null\b/gi, 'IS NULL');

  return clause;
}

async function fetchMunicipalities(connection, whereClause) {
  const base =
    "SELECT CD_IBGE, DS_LABEL, DS_DOMAIN FROM municipios WHERE DS_DOMAIN IS NOT NULL AND DS_DOMAIN != ''";
  const clause = sanitizeWhereClause(whereClause);
  const sql = clause ? `${base} AND ${clause}` : base;
  const [rows] = await connection.query(sql);
  return rows;
}

function chunkArray(arr, chunks) {
  const out = [];
  const size = Math.ceil(arr.length / chunks);
  for (let i = 0; i < chunks; i++) {
    out.push(arr.slice(i * size, (i + 1) * size));
  }
  return out;
}

function msToMinSec(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ---------- WORKER ORCHESTRATION ----------
async function runUpdateFlow(whereClauseLabel, whereClause) {
  const start = Date.now();
  const connection = await mysql.createConnection(DB);

  const allCities = await fetchMunicipalities(connection, whereClause);
  await connection.end();

  if (allCities.length === 0) {
    logBox.log(chalk.yellow('Nenhum município encontrado com os filtros.'));
    return;
  }

  logBox.log(
    chalk.green(
      `Fila carregada: ${allCities.length} municípios (${whereClauseLabel}).`
    )
  );

  const workersCount = Math.min(WORKERS, allCities.length);
  const chunks = chunkArray(allCities, workersCount);

  const stats = {
    totalCities: allCities.length,
    citiesProcessed: 0,
    totalNew: 0,
    totalUpdated: 0,
    errorCities: new Map(),
    zeroCities: new Set(),
    topNew: new Map(),
  };

  kpis.setData([0]);
  summaryTable.setData({
    headers: ['Métrica', 'Valor'],
    data: formatSummary(stats),
  });
  barRanking.setData({ titles: [], data: [] });
  screen.render();

  let finishedWorkers = 0;

  await new Promise((resolve) => {
    chunks.forEach((citiesChunk, idx) => {
      const worker = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: {
          db: DB,
          headless: HEADLESS,
          workerId: idx + 1,
          cities: citiesChunk,
        },
      });

      worker.on('message', (msg) => {
        if (msg.type === 'city_done') {
          const { city, counts, tookMs } = msg;
          stats.citiesProcessed += 1;
          stats.totalNew += counts.newCount;
          stats.totalUpdated += counts.updatedCount;

          if (counts.found === 0) stats.zeroCities.add(city.DS_LABEL);
          if (counts.error)
            stats.errorCities.set(city.DS_LABEL, counts.error);

          if (counts.newCount > 0) {
            const prev = stats.topNew.get(city.DS_LABEL) || 0;
            stats.topNew.set(city.DS_LABEL, prev + counts.newCount);
          }

          const base = `${chalk.bold(
            city.DS_LABEL
          )} — encontrados:${counts.found}  novas:${chalk.bold.green(
            counts.newCount
          )}  atualizadas:${counts.updatedCount}  ${
            tookMs ? `(${msToMinSec(tookMs)})` : ''
          }`;

          if (counts.error) {
            logBox.log(chalk.red(`✖ ${base}  ERRO: ${counts.error}`));
          } else if (counts.found === 0) {
            logBox.log(chalk.yellow(`• ${base}  (sem novidades)`));
          } else {
            logBox.log(chalk.green(`✔ ${base}`));
          }

          const progressPct = Math.round(
            (stats.citiesProcessed / stats.totalCities) * 100
          );
          kpis.setData([progressPct]);
          summaryTable.setData({
            headers: ['Métrica', 'Valor'],
            data: formatSummary({
              ...stats,
              elapsed: msToMinSec(Date.now() - start),
            }),
          });

          const top = [...stats.topNew.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
          barRanking.setData({
            titles: top.map(([name]) => name.slice(0, 10)),
            data: top.map(([, v]) => v),
          });

          screen.render();
        }

        if (msg.type === 'log') {
          logBox.log(msg.payload);
          screen.render();
        }

        if (msg.type === 'done') {
          finishedWorkers += 1;
          if (finishedWorkers === chunks.length) resolve();
        }
      });

      worker.on('error', (err) => {
        finishedWorkers += 1;
        logBox.log(chalk.red(`Worker ${idx + 1} falhou: ${err.message}`));
        if (finishedWorkers === chunks.length) resolve();
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          logBox.log(
            chalk.red(`Worker ${idx + 1} saiu com código ${code}.`)
          );
        }
      });
    });
  });

  logBox.log(chalk.bold.green('\n—— RESUMO FINAL ——'));
  logBox.log(
    `Cidades processadas: ${stats.citiesProcessed}/${stats.totalCities}`
  );
  logBox.log(`Novas licitações (sessão): ${stats.totalNew}`);
  logBox.log(`Atualizadas (sessão): ${stats.totalUpdated}`);
  logBox.log(`Cidades com erro: ${stats.errorCities.size}`);
  if (stats.errorCities.size) {
    for (const [city, err] of stats.errorCities.entries()) {
      logBox.log(chalk.red(`  - ${city}: ${err}`));
    }
  }
  logBox.log(`Cidades sem novidades: ${stats.zeroCities.size}`);
  if (stats.zeroCities.size) {
    const names = [...stats.zeroCities].slice(0, 40);
    logBox.log(
      chalk.yellow(
        `  - ${names.join(', ')}${
          stats.zeroCities.size > names.length ? '…' : ''
        }`
      )
    );
  }

  summaryTable.setData({
    headers: ['Métrica', 'Valor'],
    data: formatSummary({
      ...stats,
      elapsed: msToMinSec(Date.now() - start),
    }),
  });
  screen.render();
}

// ---------- ACTIONS ----------
async function actionAll() {
  await runUpdateFlow('TODAS as cidades', '');
}

async function actionWhere() {
  const prompt = blessed.prompt({
    parent: screen,
    border: 'line',
    width: '80%',
    height: 'shrink',
    label: ' {bold}Cláusula WHERE{/bold} ',
    tags: true,
    keys: true,
    vi: true,
    style: {
      fg: 'green',
      bg: 'black',
      border: { fg: 'green' },
      label: { fg: 'green' },
    },
  });

  prompt.input(
    'Ex.: municipios.sg_uf = sp AND DS_LABEL IS NOT NULL\n\nDigite sua WHERE (sem "WHERE"):\n',
    '',
    async (_err, value) => {
      screen.remove(prompt);
      screen.render();
      const clause = value || '';
      await runUpdateFlow(`WHERE: ${clause}`, clause);
    }
  );
}

async function actionLastUpdate() {
  try {
    const conn = await mysql.createConnection(DB);
    const [lastRows] = await conn.query(
      `SELECT DATE(MAX(COALESCE(updated_at, created_at))) AS last_date FROM licitacoes`
    );
    const lastDate = lastRows[0]?.last_date;
    if (!lastDate) {
      logBox.log(chalk.yellow('Não há dados em licitacoes.'));
      await conn.end();
      return;
    }
    const [rows] = await conn.query(
      `SELECT l.cd_ibge, m.DS_LABEL, COUNT(*) AS qtd
       FROM licitacoes l
       JOIN municipios m ON m.CD_IBGE = l.cd_ibge
       WHERE DATE(COALESCE(l.updated_at, l.created_at)) = ?
       GROUP BY l.cd_ibge, m.DS_LABEL
       ORDER BY qtd DESC`,
      [lastDate]
    );
    await conn.end();

    const modal = blessed.box({
      parent: screen,
      border: 'line',
      width: '95%',
      height: '80%',
      label: ` {bold}Última atualização em ${lastDate}{/bold} `,
      tags: true,
      scrollable: true,
      keys: true,
      mouse: true,
      vi: true,
      style: {
        fg: 'green',
        bg: 'black',
        border: { fg: 'green' },
      },
      content:
        rows
          .map((r) => `- ${r.DS_LABEL}: ${r.qtd} licitações`)
          .join('\n') || '—',
    });
    modal.focus();
    screen.render();
    modal.key(['escape', 'q', 'enter'], () => {
      screen.remove(modal);
      screen.render();
    });
  } catch (e) {
    logBox.log(
      chalk.red(`Erro na consulta de última atualização: ${e.message}`)
    );
  }
}

async function actionStats() {
  try {
    const conn = await mysql.createConnection(DB);

    const [topRows] = await conn.query(
      `SELECT m.DS_LABEL, COUNT(*) AS novas
       FROM licitacoes l
       JOIN municipios m ON m.CD_IBGE = l.cd_ibge
       WHERE l.created_at >= NOW() - INTERVAL 30 DAY
       GROUP BY m.DS_LABEL
       ORDER BY novas DESC
       LIMIT 30`
    );

    const [idleRows] = await conn.query(
      `SELECT m.DS_LABEL, DATEDIFF(NOW(), MAX(COALESCE(l.updated_at, l.created_at))) AS dias_parado
       FROM licitacoes l
       JOIN municipios m ON m.CD_IBGE = l.cd_ibge
       GROUP BY m.DS_LABEL
       ORDER BY dias_parado DESC
       LIMIT 30`
    );

    const [modRows] = await conn.query(
      `SELECT COALESCE(l.modalidade,'(sem modalidade)') AS modalidade, COUNT(*) AS qtd
       FROM licitacoes l
       WHERE l.created_at >= NOW() - INTERVAL 30 DAY
       GROUP BY modalidade
       ORDER BY qtd DESC
       LIMIT 15`
    );

    await conn.end();

    const modal = blessed.box({
      parent: screen,
      border: 'line',
      width: '95%',
      height: '90%',
      label: ' {bold}Estatísticas{/bold} ',
      tags: true,
      scrollable: true,
      keys: true,
      mouse: true,
      vi: true,
      style: {
        fg: 'green',
        bg: 'black',
        border: { fg: 'green' },
      },
    });

    const txt = [
      chalk.bold('TOP MUNICÍPIOS – novas (30 dias)'),
      ...topRows.map((r) => `  - ${r.DS_LABEL}: ${r.novas}`),
      '',
      chalk.bold('MAIS TEMPO SEM NOVIDADE'),
      ...idleRows.map((r) => `  - ${r.DS_LABEL}: ${r.dias_parado} dias`),
      '',
      chalk.bold('TOP MODALIDADES (30 dias)'),
      ...modRows.map((r) => `  - ${r.modalidade}: ${r.qtd}`),
    ].join('\n');

    modal.setContent(txt || '—');
    modal.focus();
    screen.render();
    modal.key(['escape', 'q', 'enter'], () => {
      screen.remove(modal);
      screen.render();
    });
  } catch (e) {
    logBox.log(chalk.red(`Erro nas estatísticas: ${e.message}`));
  }
}

// ---------- MENU / TECLAS ----------
async function handleMenuSelection(idx) {
  if (idx < 0 || idx > 3) return;

  if (isRunning) {
    logBox.log(
      chalk.yellow(
        'Já existe uma ação em andamento. Aguarde ela finalizar antes de iniciar outra.'
      )
    );
    return;
  }

  isRunning = true;
  try {
    if (idx === 0) await actionAll();
    else if (idx === 1) await actionWhere();
    else if (idx === 2) await actionLastUpdate();
    else if (idx === 3) await actionStats();
  } finally {
    isRunning = false;
  }
}

menu.on('select', async (_el, idx) => {
  await handleMenuSelection(idx);
});

// Atalhos 1/2/3/4 em qualquer lugar da tela
screen.key(['1', '2', '3', '4'], async (ch) => {
  const idx = Number(ch) - 1;
  menu.select(idx);
  screen.render();
  await handleMenuSelection(idx);
});

screen.key(['q', 'C-c', 'escape'], () => process.exit(0));

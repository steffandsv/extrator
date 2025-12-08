/* core.js */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const mysql = require('mysql2/promise');
const EventEmitter = require('events');
const dayjs = require('dayjs');

// ---------- Utils compartilhados ----------
function sanitizeWhereClause(raw) {
  if (!raw || !raw.trim()) return '';
  let clause = raw.trim();
  clause = clause.replace(/\bmunicipios\./gi, 'municipios.');
  clause = clause.replace(/\bsg_uf\s*=\s*([a-z]{2})\b/gi, (_, uf) => `SG_UF = '${uf.toUpperCase()}'`);
  clause = clause.replace(/\bis not null\b/gi, 'IS NOT NULL').replace(/\bis null\b/gi, 'IS NULL');
  return clause;
}
async function fetchMunicipalities(connection, whereClause) {
  const base = "SELECT CD_IBGE, DS_LABEL, DS_DOMAIN FROM municipios WHERE DS_DOMAIN IS NOT NULL AND DS_DOMAIN != ''";
  const clause = sanitizeWhereClause(whereClause);
  const sql = clause ? `${base} AND ${clause}` : base;
  const [rows] = await connection.query(sql);
  return rows;
}
function chunkArray(arr, chunks) {
  const out = [];
  const size = Math.ceil(arr.length / chunks);
  for (let i = 0; i < chunks; i++) out.push(arr.slice(i * size, (i + 1) * size));
  return out;
}
function msToMinSec(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ---------- Sessão de Execução ----------
class RunSession extends EventEmitter {
  constructor({ db, headless = true, workers = Math.max(4, Math.floor((os.cpus().length || 8) / 2)), whereClause = '', label = '' }) {
    super();
    this.db = db;
    this.headless = headless;
    this.workers = workers;
    this.whereClause = whereClause || '';
    this.label = label || (whereClause ? `WHERE: ${whereClause}` : 'TODAS as cidades');

    this.id = `sess-${dayjs().format('YYYYMMDD-HHmmss')}-${Math.random().toString(36).slice(2, 6)}`;
    this.startedAt = new Date();
    this.finishedAt = null;

    this.logsDir = path.join(__dirname, 'logs');
    fs.mkdirSync(this.logsDir, { recursive: true });
    this.logFile = path.join(this.logsDir, `${this.id}.ndjson`);
    this.summaryFile = path.join(this.logsDir, `${this.id}-summary.json`);
    this._logStream = fs.createWriteStream(this.logFile, { flags: 'a' });

    this.stats = {
      totalCities: 0,
      citiesProcessed: 0,
      totalNew: 0,
      totalUpdated: 0,
      errorCities: new Map(),
      zeroCities: new Set(),
      topNew: new Map(),
    };
  }

  _writeLog(obj) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
    this._logStream.write(line);
    this.emit('log', line); // para o WebSocket
  }

  async start() {
    this.emit('status', 'running');
    this._writeLog({ level: 'info', msg: `Iniciando ${this.label}`, sessionId: this.id });

    const startMs = Date.now();
    const connection = await mysql.createConnection(this.db);

    const allCities = await fetchMunicipalities(connection, this.whereClause);
    await connection.end();

    if (allCities.length === 0) {
      this._writeLog({ level: 'warn', msg: 'Nenhum município encontrado com os filtros.' });
      this.emit('summary', { ok: true, empty: true });
      this._finalize(startMs);
      return;
    }

    this.stats.totalCities = allCities.length;
    this._writeLog({ level: 'info', msg: `Fila carregada: ${allCities.length} municípios (${this.label}).` });

    const workersCount = Math.min(this.workers, allCities.length);
    const chunks = chunkArray(allCities, workersCount);
    let finishedWorkers = 0;

    await new Promise((resolve) => {
      chunks.forEach((citiesChunk, idx) => {
        const worker = new Worker(path.join(__dirname, 'worker.js'), {
          workerData: {
            db: this.db,
            headless: this.headless,
            workerId: idx + 1,
            cities: citiesChunk,
          },
        });

        worker.on('message', (msg) => {
          if (msg.type === 'city_done') {
            const { city, counts, tookMs } = msg;
            this.stats.citiesProcessed += 1;
            this.stats.totalNew += counts.newCount;
            this.stats.totalUpdated += counts.updatedCount;

            if (counts.found === 0) this.stats.zeroCities.add(city.DS_LABEL);
            if (counts.error) this.stats.errorCities.set(city.DS_LABEL, counts.error);
            if (counts.newCount > 0) {
              const prev = this.stats.topNew.get(city.DS_LABEL) || 0;
              this.stats.topNew.set(city.DS_LABEL, prev + counts.newCount);
            }

            // Log estruturado
            this._writeLog({
              level: counts.error ? 'error' : 'info',
              msg: 'city_done',
              city: city.DS_LABEL,
              found: counts.found,
              newCount: counts.newCount,
              updatedCount: counts.updatedCount,
              took: tookMs,
            });

            // Progresso
            const pct = Math.round((this.stats.citiesProcessed / this.stats.totalCities) * 100);
            this.emit('progress', {
              pct,
              citiesProcessed: this.stats.citiesProcessed,
              totalCities: this.stats.totalCities,
              totalNew: this.stats.totalNew,
              totalUpdated: this.stats.totalUpdated,
            });
          }

          if (msg.type === 'log') {
            this._writeLog({ level: 'info', msg: msg.payload });
          }

          if (msg.type === 'done') {
            finishedWorkers += 1;
            if (finishedWorkers === chunks.length) resolve();
          }
        });

        worker.on('error', (err) => {
          finishedWorkers += 1;
          this._writeLog({ level: 'error', msg: `Worker ${idx + 1} falhou`, error: err.message });
          if (finishedWorkers === chunks.length) resolve();
        });

        worker.on('exit', (code) => {
          if (code !== 0) {
            this._writeLog({ level: 'error', msg: `Worker ${idx + 1} saiu com código ${code}` });
          }
        });
      });
    });

    // Resumo final
    const summary = {
      sessionId: this.id,
      label: this.label,
      startedAt: this.startedAt,
      finishedAt: new Date(),
      duration: msToMinSec(Date.now() - startMs),
      totalCities: this.stats.totalCities,
      citiesProcessed: this.stats.citiesProcessed,
      totalNew: this.stats.totalNew,
      totalUpdated: this.stats.totalUpdated,
      errorCities: [...this.stats.errorCities.entries()].map(([city, err]) => ({ city, err })),
      zeroCities: [...this.stats.zeroCities],
      topNew: [...this.stats.topNew.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([city, count]) => ({ city, count })),
      logFile: path.basename(this.logFile),
      summaryFile: path.basename(this.summaryFile),
    };

    fs.writeFileSync(this.summaryFile, JSON.stringify(summary, null, 2));
    this.emit('summary', summary);
    this._finalize(startMs);
  }

  _finalize(startMs) {
    this.finishedAt = new Date();
    this._writeLog({ level: 'info', msg: `Finalizado em ${msToMinSec(Date.now() - startMs)}` });
    this._logStream.end();
    this.emit('status', 'done');
  }

  get logFiles() {
    return { log: this.logFile, summary: this.summaryFile };
  }
}

// ---------- Consultas rápidas para “Última atualização” e “Estatísticas” ----------
async function getLastUpdateSummary(db) {
  const conn = await mysql.createConnection(db);
  const [lastRows] = await conn.query(`SELECT DATE(MAX(COALESCE(updated_at, created_at))) AS last_date FROM licitacoes`);
  const lastDate = lastRows[0]?.last_date || null;
  let rows = [];
  if (lastDate) {
    [rows] = await conn.query(
      `SELECT l.cd_ibge, m.DS_LABEL, COUNT(*) AS qtd
       FROM licitacoes l
       JOIN municipios m ON m.CD_IBGE = l.cd_ibge
       WHERE DATE(COALESCE(l.updated_at, l.created_at)) = ?
       GROUP BY l.cd_ibge, m.DS_LABEL
       ORDER BY qtd DESC`, [lastDate]
    );
  }
  await conn.end();
  return { lastDate, rows };
}

async function getStats(db) {
  const conn = await mysql.createConnection(db);
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
  return { topRows, idleRows, modRows };
}

module.exports = {
  RunSession,
  createRunSession: (opts) => new RunSession(opts),
  getLastUpdateSummary,
  getStats,
};

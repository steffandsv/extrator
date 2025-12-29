/* server.js */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const archiver = require('archiver');
const { createRunSession, getLastUpdateSummary, getStats } = require('./core');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() === 'true';
const WORKERS = Number(process.env.WORKERS || 12);
const AUTH_TOKEN = null; // auth desativado

// Sessões recentes em memória
const sessions = new Map();

function auth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const provided = req.headers['x-auth-token'] || req.query.token;
  if (provided === AUTH_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/api/sessions', auth, (req, res) => {
  const list = [...sessions.values()].map(s => ({
    id: s.id,
    label: s.label,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    status: s.finishedAt ? 'done' : 'running',
  }));
  res.json(list);
});

app.post('/api/run', auth, async (req, res) => {
  const { type, where, force } = req.body || {};
  if (!['all', 'where'].includes(type)) return res.status(400).json({ error: 'type must be all|where' });

  const whereClause = type === 'all' ? '' : (where || '');
  const label = type === 'all' ? 'TODAS as cidades' : `WHERE: ${whereClause}`;

  const session = createRunSession({
    db: DB, headless: HEADLESS, workers: WORKERS,
    whereClause, label, force: !!force
  });

  sessions.set(session.id, session);

  // Conecção com Socket.IO
  session.on('log', (line) => io.emit('session:log', { sessionId: session.id, line }));
  session.on('progress', (p) => io.emit('session:progress', { sessionId: session.id, ...p }));
  session.on('summary', (summary) => io.emit('session:summary', { sessionId: session.id, summary }));
  session.on('status', (status) => io.emit('session:status', { sessionId: session.id, status }));

  session.start(); // não aguardamos aqui
  res.json({ sessionId: session.id, label });
});

app.get('/api/last-update', auth, async (_req, res) => {
  const data = await getLastUpdateSummary(DB);
  res.json(data);
});

app.get('/api/stats', auth, async (_req, res) => {
  const data = await getStats(DB);
  res.json(data);
});

// Download de logs / resumo
app.get('/api/sessions/:id/logs', auth, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  res.download(s.logFiles.log);
});

app.get('/api/sessions/:id/summary', auth, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  res.download(s.logFiles.summary);
});

app.get('/api/sessions/:id/zip', auth, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename=${s.id}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  archive.file(s.logFiles.log, { name: path.basename(s.logFiles.log) });
  archive.file(s.logFiles.summary, { name: path.basename(s.logFiles.summary) });
  archive.finalize();
});

io.on('connection', (socket) => {
  // envia sessões já existentes quando o cliente conecta
  const list = [...sessions.values()].map(s => ({
    id: s.id, label: s.label,
    startedAt: s.startedAt, finishedAt: s.finishedAt,
    status: s.finishedAt ? 'done' : 'running',
  }));
  socket.emit('sessions:list', list);
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log(`Web UI em http://localhost:${PORT}  (token: ${AUTH_TOKEN ? 'habilitado' : 'desligado'})`);
});

/* global io */
const $ = (sel) => document.querySelector(sel);

const api = async (url, opts = {}) => {
  const token = $('#tokenInput').value.trim();
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (token) headers['X-Auth-Token'] = token;
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
};

let currentSessionId = null;

// mapas de estatísticas por cidade (sessão atual)
let topNewMap = new Map();
let topFoundMap = new Map();
let errorCities = [];
let zeroCities = [];

// ------- UI helpers -------
function appendPrettyLog(line) {
  const container = $('#logs');
  let text = line.trim();
  let cls = '';

  try {
    const obj = JSON.parse(line);
    const ts = obj.ts ? new Date(obj.ts).toLocaleTimeString() : new Date().toLocaleTimeString();
    const level = obj.level || 'info';

    if (obj.msg === 'city_done' && obj.city) {
      const found = obj.found ?? 0;
      const news = obj.newCount ?? 0;
      const upd = obj.updatedCount ?? 0;
      const tookSec = obj.took ? (obj.took / 1000).toFixed(1) : null;

      let icon = '✔';
      if (level === 'error' || obj.error) { icon = '✖'; cls = 'error'; }
      else if (found === 0) { icon = '•'; cls = 'warn'; }

      text = `[${ts}] ${icon} ${obj.city} — encontrados: ${found} | novas: ${news} | atualizadas: ${upd}` +
             (tookSec ? ` (${tookSec}s)` : '');
      
      // atualiza mapas de ranking
      const prevNew = topNewMap.get(obj.city) || 0;
      topNewMap.set(obj.city, prevNew + news);
      const prevFound = topFoundMap.get(obj.city) || 0;
      topFoundMap.set(obj.city, prevFound + found);
      renderTopLists();
    } else {
      text = `[${ts}] ${level}: ${obj.msg}`;
      if (level === 'error') cls = 'error';
      if (level === 'warn') cls = 'warn';
    }
  } catch (e) {
    // se não for JSON, mantém texto cru
  }

  const div = document.createElement('div');
  div.className = `log-line${cls ? ' ' + cls : ''}`;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function setProgress(pct, cities, total, news, upds) {
  $('#progressBar').style.width = `${pct}%`;
  $('#kCities').innerText = total ? `${cities}/${total}` : cities;
  $('#kNew').innerText = news;
  $('#kUpd').innerText = upds;
}

function renderTopLists() {
  const newTop = [...topNewMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const foundTop = [...topFoundMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  $('#topNewList').innerHTML = newTop
    .map(([city, count]) => `<li>${city} <small>+${count}</small></li>`).join('');

  $('#topFoundList').innerHTML = foundTop
    .map(([city, count]) => `<li>${city} <small>${count}</small></li>`).join('');
}

function renderErrors() {
  $('#errList').innerHTML = errorCities
    .map(e => `<li>⚠ ${e.city}: <em>${e.err}</em></li>`).join('');
}

function renderZero() {
  $('#zeroList').innerHTML = zeroCities
    .map(c => `<li>• ${c}</li>`).join('');
}

function clearSessionUI() {
  $('#logs').innerHTML = '';
  $('#summaryBox').textContent = '';
  $('#downloads').classList.add('hidden');
  setProgress(0, 0, 0, 0, 0);

  topNewMap = new Map();
  topFoundMap = new Map();
  errorCities = [];
  zeroCities = [];
  renderTopLists();
  renderErrors();
  renderZero();
}

// ------- ações -------
async function startRun(type) {
  try {
    const where = type === 'where' ? $('#whereInput').value : '';
    const resp = await api('/api/run', {
      method: 'POST',
      body: JSON.stringify({ type, where }),
    });
    currentSessionId = resp.sessionId;
    clearSessionUI();
    appendPrettyLog(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: `Iniciada sessão ${resp.sessionId} — ${resp.label}` }));
  } catch (e) {
    appendPrettyLog(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: `Falha ao iniciar: ${e.message}` }));
  }
}

$('#btnAll').onclick = () => startRun('all');
$('#btnWhere').onclick = () => startRun('where');

$('#btnLast').onclick = async () => {
  try {
    const data = await api('/api/last-update');
    const body = data.lastDate
      ? [`Última data: ${data.lastDate}`, ...data.rows.map(r => `- ${r.DS_LABEL}: ${r.qtd}`)].join('\n')
      : 'Sem dados.';
    alert(body);
  } catch (e) {
    alert('Erro ao consultar última atualização: ' + e.message);
  }
};

$('#btnStats').onclick = async () => {
  try {
    const { topRows, idleRows, modRows } = await api('/api/stats');
    const txt = [
      'TOP MUNICÍPIOS – novas (30 dias)',
      ...topRows.map(r => `  - ${r.DS_LABEL}: ${r.novas}`),
      '',
      'MAIS TEMPO SEM NOVIDADE',
      ...idleRows.map(r => `  - ${r.DS_LABEL}: ${r.dias_parado} dias`),
      '',
      'TOP MODALIDADES (30 dias)',
      ...modRows.map(r => `  - ${r.modalidade}: ${r.qtd}`),
    ].join('\n');
    alert(txt);
  } catch (e) {
    alert('Erro ao consultar estatísticas: ' + e.message);
  }
};

// ------- WebSocket -------
const socket = io();

socket.on('sessions:list', (list) => {
  const tbody = $('#sessTable tbody');
  tbody.innerHTML = list.map(s => (
    `<tr>
      <td>${s.id}</td>
      <td>${s.label}</td>
      <td>${s.status}</td>
      <td>${new Date(s.startedAt).toLocaleString()}</td>
      <td>${s.finishedAt ? new Date(s.finishedAt).toLocaleString() : '—'}</td>
    </tr>`
  )).join('');
});

socket.on('session:log', ({ sessionId, line }) => {
  if (sessionId !== currentSessionId) return;
  appendPrettyLog(line);
});

socket.on('session:progress', ({ sessionId, pct, citiesProcessed, totalCities, totalNew, totalUpdated }) => {
  if (sessionId !== currentSessionId) return;
  setProgress(pct, citiesProcessed, totalCities, totalNew, totalUpdated);
});

socket.on('session:summary', ({ sessionId, summary }) => {
  if (sessionId !== currentSessionId) return;

  // erros e sem novidades vêm do summary
  errorCities = summary.errorCities || [];
  zeroCities = summary.zeroCities || [];
  renderErrors();
  renderZero();

  $('#summaryBox').textContent = [
    `Duração: ${summary.duration}`,
    `Cidades processadas: ${summary.citiesProcessed}/${summary.totalCities}`,
    `Novas: ${summary.totalNew}`,
    `Atualizadas: ${summary.totalUpdated}`,
  ].join('\n');

  // Links de download
  const token = $('#tokenInput').value.trim();
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  $('#dlLog').href = `/api/sessions/${sessionId}/logs${q}`;
  $('#dlSummary').href = `/api/sessions/${sessionId}/summary${q}`;
  $('#dlZip').href = `/api/sessions/${sessionId}/zip${q}`;
  $('#downloads').classList.remove('hidden');
});

socket.on('session:status', ({ sessionId, status }) => {
  if (sessionId !== currentSessionId) return;
  appendPrettyLog(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    msg: `status: ${status}`,
  }));
});

// ------- token persistente -------
$('#tokenInput').value = localStorage.getItem('authToken') || '';
$('#tokenInput').addEventListener('change', () => {
  localStorage.setItem('authToken', $('#tokenInput').value.trim());
});

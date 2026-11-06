'use strict';
/* Кино вдвоём: синхронный просмотр, передача файла и трансляция через WebRTC (PeerJS). */

const PREFIX = 'kino-vdvoem-v1-';
const CHUNK = 64 * 1024;           // размер сообщения в data channel
const READ_BLOCK = 2 * 1024 * 1024; // читаем файл блоками по 2 МБ
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  sget(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  sset(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} },
};

const S = {
  peer: null, isHost: false, code: null,
  name: store.get('name') || '',
  ctrl: null, file: null, partnerId: null, partnerName: 'Партнёр',
  mode: 'sync',
  local: { url: null, name: null, file: null, isUrl: false },
  rtt: 120,
  expect: { play: 0, pause: 0, seek: null },
  lastLocalAction: 0,
  partnerMedia: null,
  stream: { role: null, call: null, captured: null, remoteCall: null, statsTimer: null, stateTimer: null },
  call: { local: null, out: null, in: null },
  send: { active: false, cancel: false, file: null },
  recv: null,
  recvUrl: null,
  reconnectTimer: null, idRetries: 0, connectTimer: null,
  left: false,
};

const player = $('#player');
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>';
const face = $('#faceVideo');

/* ---------------- утилиты ---------------- */
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}
function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' ГБ';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' МБ';
  return Math.round(b / 1e3) + ' КБ';
}
function genCode() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  const r = crypto.getRandomValues(new Uint8Array(6));
  for (const x of r) s += a[x % a.length];
  return s;
}
function parseCode(v) {
  v = (v || '').trim();
  if (v.includes('#')) v = v.split('#').pop();
  return v.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function latency() { return Math.min(S.rtt, 2000) / 2000; } // в секундах (половина RTT)
function toast(html, ms = 4000) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = html;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function send(msg) { if (S.ctrl && S.ctrl.open) { try { S.ctrl.send(msg); } catch (e) { console.warn(e); } } }
function partnerOnline() { return !!(S.ctrl && S.ctrl.open); }

/* ---------------- настройки соединения ---------------- */
function loadSettings() {
  try { return JSON.parse(store.get('net') || '{}'); } catch { return {}; }
}
function iceServers() {
  const list = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ];
  const s = loadSettings();
  if (s.turnUrl) {
    list.push({ urls: s.turnUrl.split(',').map((x) => x.trim()).filter(Boolean), username: s.turnUser || '', credential: s.turnPass || '' });
  }
  return list;
}
function peerOptions() {
  const o = { config: { iceServers: iceServers() }, debug: 1 };
  const s = loadSettings();
  if (s.peerServer) {
    const host = s.peerServer.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const [h, p] = host.split(':');
    Object.assign(o, { host: h, port: p ? +p : 443, secure: !p || p === '443', path: '/' });
  }
  return o;
}

/* ---------------- статус ---------------- */
function setStatus(kind, text) {
  $('#topStatus').hidden = false;
  $('#statusDot').className = 'dot ' + (kind || '');
  $('#statusText').textContent = text;
}
function refreshStatus() {
  if (!S.peer || S.peer.disconnected) return setStatus('err', 'Нет связи с сервером, переподключаюсь…');
  if (partnerOnline()) return setStatus('ok', `${S.partnerName} в комнате`);
  setStatus('', S.isHost ? 'Ждём собеседника' : 'Подключаюсь к комнате…');
}

/* ---------------- комната ---------------- */
function startPeer(id) {
  setStatus('', 'Подключаюсь к серверу…');
  const p = new Peer(id, peerOptions());
  S.peer = p;
  p.on('open', () => {
    S.idRetries = 0;
    enterRoom();
    refreshStatus();
    if (!S.isHost && !partnerOnline()) connectToHost();
  });
  p.on('connection', (c) => (S.isHost ? acceptConn(c) : c.close()));
  p.on('call', onCall);
  p.on('disconnected', () => {
    refreshStatus();
    setTimeout(() => { if (!p.destroyed && p.disconnected && S.peer === p) p.reconnect(); }, 2000);
  });
  p.on('error', (err) => onPeerError(err, id, p));
}

function onPeerError(err, id, p) {
  const t = err.type;
  console.warn('peer error', t, err);
  if (t === 'unavailable-id' && S.isHost) {
    if (S.idRetries++ < 10) {
      setStatus('', 'Комната освобождается, секунду…');
      p.destroy();
      setTimeout(() => { if (!S.left) startPeer(id); }, 2500);
    } else {
      leaveRoom();
      showLobbyError('Этот код уже занят. Создай новую комнату.');
    }
    return;
  }
  if (t === 'peer-unavailable') { refreshStatus(); scheduleReconnect(); return; }
  if (t === 'browser-incompatible') { showLobbyError('Браузер не поддерживает WebRTC. Открой сайт в Chrome, Edge или Яндекс Браузере.'); return; }
  if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(t)) {
    refreshStatus();
    if (!p.destroyed && p.disconnected) setTimeout(() => { if (!p.destroyed && p.disconnected) p.reconnect(); }, 3000);
    if (!p.open && !document.querySelector('#room:not([hidden])')) {
      showLobbyError('Не удаётся связаться с сервером PeerJS. Проверь интернет или укажи свой сервер в настройках.');
    }
  }
}

function createRoom() {
  S.isHost = true;
  S.code = genCode();
  store.sset('hostCode', S.code);
  history.replaceState(null, '', '#' + S.code);
  startPeer(PREFIX + S.code);
}
function joinRoom(code) {
  S.isHost = false;
  S.code = code;
  history.replaceState(null, '', '#' + code);
  startPeer(undefined);
}
function enterRoom() {
  $('#lobby').hidden = true;
  $('#room').hidden = false;
  $('#leaveBtn').hidden = false;
  const link = location.origin + location.pathname + '#' + S.code;
  $('#inviteLink').value = link;
  $('#roomCode').textContent = S.code;
  $('#invite').hidden = !S.isHost || partnerOnline();
  setMode(S.mode, false);
}
function leaveRoom() {
  S.left = true;
  stopStreaming(false);
  stopCall(false);
  try { S.peer && S.peer.destroy(); } catch {}
  store.sset('hostCode', null);
  history.replaceState(null, '', location.pathname);
  location.reload();
}
function showLobbyError(t) {
  const e = $('#lobbyError');
  e.textContent = t;
  e.hidden = false;
}

function connectToHost() {
  clearTimeout(S.reconnectTimer);
  clearTimeout(S.connectTimer);
  if (S.left || S.isHost || partnerOnline()) return;
  if (!S.peer || S.peer.destroyed || S.peer.disconnected) { scheduleReconnect(); return; }
  const hostId = PREFIX + S.code;
  const ctrl = S.peer.connect(hostId, { reliable: true, serialization: 'json', metadata: { kind: 'ctrl' } });
  const file = S.peer.connect(hostId, { reliable: true, serialization: 'raw', metadata: { kind: 'file' } });
  setupCtrl(ctrl);
  setupFile(file);
  S.connectTimer = setTimeout(() => {
    if (!ctrl.open) {
      try { ctrl.close(); file.close(); } catch {}
      toast('Не удаётся соединиться напрямую', 7000);
      scheduleReconnect();
    }
  }, 15000);
}
function scheduleReconnect() {
  if (S.isHost || S.left) return;
  clearTimeout(S.reconnectTimer);
  S.reconnectTimer = setTimeout(connectToHost, 3000);
}

function acceptConn(c) {
  const kind = c.metadata && c.metadata.kind;
  if (kind === 'file') {
    if (S.file && S.file !== c) { const old = S.file; S.file = null; try { old.close(); } catch {} }
    setupFile(c);
  } else {
    if (S.ctrl && S.ctrl !== c) { const old = S.ctrl; S.ctrl = null; try { old.close(); } catch {} }
    setupCtrl(c);
  }
}

function setupCtrl(c) {
  c.on('open', () => {
    clearTimeout(S.connectTimer);
    S.ctrl = c;
    S.partnerId = c.peer;
    onPartnerConnected();
  });
  c.on('data', onCtrl);
  c.on('close', () => { if (S.ctrl === c) { S.ctrl = null; onPartnerLost(); } });
  c.on('error', (e) => console.warn('ctrl error', e));
}
function setupFile(c) {
  c.on('open', () => {
    S.file = c;
    try { c.dataChannel.binaryType = 'arraybuffer'; } catch {}
  });
  c.on('data', onFileData);
  c.on('close', () => {
    if (S.file === c) {
      S.file = null;
      if (S.recv) abortRecv('Связь прервалась, передача остановлена');
      if (S.send.active) S.send.cancel = true;
    }
  });
  c.on('error', (e) => console.warn('file error', e));
}

function onPartnerConnected() {
  send({ t: 'hello', name: S.name });
  if (S.isHost) send({ t: 'mode', mode: S.mode });
  sendMediaInfo();
  $('#invite').hidden = true;
  refreshStatus();
  detectNetType(S.ctrl);
  // восстановим то, что было до обрыва
  if (S.stream.role === 'sender' && S.stream.captured) setTimeout(() => callWithStream(S.stream.captured), 800);
  if (S.call.local) setTimeout(callPartner, 1000);
}
function onPartnerLost() {
  addSys(`${S.partnerName} покинул(а) комнату`);
  S.partnerMedia = null;
  renderPartnerMedia();
  $('#netChip').hidden = true;
  if (S.stream.role === 'viewer') endViewing();
  if (S.stream.call) { try { S.stream.call.close(); } catch {} S.stream.call = null; }
  hideFace();
  if (S.isHost) $('#invite').hidden = false;
  refreshStatus();
  scheduleReconnect();
}

async function detectNetType(conn) {
  await sleep(1500);
  const pc = conn && conn.peerConnection;
  if (!pc) return;
  const info = await pairInfo(pc);
  if (!info) return;
  const chip = $('#netChip');
  chip.hidden = false;
  chip.className = 'chip' + (info.relay ? ' relay' : '');
  chip.textContent = info.relay ? 'через TURN' : 'напрямую (P2P)';
  chip.title = `пинг ~${Math.round(S.rtt)} мс`;
}
async function pairInfo(pc) {
  try {
    const r = await pc.getStats();
    let pair = null;
    r.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = r.get(s.selectedCandidatePairId); });
    if (!pair) r.forEach((s) => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s; });
    if (!pair) return null;
    const l = r.get(pair.localCandidateId), rm = r.get(pair.remoteCandidateId);
    return { relay: (l && l.candidateType === 'relay') || (rm && rm.candidateType === 'relay'), rtt: pair.currentRoundTripTime };
  } catch { return null; }
}

/* ---------------- управляющие сообщения ---------------- */
function onCtrl(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'hello':
      S.partnerName = (m.name || '').trim() || 'Партнёр';
      $('#partnerMediaLabel').textContent = `${S.partnerName}:`;
      addSys(`${S.partnerName} в комнате`);
      refreshStatus();
      break;
    case 'mode': setMode(m.mode, false); break;
    case 'chat': addChat(S.partnerName, m.text, false); break;
    case 'ping': send({ t: 'pong', ts: m.ts }); break;
    case 'pong': { const r = Date.now() - m.ts; S.rtt = S.rtt * 0.7 + r * 0.3; break; }
    case 'media': S.partnerMedia = m.name ? m : null; renderPartnerMedia(); break;
    case 'url': showUrlOffer(m.url); break;
    case 'play': remotePlay(m.time); break;
    case 'pause': remotePause(m.time); break;
    case 'seek': remoteSeekMsg(m); break;
    case 'state': onHeartbeat(m); break;
    case 'remote': onRemoteControl(m); break;
    case 'sstate': onStreamState(m); break;
    case 'stream-stop': if (S.stream.role === 'viewer') endViewing(); break;
    case 'file-done': onFileDelivered(); break;
    case 'file-cancel': if (S.send.active) S.send.cancel = true; break;
    case 'call-off': hideFace(); break;
  }
}
setInterval(() => { if (partnerOnline()) send({ t: 'ping', ts: Date.now() }); }, 2000);

/* ---------------- режимы ---------------- */
const EMPTY_TEXT = {
  sync: 'Фильм не выбран',
  send: 'Фильм не выбран',
  stream: 'Трансляция не запущена',
};
function setMode(mode, broadcast) {
  if (!EMPTY_TEXT[mode]) return;
  const prev = S.mode;
  S.mode = mode;
  if (prev === 'stream' && mode !== 'stream') {
    if (S.stream.role === 'sender') stopStreaming(true);
    if (S.stream.role === 'viewer') endViewing();
  }
  $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  $$('.panel').forEach((p) => (p.hidden = p.dataset.panel !== mode));
  if (!(mode === 'stream' && S.stream.role === 'viewer')) restoreLocal();
  $('#streamCurrent').hidden = !(S.local.url && S.stream.role !== 'sender');
  updateEmpty();
  if (broadcast) send({ t: 'mode', mode });
}
function updateEmpty() {
  const has = !!(player.srcObject || player.getAttribute('src'));
  $('#stageEmpty').hidden = has;
  $('#stageEmptyText').textContent = EMPTY_TEXT[S.mode];
}

/* ---------------- плеер: локальное видео ---------------- */
function loadLocal(url, name, { file = null, isUrl = false } = {}) {
  if (S.local.url && S.local.url !== url && S.local.url.startsWith('blob:') && S.local.url !== S.recvUrl) {
    URL.revokeObjectURL(S.local.url);
  }
  S.local = { url, name, file, isUrl };
  player.srcObject = null;
  player.src = url;
  player.controls = true;
  $('#viewerBar').hidden = true;
  $('#myMedia').textContent = name;
  $('#streamCurrent').hidden = S.stream.role === 'sender';
  updateEmpty();
}
function restoreLocal() {
  if (player.srcObject) { player.srcObject = null; $('#viewerBar').hidden = true; stopStats(); }
  if (S.local.url && player.getAttribute('src') !== S.local.url) player.src = S.local.url;
  player.controls = !!S.local.url;
  updateEmpty();
}
function sendMediaInfo() {
  if (!S.local.url || player.srcObject) return send({ t: 'media', name: null });
  send({ t: 'media', name: S.local.name, duration: isFinite(player.duration) ? player.duration : null });
}
function renderPartnerMedia() {
  const pm = S.partnerMedia;
  $('#partnerMedia').textContent = pm ? `${pm.name}${pm.duration ? ' (' + fmtTime(pm.duration) + ')' : ''}` : 'ничего не выбрано';
  const mi = $('#matchInfo');
  mi.className = 'small';
  mi.textContent = '';
  if (pm && pm.duration && isFinite(player.duration) && !player.srcObject) {
    const d = Math.abs(pm.duration - player.duration);
    if (d < 3) { mi.className += ' ok-text'; mi.textContent = 'Фильмы совпадают'; }
    else { mi.className += ' warn-text'; mi.textContent = `Длительность отличается на ${fmtTime(d)}`; }
  }
}
function safePlay() {
  const p = player.play();
  if (p && p.catch) p.catch((e) => { if (e.name === 'NotAllowedError') $('#playOverlay').hidden = false; });
}
$('#playOverlay').addEventListener('click', () => {
  $('#playOverlay').hidden = true;
  player.play().catch(() => {});
  if (face.srcObject) face.play().catch(() => {});
});

player.addEventListener('loadedmetadata', () => {
  if (player.srcObject) return;
  $('#myMedia').textContent = `${S.local.name} (${fmtTime(player.duration)})`;
  sendMediaInfo();
  renderPartnerMedia();
});
player.addEventListener('error', () => {
  if (player.srcObject || !player.getAttribute('src')) return;
  toast('Не удалось открыть файл', 7000);
});

/* ---------------- синхронизация ---------------- */
function syncActive() { return S.mode === 'sync' && !!S.local.url && !player.srcObject; }
function markLocal() { S.lastLocalAction = Date.now(); }

player.addEventListener('play', () => {
  $('#playOverlay').hidden = true;
  if (!syncActive()) return;
  if (Date.now() < S.expect.play) { S.expect.play = 0; return; }
  markLocal();
  send({ t: 'play', time: player.currentTime });
});
player.addEventListener('pause', () => {
  if (!syncActive()) return;
  if (Date.now() < S.expect.pause) { S.expect.pause = 0; return; }
  markLocal();
  send({ t: 'pause', time: player.currentTime });
});
player.addEventListener('seeked', () => {
  if (!syncActive()) return;
  const e = S.expect.seek;
  if (e && Date.now() < e.until && Math.abs(player.currentTime - e.t) < 1.5) { S.expect.seek = null; return; }
  markLocal();
  send({ t: 'seek', time: player.currentTime, paused: player.paused });
});

function remoteSeekTo(t) {
  if (!isFinite(t)) return;
  if (Math.abs(player.currentTime - t) > 0.3) {
    S.expect.seek = { t, until: Date.now() + 8000 };
    player.currentTime = t;
  }
}
function remotePlay(time) {
  if (!syncActive()) return;
  remoteSeekTo(time + latency());
  if (player.paused) { S.expect.play = Date.now() + 3000; safePlay(); }
}
function remotePause(time) {
  if (!syncActive()) return;
  if (!player.paused) { S.expect.pause = Date.now() + 3000; player.pause(); }
  remoteSeekTo(time);
}
function remoteSeekMsg(m) {
  if (!syncActive()) return;
  remoteSeekTo(m.paused ? m.time : m.time + latency());
  if (m.paused && !player.paused) { S.expect.pause = Date.now() + 3000; player.pause(); }
  if (!m.paused && player.paused) { S.expect.play = Date.now() + 3000; safePlay(); }
}
// хост раз в 2 секунды сообщает своё время, гость подстраивается
setInterval(() => {
  if (S.isHost && syncActive() && partnerOnline() && S.partnerMedia && player.readyState >= 2) {
    send({ t: 'state', time: player.currentTime, paused: player.paused });
  }
}, 2000);
function onHeartbeat(m) {
  if (!syncActive() || player.seeking || player.readyState < 2) return;
  if (Date.now() - S.lastLocalAction < 2500) return;
  if (S.expect.seek && Date.now() < S.expect.seek.until) return;
  const target = m.paused ? m.time : m.time + latency();
  if (m.paused && !player.paused) { S.expect.pause = Date.now() + 3000; player.pause(); }
  if (!m.paused && player.paused && !player.ended) { remoteSeekTo(target); S.expect.play = Date.now() + 3000; safePlay(); return; }
  if (Math.abs(player.currentTime - target) > 0.45) remoteSeekTo(target);
}

/* режим 1: выбор файла / ссылки / субтитров */
$('#syncFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  loadLocal(URL.createObjectURL(f), f.name, { file: f });
});
$('#urlForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#urlInput').value.trim();
  if (!/^https?:\/\//i.test(url)) { toast('Нужна ссылка http(s)'); return; }
  loadLocal(url, decodeURIComponent(url.split('/').pop().split('?')[0]) || url, { isUrl: true });
  send({ t: 'url', url });
});
function showUrlOffer(url) {
  const o = $('#urlOffer');
  o.hidden = false;
  o.innerHTML = `<span>${esc(S.partnerName)} открыл(а) ссылку: ${esc(url)}</span>`;
  const b = document.createElement('button');
  b.className = 'btn primary small';
  b.textContent = 'Открыть тоже';
  b.onclick = () => {
    o.hidden = true;
    setMode('sync', true);
    $('#urlInput').value = url;
    loadLocal(url, decodeURIComponent(url.split('/').pop().split('?')[0]) || url, { isUrl: true });
  };
  o.appendChild(b);
}
$('#subsFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const buf = await f.arrayBuffer();
  let txt;
  try { txt = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { txt = new TextDecoder('windows-1251').decode(buf); } // русские .srt часто в cp1251
  txt = txt.replace(/^\uFEFF/, '').replace(/\r/g, '');
  if (!/^WEBVTT/.test(txt.trim())) txt = 'WEBVTT\n\n' + txt.replace(/(\d{1,2}:\d\d:\d\d),(\d{1,3})/g, '$1.$2');
  player.querySelectorAll('track').forEach((t) => t.remove());
  const tr = document.createElement('track');
  tr.kind = 'subtitles'; tr.label = 'Субтитры'; tr.srclang = 'ru'; tr.default = true;
  tr.src = URL.createObjectURL(new Blob([txt], { type: 'text/vtt' }));
  player.appendChild(tr);
  setTimeout(() => { if (tr.track) tr.track.mode = 'showing'; }, 50);
  toast('Субтитры добавлены');
});

/* ---------------- режим 2: передача файла ---------------- */
function waitLow(dc) {
  return new Promise((res) => {
    const h = () => { dc.removeEventListener('bufferedamountlow', h); dc.removeEventListener('close', h); res(); };
    dc.addEventListener('bufferedamountlow', h);
    dc.addEventListener('close', h);
  });
}
function speedMeter() {
  const pts = [];
  return (bytes) => {
    const now = performance.now();
    pts.push([now, bytes]);
    while (pts.length > 2 && now - pts[0][0] > 5000) pts.shift();
    const [t0, b0] = pts[0];
    return now - t0 > 300 ? ((bytes - b0) / (now - t0)) * 1000 : 0; // байт/с
  };
}
function showTransfer(title, name, done, total, bps) {
  $('#transfer').hidden = false;
  $('#trTitle').textContent = title;
  $('#trName').textContent = name;
  $('#trBar').style.width = (total ? (done / total) * 100 : 0).toFixed(1) + '%';
  let info = `${fmtBytes(done)} из ${fmtBytes(total)}`;
  if (bps > 0) {
    info += ` · ${((bps * 8) / 1e6).toFixed(1)} Мбит/с`;
    const left = (total - done) / bps;
    info += ` · осталось ~${left > 90 ? Math.ceil(left / 60) + ' мин' : Math.ceil(left) + ' с'}`;
  }
  $('#trInfo').textContent = info;
}

async function sendFile(file) {
  if (!partnerOnline() || !S.file || !S.file.open) { toast('Подожди, пока собеседник подключится'); return; }
  if (S.send.active) return;
  const dc = S.file.dataChannel;
  dc.bufferedAmountLowThreshold = LOW_WATER;
  S.send = { active: true, cancel: false, file };
  setMode('send', true);
  $('#cancelTransfer').hidden = false;
  $('#saveReceived').hidden = true;
  const speed = speedMeter();
  let off = 0, lastUi = 0;
  try {
    dc.send(JSON.stringify({ t: 'start', name: file.name, size: file.size, type: file.type }));
    while (off < file.size) {
      if (S.send.cancel || dc.readyState !== 'open') throw new Error('cancel');
      const block = await file.slice(off, off + READ_BLOCK).arrayBuffer();
      for (let i = 0; i < block.byteLength; i += CHUNK) {
        if (dc.bufferedAmount > HIGH_WATER) await waitLow(dc);
        if (S.send.cancel || dc.readyState !== 'open') throw new Error('cancel');
        dc.send(block.slice(i, i + CHUNK));
      }
      off += block.byteLength;
      const sent = Math.max(0, off - dc.bufferedAmount);
      const bps = speed(sent);
      if (performance.now() - lastUi > 250) { lastUi = performance.now(); showTransfer('Отправляю:', file.name, sent, file.size, bps); }
    }
    dc.send(JSON.stringify({ t: 'end' }));
    showTransfer('Почти готово…', file.name, file.size, file.size, 0);
    $('#trInfo').textContent = 'Файл отправлен, ждём подтверждения…';
  } catch (e) {
    try { if (dc.readyState === 'open') dc.send(JSON.stringify({ t: 'cancel' })); } catch {}
    $('#trTitle').textContent = 'Передача остановлена';
    $('#trInfo').textContent = '';
    S.send.file = null;
  } finally {
    S.send.active = false;
    $('#cancelTransfer').hidden = true;
  }
}
function onFileDelivered() {
  const f = S.send.file;
  $('#trTitle').textContent = 'Фильм доставлен';
  $('#trInfo').textContent = '';
  if (f) loadLocal(URL.createObjectURL(f), f.name, { file: f });
  setMode('sync', true);
  toast('Фильм доставлен');
}

async function makeSink(name, type, size) {
  // Пишем на диск (OPFS), чтобы большой фильм не занимал оперативную память
  try {
    if (navigator.storage && navigator.storage.getDirectory) {
      const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
      if (est && est.quota && est.quota - (est.usage || 0) < size) {
        toast('На диске может не хватить места', 6000);
      }
      const root = await navigator.storage.getDirectory();
      for await (const [n] of root.entries()) { try { await root.removeEntry(n); } catch {} }
      const fh = await root.getFileHandle('movie-' + Date.now(), { create: true });
      if (fh.createWritable) {
        const w = await fh.createWritable();
        return {
          write: (c) => w.write(c),
          finish: async () => { await w.close(); const f = await fh.getFile(); return new File([f], name, { type: type || f.type }); },
          abort: () => w.abort().catch(() => {}),
        };
      }
    }
  } catch (e) { console.warn('OPFS недоступен, использую память', e); }
  const parts = [];
  return { write: (c) => { parts.push(c); }, finish: async () => new File(parts, name, { type }), abort: () => { parts.length = 0; } };
}

function onFileData(d) {
  if (typeof d === 'string') {
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'start') beginRecv(m);
    else if (m.t === 'end') endRecv();
    else if (m.t === 'cancel') abortRecv('Собеседник отменил передачу');
    return;
  }
  const r = S.recv;
  if (!r) return;
  const chunk = d instanceof ArrayBuffer ? d : d.buffer ? d : null;
  if (!chunk) return;
  r.got += chunk.byteLength;
  r.chain = r.chain.then(() => r.sink.write(chunk));
  const now = performance.now();
  if (now - r.lastUi > 250) { r.lastUi = now; showTransfer('Получаю:', r.name, r.got, r.size, r.speed(r.got)); }
}
function beginRecv(m) {
  if (S.recv) abortRecv();
  setMode('send', false);
  const r = { name: m.name, size: m.size, type: m.type, got: 0, lastUi: 0, speed: speedMeter(), sink: null };
  r.chain = makeSink(m.name, m.type, m.size).then((s) => { r.sink = s; });
  r.chain.catch((e) => { console.error(e); });
  S.recv = r;
  $('#saveReceived').hidden = true;
  $('#cancelTransfer').hidden = false;
  showTransfer('Получаю:', r.name, 0, r.size, 0);
}
async function endRecv() {
  const r = S.recv;
  if (!r) return;
  $('#cancelTransfer').hidden = true;
  $('#trTitle').textContent = 'Сохраняю…';
  try {
    await r.chain;
    const file = await r.sink.finish();
    if (S.recv !== r) return;
    S.recv = null;
    if (r.got !== r.size) toast('Файл пришёл не полностью', 6000);
    if (S.recvUrl) URL.revokeObjectURL(S.recvUrl);
    S.recvUrl = URL.createObjectURL(file);
    const a = $('#saveReceived');
    a.href = S.recvUrl;
    a.download = r.name;
    a.hidden = false;
    showTransfer('Получено', r.name, r.size, r.size, 0);
    $('#trInfo').textContent = 'Фильм загружен в плеер. Можно сохранить его кнопкой ниже.';
    loadLocal(S.recvUrl, r.name, { file });
    send({ t: 'file-done' });
    setMode('sync', true);
    toast('Фильм получен');
  } catch (e) {
    console.error(e);
    abortRecv('Не удалось сохранить файл (возможно, не хватает места)');
  }
}
function abortRecv(msg) {
  const r = S.recv;
  if (!r) return;
  S.recv = null;
  r.chain.then(() => r.sink && r.sink.abort()).catch(() => {});
  $('#cancelTransfer').hidden = true;
  if (msg) { $('#trTitle').textContent = msg; $('#trInfo').textContent = ''; }
}
$('#sendFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) sendFile(f);
});
$('#cancelTransfer').addEventListener('click', () => {
  if (S.send.active) S.send.cancel = true;
  if (S.recv) { send({ t: 'file-cancel' }); abortRecv('Передача отменена'); }
});

/* ---------------- режим 3: трансляция ---------------- */
function tuneSdp(sdp) {
  // стерео-звук Opus с высоким битрейтом (по умолчанию WebRTC шлёт почти моно ~32 кбит/с)
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const extra = 'stereo=1;sprop-stereo=1;maxaveragebitrate=510000';
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (re.test(sdp)) {
    return sdp.replace(re, (all, params) => {
      const clean = params.split(';').filter((p) => p && !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(p.trim()));
      return `a=fmtp:${pt} ${[...clean, extra].join(';')}`;
    });
  }
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${extra}`);
}
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(50); }
  return null;
}
async function applyQuality() {
  const call = S.stream.call;
  const pc = call && call.peerConnection;
  if (!pc) return;
  const bitrate = +$('#qBitrate').value, fps = +$('#qFps').value;
  for (const s of pc.getSenders()) {
    if (!s.track) continue;
    try {
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      if (s.track.kind === 'video') {
        p.encodings[0].maxBitrate = bitrate;
        p.encodings[0].maxFramerate = fps;
        p.encodings[0].scaleResolutionDownBy = 1;
        p.degradationPreference = 'maintain-resolution';
      } else {
        p.encodings[0].maxBitrate = 384000;
      }
      await s.setParameters(p);
    } catch (e) { console.warn('setParameters', e); }
  }
}
['#qBitrate', '#qFps'].forEach((id) => $(id).addEventListener('change', applyQuality));

async function startStreaming(file) {
  if (!partnerOnline()) { toast('Подожди, пока собеседник подключится'); return; }
  stopStreaming(false);
  if (file) loadLocal(URL.createObjectURL(file), file.name, { file });
  if (!S.local.url) return;
  setMode('stream', true);
  S.stream.role = 'sender';
  restoreLocal();
  $('#streamCurrent').hidden = true;
  $('#stopStream').hidden = false;
  if (player.readyState < 1) await new Promise((r) => player.addEventListener('loadedmetadata', r, { once: true }));
  try { await player.play(); } catch {}
  let cap = null;
  try { cap = player.captureStream ? player.captureStream() : player.mozCaptureStream ? player.mozCaptureStream() : null; }
  catch (e) { console.warn(e); }
  if (!cap) {
    toast('Трансляция этого видео недоступна', 8000);
    stopStreaming(true);
    return;
  }
  // ждём, пока появятся дорожки видео и звука
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const v = cap.getVideoTracks().length, a = cap.getAudioTracks().length;
    if (v && a) break;
    if (v && Date.now() - t0 > 1500) break;
    await sleep(100);
  }
  if (!cap.getVideoTracks().length) { toast('Не удалось получить видео из файла'); stopStreaming(true); return; }
  S.stream.captured = cap;
  callWithStream(cap);
  clearInterval(S.stream.stateTimer);
  S.stream.stateTimer = setInterval(() => {
    if (S.stream.role === 'sender') send({ t: 'sstate', time: player.currentTime, duration: player.duration, paused: player.paused });
  }, 1000);
}
async function callWithStream(cap) {
  if (!S.partnerId || !S.peer) return;
  if (S.stream.call) { try { S.stream.call.close(); } catch {} }
  const call = S.peer.call(S.partnerId, cap, { metadata: { kind: 'movie', buffer: +$('#qBuffer').value }, sdpTransform: tuneSdp });
  if (!call) return;
  S.stream.call = call;
  call.on('close', () => { if (S.stream.call === call) S.stream.call = null; });
  call.on('error', (e) => console.warn('stream call', e));
  const pc = await waitFor(() => call.peerConnection);
  if (!pc) return;
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') applyQuality();
    if (pc.connectionState === 'failed') toast('Не удалось соединиться для трансляции', 7000);
  });
  setTimeout(applyQuality, 1500);
  startStats(pc, 'out');
}
function stopStreaming(notify) {
  if (S.stream.role !== 'sender') return;
  S.stream.role = null;
  clearInterval(S.stream.stateTimer);
  if (S.stream.call) { try { S.stream.call.close(); } catch {} S.stream.call = null; }
  if (S.stream.captured) { S.stream.captured.getTracks().forEach((t) => t.stop()); S.stream.captured = null; }
  stopStats();
  $('#stopStream').hidden = true;
  $('#streamCurrent').hidden = !S.local.url;
  if (notify) send({ t: 'stream-stop' });
}
function onRemoteControl(m) {
  if (S.stream.role !== 'sender') return;
  if (m.a === 'toggle') player.paused ? player.play().catch(() => {}) : player.pause();
  if (m.a === 'seek') player.currentTime = Math.max(0, player.currentTime + m.d);
  if (m.a === 'seekTo' && isFinite(m.t)) player.currentTime = m.t;
}

// зритель
function onCall(call) {
  const kind = call.metadata && call.metadata.kind;
  if (kind === 'movie') {
    if (S.stream.remoteCall && S.stream.remoteCall !== call) { try { S.stream.remoteCall.close(); } catch {} }
    if (S.stream.role === 'sender') stopStreaming(false);
    S.stream.remoteCall = call;
    S.stream.role = 'viewer';
    call.answer(undefined, { sdpTransform: tuneSdp });
    call.on('stream', (st) => showRemoteStream(st, call));
    call.on('close', () => { if (S.stream.remoteCall === call) endViewing(); });
  } else if (kind === 'call') {
    if (S.call.in && S.call.in !== call) { try { S.call.in.close(); } catch {} }
    S.call.in = call;
    call.answer();
    call.on('stream', (st) => showFace(st));
    call.on('close', () => { if (S.call.in === call) { S.call.in = null; hideFace(); } });
  } else {
    call.close();
  }
}
async function showRemoteStream(st, call) {
  if (S.mode !== 'stream') setMode('stream', false);
  if (player.srcObject !== st) {
    player.removeAttribute('src');
    player.load();
    player.srcObject = st;
  }
  player.controls = false;
  $('#viewerBar').hidden = false;
  updateEmpty();
  safePlay();
  const pc = call.peerConnection;
  if (pc) {
    const ms = (call.metadata && call.metadata.buffer) || 500;
    pc.getReceivers().forEach((r) => {
      try {
        if ('jitterBufferTarget' in r) r.jitterBufferTarget = ms;
        else if ('playoutDelayHint' in r) r.playoutDelayHint = ms / 1000;
      } catch {}
    });
    startStats(pc, 'in');
  }
}
function endViewing() {
  if (S.stream.role !== 'viewer') return;
  S.stream.role = null;
  if (S.stream.remoteCall) { try { S.stream.remoteCall.close(); } catch {} S.stream.remoteCall = null; }
  player.srcObject = null;
  $('#viewerBar').hidden = true;
  stopStats();
  restoreLocal();
  $('#streamCurrent').hidden = !S.local.url;
}
let seekDragging = false, streamDur = 0;
function onStreamState(m) {
  if (S.stream.role !== 'viewer') return;
  streamDur = m.duration || 0;
  $('#vTime').textContent = fmtTime(m.time);
  $('#vDur').textContent = fmtTime(m.duration);
  if (!seekDragging && streamDur) $('#vSeek').value = Math.round((m.time / streamDur) * 1000);
  $('#vToggle').innerHTML = m.paused ? ICON_PLAY : ICON_PAUSE;
}
$('#vToggle').addEventListener('click', () => send({ t: 'remote', a: 'toggle' }));
$('#vBack').addEventListener('click', () => send({ t: 'remote', a: 'seek', d: -10 }));
$('#vFwd').addEventListener('click', () => send({ t: 'remote', a: 'seek', d: 10 }));
$('#vSeek').addEventListener('input', () => { seekDragging = true; $('#vTime').textContent = fmtTime(($('#vSeek').value / 1000) * streamDur); });
$('#vSeek').addEventListener('change', () => { seekDragging = false; send({ t: 'remote', a: 'seekTo', t: ($('#vSeek').value / 1000) * streamDur }); });
$('#vVol').addEventListener('input', (e) => { player.volume = +e.target.value; player.muted = false; });

$('#streamFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) startStreaming(f);
});
$('#streamCurrent').addEventListener('click', () => startStreaming(null));
$('#stopStream').addEventListener('click', () => { stopStreaming(true); });

// статистика
function startStats(pc, dir) {
  stopStats();
  let prev = null;
  const box = $('#stats');
  box.hidden = false;
  box.textContent = 'Соединяюсь…';
  S.stream.statsTimer = setInterval(async () => {
    if (pc.connectionState === 'closed') { stopStats(); return; }
    let r;
    try { r = await pc.getStats(); } catch { return; }
    let v = null;
    r.forEach((s) => { if (s.type === (dir === 'in' ? 'inbound-rtp' : 'outbound-rtp') && s.kind === 'video') v = s; });
    if (!v) return;
    const bytes = dir === 'in' ? v.bytesReceived : v.bytesSent;
    let mbps = 0;
    if (prev) mbps = ((bytes - prev.bytes) * 8) / ((v.timestamp - prev.ts) / 1000) / 1e6;
    const parts = [];
    if (v.frameWidth) parts.push(`${v.frameWidth}×${v.frameHeight}`);
    if (v.framesPerSecond != null) parts.push(`${Math.round(v.framesPerSecond)} fps`);
    parts.push(`${mbps.toFixed(1)} Мбит/с`);
    if (dir === 'in' && prev && v.packetsReceived != null) {
      const lost = (v.packetsLost || 0) - prev.lost, recv = v.packetsReceived - prev.recv;
      const pct = lost + recv > 0 ? (lost / (lost + recv)) * 100 : 0;
      if (pct > 0.1) parts.push(`потери ${pct.toFixed(1)}%`);
    }
    if (dir === 'out' && v.qualityLimitationReason && v.qualityLimitationReason !== 'none') {
      parts.push(v.qualityLimitationReason === 'bandwidth' ? 'упирается в скорость интернета' : v.qualityLimitationReason === 'cpu' ? 'упирается в процессор' : v.qualityLimitationReason);
    }
    const pi = await pairInfo(pc);
    if (pi && pi.relay) parts.push('через TURN');
    box.textContent = parts.join(' · ');
    prev = { bytes, ts: v.timestamp, lost: v.packetsLost || 0, recv: v.packetsReceived || 0 };
  }, 1000);
}
function stopStats() {
  clearInterval(S.stream.statsTimer);
  S.stream.statsTimer = null;
  $('#stats').hidden = true;
}

/* ---------------- звонок (микрофон + камера) ---------------- */
async function toggleTrack(kind) {
  if (!partnerOnline()) { toast('Подожди, пока собеседник подключится'); return; }
  const hasKind = S.call.local && S.call.local.getTracks().some((t) => t.kind === kind);
  if (hasKind) {
    S.call.local.getTracks().filter((t) => t.kind === kind).forEach((t) => { t.stop(); S.call.local.removeTrack(t); });
  } else {
    try {
      const st = await navigator.mediaDevices.getUserMedia(kind === 'audio'
        ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
        : { video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } });
      if (!S.call.local) S.call.local = new MediaStream();
      st.getTracks().forEach((t) => S.call.local.addTrack(t));
    } catch (e) {
      toast(kind === 'audio' ? 'Нет доступа к микрофону' : 'Нет доступа к камере');
      return;
    }
  }
  if (S.call.local && !S.call.local.getTracks().length) S.call.local = null;
  updateCallButtons();
  if (S.call.local) callPartner(); else stopCall(true);
}
function callPartner() {
  if (!S.call.local || !S.partnerId) return;
  if (S.call.out) { try { S.call.out.close(); } catch {} }
  S.call.out = S.peer.call(S.partnerId, S.call.local, { metadata: { kind: 'call' } });
}
function stopCall(notify) {
  if (S.call.out) { try { S.call.out.close(); } catch {} S.call.out = null; }
  if (S.call.local) { S.call.local.getTracks().forEach((t) => t.stop()); S.call.local = null; }
  updateCallButtons();
  if (notify) send({ t: 'call-off' });
}
function updateCallButtons() {
  const tr = S.call.local ? S.call.local.getTracks() : [];
  $('#micBtn').setAttribute('aria-pressed', String(tr.some((t) => t.kind === 'audio')));
  $('#camBtn').setAttribute('aria-pressed', String(tr.some((t) => t.kind === 'video')));
}
function showFace(st) {
  face.srcObject = st;
  face.volume = +$('#voiceVol').value;
  face.hidden = !st.getVideoTracks().length;
  face.play().catch(() => { $('#playOverlay').hidden = false; });
}
function hideFace() {
  face.srcObject = null;
  face.hidden = true;
}
face.addEventListener('click', () => face.classList.toggle('small'));
$('#micBtn').addEventListener('click', () => toggleTrack('audio'));
$('#camBtn').addEventListener('click', () => toggleTrack('video'));
$('#voiceVol').addEventListener('input', (e) => { face.volume = +e.target.value; });

/* ---------------- чат ---------------- */
function addChat(who, text, mine) {
  const li = document.createElement('li');
  if (mine) li.className = 'mine';
  li.innerHTML = `<span class="who">${esc(who)}</span>${esc(text)}`;
  const box = $('#messages');
  box.appendChild(li);
  box.scrollTop = box.scrollHeight;
  if (!mine && (document.fullscreenElement || document.webkitFullscreenElement || document.hidden || window.innerWidth <= 960)) {
    toast(`<b>${esc(who)}:</b> ${esc(text)}`, 6000);
  }
}
function addSys(text) {
  const li = document.createElement('li');
  li.className = 'sys';
  li.textContent = text;
  $('#messages').appendChild(li);
  $('#messages').scrollTop = 1e9;
}
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#chatInput').value.trim();
  if (!v) return;
  if (!partnerOnline()) { toast('Собеседник ещё не в комнате'); return; }
  send({ t: 'chat', text: v });
  addChat(S.name || 'Я', v, true);
  $('#chatInput').value = '';
});

/* ---------------- полноэкранный режим ---------------- */
$('#fsBtn').addEventListener('click', () => {
  const st = $('#stage');
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else if (st.requestFullscreen) st.requestFullscreen();
  else if (st.webkitRequestFullscreen) st.webkitRequestFullscreen();
  else if (player.webkitEnterFullscreen) player.webkitEnterFullscreen();
});
function onFsChange() {
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  const t = $('#toasts');
  if (fs) fs.appendChild(t); else document.body.appendChild(t);
}
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);

/* ---------------- лобби и инициализация ---------------- */
$$('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode, true)));
$('#leaveBtn').addEventListener('click', leaveRoom);
$('#copyLink').addEventListener('click', async () => {
  const inp = $('#inviteLink');
  try { await navigator.clipboard.writeText(inp.value); }
  catch { inp.select(); document.execCommand('copy'); }
  $('#copyLink').textContent = 'Скопировано';
  setTimeout(() => ($('#copyLink').textContent = 'Копировать'), 2000);
});

function saveName() {
  S.name = $('#nameInput').value.trim().slice(0, 24);
  store.set('name', S.name);
}
$('#nameInput').value = S.name;
$('#createBtn').addEventListener('click', () => { saveName(); createRoom(); });
$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = parseCode($('#codeInput').value);
  if (code.length < 4) { showLobbyError('Введи код комнаты из ссылки'); return; }
  saveName();
  joinRoom(code);
});

const ns = loadSettings();
$('#turnUrl').value = ns.turnUrl || '';
$('#turnUser').value = ns.turnUser || '';
$('#turnPass').value = ns.turnPass || '';
$('#peerServer').value = ns.peerServer || '';
$('#saveSettings').addEventListener('click', () => {
  store.set('net', JSON.stringify({
    turnUrl: $('#turnUrl').value.trim(), turnUser: $('#turnUser').value.trim(),
    turnPass: $('#turnPass').value, peerServer: $('#peerServer').value.trim(),
  }));
  $('#settingsSaved').hidden = false;
  setTimeout(() => ($('#settingsSaved').hidden = true), 2000);
});

window.addEventListener('beforeunload', (e) => {
  if (S.send.active || S.recv) { e.preventDefault(); e.returnValue = ''; return; }
  try { S.peer && S.peer.destroy(); } catch {}
});
window.addEventListener('pagehide', () => { try { S.peer && S.peer.destroy(); } catch {} });

(function init() {
  if (typeof Peer === 'undefined') { showLobbyError('Не загрузилась библиотека PeerJS. Обнови страницу.'); return; }
  const code = parseCode(location.hash);
  if (code) {
    if (store.sget('hostCode') === code) { S.isHost = true; S.code = code; startPeer(PREFIX + code); return; }
    $('#codeInput').value = code;
    $('#createBtn').classList.remove('primary');
    $('#joinForm button').classList.add('primary');
    (S.name ? $('#joinForm button') : $('#nameInput')).focus();
  }
})();

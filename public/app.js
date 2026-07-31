import {
  cipherSupported,
  forgetPeer,
  installReceiverCipher,
  installSenderCipher,
  pcCipherOptions,
  setEncryptionEnabled,
  setPeerKey,
} from './cipher.js';
import { makeEphemeralKeys, deriveSharedKey } from './crypto-dh.js';
import { log, getEntries, onLog, clearLog, CATEGORIES } from './logbook.js';
import { initAdmin, onServerMessage as adminServerMessage, isAdmin, adminName } from './admin.js';

const ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

const EMOJI = [...'🦊🐼🐸🐙🦉🐝🦄🐺🐳🦕🐢🦋🐧🦔🐨🦁🐮🐷🦀🐬🦩🐿️🦇🐤'];
const COLORS = ['#7c8cff', '#46d39a', '#ffb547', '#ff6b9d', '#5ec8f2', '#c084fc', '#f97362', '#4ade80'];
const ADJECTIVES = ['quiet', 'loud', 'fuzzy', 'quick', 'lazy', 'brave', 'odd', 'tiny', 'lucky', 'wired'];
const NOUNS = ['comet', 'moth', 'pixel', 'ember', 'echo', 'tuba', 'wren', 'onion', 'radio', 'ghost'];

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const stage = $('stage');
const audioBin = $('audio');

let ws = null;
let myId = null;
let localStream = null;
let muted = false;
let encrypting = true; // app-layer DH encryption on by default
let reconnectDelay = 1000;
let audioBlocked = false;
let ejected = false; // kicked/banned: stop auto-reconnecting

/** id -> peer record */
const peers = new Map();
/** DH pubkeys that arrived before we had a link record for the sender. */
const pendingDh = new Map();

/* ---------- theme ---------- */

function applyTheme(name) {
  const theme = ['dark', 'light', 'midnight'].includes(name) ? name : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('vc-theme', theme); } catch { /* not persisted */ }
  if ($('themeSelect')) $('themeSelect').value = theme;
}
applyTheme(localStorage.getItem('vc-theme') || 'dark');

/* ---------- profile (browser-local, no account) ---------- */

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function randomProfile() {
  return { name: `${pick(ADJECTIVES)}-${pick(NOUNS)}`, emoji: pick(EMOJI), color: pick(COLORS), avatar: null };
}

function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem('vc-profile'));
    if (saved && saved.name) return { avatar: null, ...saved };
  } catch { /* fresh identity */ }
  const fresh = randomProfile();
  saveProfile(fresh);
  return fresh;
}

function saveProfile(p) {
  try { localStorage.setItem('vc-profile', JSON.stringify(p)); } catch { /* ephemeral */ }
}

let profile = loadProfile();

/* ---------- rendering ---------- */

function paintAvatar(el, p) {
  if (p.avatar) {
    el.style.background = `center / cover no-repeat url(${JSON.stringify(p.avatar)})`;
    el.textContent = '';
  } else {
    el.style.background = `linear-gradient(150deg, ${p.color}, ${shade(p.color, -40)})`;
    el.textContent = p.emoji || '🙂';
  }
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255]
    .map((v) => Math.max(0, Math.min(255, v + amt)).toString(16).padStart(2, '0'));
  return `#${c.join('')}`;
}

function cardFor(id) {
  const entry = peers.get(id);
  if (!entry.card) {
    const li = document.createElement('li');
    li.className = 'peer';
    li.innerHTML = '<div class="avatar"></div><div class="name"></div><div class="sub"></div>';
    if (id === myId) li.classList.add('me');
    li.onclick = () => openPopover(id);
    entry.card = li;
  }
  return entry.card;
}

function renderPeer(id) {
  const entry = peers.get(id);
  if (!entry) return;
  const card = cardFor(id);

  // Admins sit up on the stage; everyone else in the grid.
  const container = entry.admin ? stage : grid;
  if (card.parentElement !== container) {
    if (id === myId) container.prepend(card); else container.append(card);
  }

  paintAvatar(card.querySelector('.avatar'), entry.profile);
  card.querySelector('.name').textContent = entry.admin && entry.adminName ? entry.adminName : entry.profile.name;
  card.querySelector('.sub').textContent = entry.secured ? `🔒 ${entry.fpr || ''}`.trim() : '';

  card.classList.toggle('muted', !!entry.muted || !!entry.forcedMuted);
  card.classList.toggle('admin', !!entry.admin);
  card.classList.toggle('spotlight', !!entry.spotlight);
  card.classList.toggle('secured', !!entry.secured);

  // Force-mute: honest clients stop playing this person locally.
  if (entry.audioEl) entry.audioEl.muted = !!entry.forcedMuted;
  if (id === myId && entry.forcedMuted) applyForcedMuteToSelf();

  stage.classList.toggle('active', stage.children.length > 0);
  $('empty').hidden = peers.size > 1;
}

function removePeer(id) {
  const entry = peers.get(id);
  if (!entry) return;
  entry.pc?.close();
  entry.meter?.stop();
  entry.audioEl?.remove();
  entry.card?.remove();
  forgetPeer(id);
  pendingDh.delete(id);
  peers.delete(id);
  stage.classList.toggle('active', stage.children.length > 0);
  $('empty').hidden = peers.size > 1;
}

function setStatus(text, state) {
  $('status').textContent = text;
  $('statusDot').className = `dot${state ? ` ${state}` : ''}`;
}

/* ---------- speaking meter ---------- */

let audioCtx = null;

function ensureAudioCtx() {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => showUnblock());
    if (audioCtx.state === 'suspended') showUnblock();
  }
  return audioCtx;
}

function meterFor(stream, onSpeaking) {
  ensureAudioCtx();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  let speaking = false;
  let quietFrames = 0;

  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
    const rms = Math.sqrt(sum / buf.length);
    if (rms > 0.045) {
      quietFrames = 0;
      if (!speaking) onSpeaking((speaking = true));
    } else if (speaking && ++quietFrames > 6) {
      onSpeaking((speaking = false));
    }
  };
  const timer = setInterval(tick, 60);
  return { stop() { clearInterval(timer); try { source.disconnect(); } catch { /* torn down */ } } };
}

function watchSpeaking(id, stream) {
  const entry = peers.get(id);
  entry.meter?.stop();
  entry.meter = meterFor(stream, (on) => {
    const e = peers.get(id);
    if (e?.card) e.card.classList.toggle('speaking', on && !e.muted && !e.forcedMuted);
  });
}

/* ---------- WebRTC mesh + Diffie-Hellman per link ---------- */

function signal(to, data) {
  ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'signal', to, data }));
}

async function connectTo(id, peer, initiator) {
  const pc = new RTCPeerConnection({ ...ICE, ...pcCipherOptions() });
  peers.set(id, { ...peer, pc, pending: [], dh: null, secured: false, volume: 1 });
  log('webrtc', `${initiator ? 'dialing' : 'answering'} ${peer.profile?.name || id.slice(0, 6)}`);

  for (const track of localStream.getTracks()) {
    installSenderCipher(pc.addTrack(track, localStream), id);
  }
  attachReceiveCiphers(pc, id);

  pc.onicecandidate = (e) => { if (e.candidate) signal(id, { candidate: e.candidate }); };

  pc.ontrack = (e) => {
    installReceiverCipher(e.receiver, id);
    const stream = e.streams[0];
    const entry = peers.get(id);
    if (!entry || entry.stream === stream) return;
    entry.stream = stream;

    const el = new Audio();
    el.srcObject = stream;
    el.autoplay = true;
    el.playsInline = true;
    el.volume = entry.volume ?? 1;
    el.muted = !!entry.forcedMuted;
    entry.audioEl?.remove();
    entry.audioEl = el;
    audioBin.append(el);
    el.play().catch(() => showUnblock());
    log('media', `receiving audio from ${entry.profile?.name || id.slice(0, 6)}`);

    watchSpeaking(id, stream);
  };

  pc.onconnectionstatechange = () => {
    log('webrtc', `${peer.profile?.name || id.slice(0, 6)}: ${pc.connectionState}`);
    if (pc.connectionState === 'failed') pc.restartIce();
  };

  if (initiator) {
    pc.onnegotiationneeded = async () => {
      try {
        await pc.setLocalDescription();
        signal(id, { sdp: pc.localDescription });
      } catch (err) { log('webrtc', `negotiation failed: ${err.message}`); }
    };
  }

  // Kick off the Diffie-Hellman handshake for this link.
  const dh = await makeEphemeralKeys();
  const entry = peers.get(id);
  if (!entry) return pc; // peer left mid-handshake
  entry.dh = dh;
  signal(id, { dh: dh.publicKeyB64 });
  log('dh', `sent ephemeral public key to ${entry.profile?.name || id.slice(0, 6)}`);

  const buffered = pendingDh.get(id);
  if (buffered) { pendingDh.delete(id); await deriveWithPeer(id, buffered); }

  renderPeer(id);
  return pc;
}

function attachReceiveCiphers(pc, id) {
  for (const tx of pc.getTransceivers()) if (tx.receiver) installReceiverCipher(tx.receiver, id);
}

async function deriveWithPeer(id, peerPubB64) {
  const entry = peers.get(id);
  if (!entry) return;
  if (!entry.dh) { pendingDh.set(id, peerPubB64); return; } // our keys not ready yet
  try {
    const { key, fingerprint } = await deriveSharedKey(entry.dh.privateKey, peerPubB64, entry.dh.publicKeyB64);
    setPeerKey(id, key);
    entry.secured = true;
    entry.fpr = fingerprint;
    log('dh', `shared key established with ${entry.profile?.name || id.slice(0, 6)}`, { fingerprint });
    renderPeer(id);
  } catch (err) {
    log('dh', `key agreement failed with ${id.slice(0, 6)}: ${err.message}`);
  }
}

async function onSignal(from, data) {
  if (data.dh) { await deriveWithPeer(from, data.dh); return; }

  const entry = peers.get(from);
  if (!entry?.pc) return;
  const pc = entry.pc;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      attachReceiveCiphers(pc, from);
      for (const c of entry.pending.splice(0)) await pc.addIceCandidate(c);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription();
        signal(from, { sdp: pc.localDescription });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else entry.pending.push(data.candidate);
    }
  } catch (err) { log('signal', `signal error: ${err.message}`); }
}

/* ---------- signaling socket ---------- */

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    log('signal', 'connected to signaling server');
    ws.send(JSON.stringify({ type: 'join', profile, muted, encrypted: encrypting }));
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    // Let the admin module handle its own message types first.
    if (adminServerMessage(msg)) return;

    switch (msg.type) {
      case 'welcome': {
        myId = msg.id;
        peers.set(myId, { profile, muted, encrypted: encrypting });
        renderPeer(myId);
        watchSpeaking(myId, localStream);
        setStatus(msg.peers.length ? 'connected' : 'connected — waiting for others', 'live');
        log('system', `joined room with ${msg.peers.length} other(s)`);
        for (const p of msg.peers) connectTo(p.id, p, true);
        break;
      }
      case 'peer-join':
        log('system', `${msg.peer.profile?.name || 'someone'} joined`);
        connectTo(msg.peer.id, msg.peer, false);
        setStatus('connected', 'live');
        break;
      case 'peer-leave':
        log('system', 'a peer left');
        removePeer(msg.id);
        break;
      case 'peer-update': {
        const entry = peers.get(msg.peer.id);
        if (entry) {
          Object.assign(entry, {
            profile: msg.peer.profile,
            muted: msg.peer.muted,
            encrypted: msg.peer.encrypted,
            admin: msg.peer.admin,
            adminName: msg.peer.adminName,
            forcedMuted: msg.peer.forcedMuted,
            spotlight: msg.peer.spotlight,
          });
          renderPeer(msg.peer.id);
          refreshPopover(msg.peer.id);
        }
        break;
      }
      case 'signal':
        await onSignal(msg.from, msg.data);
        break;
      case 'full':
        setStatus(`the channel is full (${msg.max} people)`, 'error');
        break;
      case 'locked':
        setStatus('the room is locked right now', 'error');
        break;
    }
  };

  ws.onclose = () => {
    for (const id of [...peers.keys()]) removePeer(id);
    if (ejected) return; // an admin removed us; don't crawl back in
    setStatus('reconnecting…');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };

  ws.onerror = () => ws.close();
}

function pushUpdate() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'update', profile, muted, encrypted: encrypting }));
  }
  const me = peers.get(myId);
  if (me) { me.profile = profile; me.muted = muted; me.encrypted = encrypting; renderPeer(myId); }
}

/* ---------- controls ---------- */

function setMuted(next) {
  muted = next;
  for (const track of localStream.getAudioTracks()) track.enabled = !muted && !peers.get(myId)?.forcedMuted;
  $('muteIco').textContent = muted ? '🔇' : '🎙️';
  $('muteLabel').textContent = muted ? 'unmute' : 'mute';
  $('muteBtn').classList.toggle('off', muted);
  pushUpdate();
}

function applyForcedMuteToSelf() {
  for (const track of localStream.getAudioTracks()) track.enabled = false;
}

function showUnblock() {
  if (audioBlocked) return;
  audioBlocked = true;
  $('unblock').hidden = false;
}

$('unblock').onclick = async () => {
  await audioCtx?.resume();
  for (const entry of peers.values()) await entry.audioEl?.play().catch(() => {});
  audioBlocked = false;
  $('unblock').hidden = true;
};

$('muteBtn').onclick = () => setMuted(!muted);

function setEncrypting(next) {
  encrypting = next;
  setEncryptionEnabled(encrypting);
  $('encryptBtn').classList.toggle('on', encrypting);
  $('encryptLabel').textContent = encrypting ? 'encryption: on' : 'encryption: off';
  log('dh', `app-layer encryption ${encrypting ? 'enabled' : 'disabled'}`);
  pushUpdate();
}

if (!cipherSupported) {
  $('encryptBtn').disabled = true;
  $('encryptBtn').title = 'This browser has no encoded-transform support';
}
$('encryptBtn').onclick = () => setEncrypting(!encrypting);

$('copyBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $('copyLabel').textContent = 'copied!';
    setTimeout(() => ($('copyLabel').textContent = 'copy link'), 1500);
  } catch { prompt('Copy this link:', location.href); }
};

document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'm' && document.activeElement?.tagName !== 'INPUT'
    && document.activeElement?.tagName !== 'TEXTAREA') setMuted(!muted);
});

/* ---------- profile editor ---------- */

const sheet = $('sheet');

function refreshPreview() {
  paintAvatar($('preview'), profile);
  $('nameInput').value = profile.name;
}

$('editBtn').onclick = () => { refreshPreview(); sheet.hidden = false; $('nameInput').focus(); };
$('doneBtn').onclick = () => {
  profile.name = $('nameInput').value.trim().slice(0, 24) || profile.name;
  sheet.hidden = true;
  saveProfile(profile);
  pushUpdate();
};
sheet.onclick = (e) => { if (e.target === sheet) $('doneBtn').click(); };

$('rerollBtn').onclick = () => {
  profile.emoji = pick(EMOJI.filter((x) => x !== profile.emoji));
  profile.color = pick(COLORS.filter((x) => x !== profile.color));
  profile.avatar = null;
  refreshPreview();
  saveProfile(profile);
  pushUpdate();
};

$('fileInput').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    profile.avatar = await squareThumbnail(file, 192);
    refreshPreview();
    saveProfile(profile);
    pushUpdate();
  } catch { alert("couldn't read that image"); }
  e.target.value = '';
};

function squareThumbnail(file, size) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

/* ---------- peer popover: local volume + admin actions ---------- */

let popoverId = null;

function openPopover(id) {
  const entry = peers.get(id);
  if (!entry) return;
  popoverId = id;
  $('popover').hidden = false; // unhide first so refreshPopover doesn't early-return
  refreshPopover(id);
}

function refreshPopover(id) {
  if (popoverId !== id || $('popover').hidden) return;
  const entry = peers.get(id);
  if (!entry) { closePopover(); return; }
  const name = entry.admin && entry.adminName ? entry.adminName : entry.profile?.name;
  $('popTitle').textContent = name || 'user';
  $('popFpr').textContent = entry.secured ? `secured · ${entry.fpr}` : 'not encrypted yet';

  const vol = $('popVolume');
  vol.hidden = id === myId; // no local volume slider for yourself
  vol.value = Math.round((entry.volume ?? 1) * 100);

  // Admin actions only render for an authenticated admin, and never against another admin.
  const canModerate = isAdmin() && id !== myId && !entry.admin;
  $('popAdmin').hidden = !canModerate;
}

function closePopover() { popoverId = null; $('popover').hidden = true; }

$('popClose').onclick = closePopover;
$('popover').onclick = (e) => { if (e.target === $('popover')) closePopover(); };

$('popVolume').oninput = (e) => {
  const entry = peers.get(popoverId);
  if (!entry) return;
  entry.volume = e.target.value / 100;
  if (entry.audioEl) entry.audioEl.volume = entry.volume;
};

/* ---------- console / debug panel ---------- */

const activeCats = new Set(Object.keys(CATEGORIES));
const logList = $('logList');

function logRow(entry) {
  const row = document.createElement('div');
  row.className = 'logrow';
  row.dataset.cat = entry.category;
  const time = new Date(entry.t).toLocaleTimeString();
  const cat = CATEGORIES[entry.category];
  row.innerHTML = `<span class="logtime">${time}</span>`
    + `<span class="logcat" style="color:${cat.color}">${cat.label}</span>`
    + `<span class="logmsg"></span>`;
  row.querySelector('.logmsg').textContent = entry.message + (entry.data ? `  ${entry.data}` : '');
  row.hidden = !activeCats.has(entry.category);
  return row;
}

function renderLog() {
  logList.innerHTML = '';
  for (const entry of getEntries()) logList.append(logRow(entry));
  logList.scrollTop = logList.scrollHeight;
}

onLog((entry) => {
  if (!entry) { renderLog(); return; }
  if ($('console').hidden) return;
  logList.append(logRow(entry));
  logList.scrollTop = logList.scrollHeight;
});

$('consoleBtn').onclick = () => { renderLog(); $('console').hidden = false; };
$('consoleDone').onclick = () => { $('console').hidden = true; };
$('console').onclick = (e) => { if (e.target === $('console')) $('console').hidden = true; };
$('logClear').onclick = () => clearLog();

// Category filter chips.
$('logChips').innerHTML = Object.entries(CATEGORIES)
  .map(([k, v]) => `<button class="chip on" data-cat="${k}" style="--c:${v.color}">${v.label}</button>`)
  .join('');
$('logChips').onclick = (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  const cat = btn.dataset.cat;
  if (activeCats.has(cat)) { activeCats.delete(cat); btn.classList.remove('on'); }
  else { activeCats.add(cat); btn.classList.add('on'); }
  for (const row of logList.children) row.hidden = !activeCats.has(row.dataset.cat);
};

$('themeSelect').onchange = (e) => applyTheme(e.target.value);

/* ---------- admin wiring ---------- */

initAdmin({
  sendAction: (action, target, extra = {}) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'admin-action', action, target, ...extra }));
  },
  login: (username, password) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'admin-login', username, password }));
  },
  getPeers: () => peers,
  getMyId: () => myId,
  log,
  onKicked: (text) => { ejected = true; setStatus(text || 'you were removed by an admin', 'error'); ws?.close(); },
});

// Admin actions from the peer popover.
$('popAdmin').onclick = (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || popoverId == null) return;
  const action = btn.dataset.action;
  const target = popoverId;
  const send = (extra) => ws?.readyState === WebSocket.OPEN
    && ws.send(JSON.stringify({ type: 'admin-action', action, target, ...(extra || {}) }));

  if (action === 'warn') { const t = prompt('warn message:'); if (t) send({ text: t }); }
  else if (action === 'rename') { const t = prompt('new name:'); if (t != null) send({ text: t }); }
  else if (action === 'mute') { const entry = peers.get(target); send({ value: !entry?.forcedMuted }); }
  else send();
};

/* ---------- boot ---------- */

(async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('this browser cannot do voice chat', 'error');
    return;
  }
  setStatus('asking for your microphone…');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch {
    setStatus('microphone blocked — allow it and reload', 'error');
    return;
  }

  setEncryptionEnabled(encrypting);
  setEncrypting(encrypting);
  log('system', 'Diffie-Hellman ready; each link derives its own key');

  setStatus('connecting…');
  connect();
  for (const evt of ['pointerdown', 'keydown', 'touchstart']) {
    document.addEventListener(evt, () => audioCtx?.resume().catch(() => {}));
  }
})();

window.addEventListener('beforeunload', () => ws?.close());

import {
  cipherSupported,
  forgetPeer,
  installReceiverCipher,
  installSenderCipher,
  pcCipherOptions,
  setEncryptionEnabled,
  setReceiveKey,
  setSendKey,
} from './cipher.js';
import {
  fingerprint,
  loadIdentity,
  newIdentity,
  openSessionKey,
  sealSessionKey,
  validatePrivateKey,
} from './keys.js';

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
const audioBin = $('audio');

let ws = null;
let myId = null;
let localStream = null;
let muted = false;
let encrypting = false;
let reconnectDelay = 1000;

/** Our RSA identity, the AES key it protects, and the envelope peers receive. */
let identity = null;
let sessionKeyRaw = null;
let sessionEnvelope = null;
/** The private key we were given to listen with, if any. */
let listenKey = localStorage.getItem('vc-listen-key') || '';
let audioBlocked = false;

/** id -> { pc, profile, muted, card, stream, meter } */
const peers = new Map();

/* ---------- profile (browser-local, no account) ---------- */

function randomProfile() {
  return {
    name: `${pick(ADJECTIVES)}-${pick(NOUNS)}`,
    emoji: pick(EMOJI),
    color: pick(COLORS),
    avatar: null,
  };
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem('vc-profile'));
    if (saved && saved.name) return { avatar: null, ...saved };
  } catch { /* fall through to a fresh identity */ }
  const fresh = randomProfile();
  saveProfile(fresh);
  return fresh;
}

function saveProfile(p) {
  try {
    localStorage.setItem('vc-profile', JSON.stringify(p));
  } catch { /* private mode: identity just lasts for this tab */ }
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
  let entry = peers.get(id);
  if (!entry.card) {
    const li = document.createElement('li');
    li.className = 'peer';
    li.innerHTML = '<div class="avatar"></div><div class="name"></div>';
    if (id === myId) li.classList.add('me');
    entry.card = li;
    // Keep yourself first in the grid so the room reads consistently.
    if (id === myId) grid.prepend(li);
    else grid.append(li);
  }
  return entry.card;
}

function renderPeer(id) {
  const entry = peers.get(id);
  if (!entry) return;
  const card = cardFor(id);
  paintAvatar(card.querySelector('.avatar'), entry.profile);
  card.querySelector('.name').textContent = entry.profile.name;
  card.classList.toggle('muted', !!entry.muted);
  card.classList.toggle('encrypted', !!entry.encrypted);
  card.classList.toggle('unlocked', !!entry.encrypted && !!entry.decrypting);
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
  peers.delete(id);
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
  // Autoplay policy can hand back a suspended context; without this the analysers read silence.
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
    for (const v of buf) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / buf.length);
    if (rms > 0.045) {
      quietFrames = 0;
      if (!speaking) onSpeaking((speaking = true));
    } else if (speaking && ++quietFrames > 6) {
      onSpeaking((speaking = false));
    }
  };
  // A timer rather than rAF: rAF stops in background tabs and would freeze the indicator.
  const timer = setInterval(tick, 60);

  return {
    stop() {
      clearInterval(timer);
      try { source.disconnect(); } catch { /* already torn down */ }
    },
  };
}

function watchSpeaking(id, stream) {
  const entry = peers.get(id);
  entry.meter?.stop();
  entry.meter = meterFor(stream, (on) => {
    const card = peers.get(id)?.card;
    if (card) card.classList.toggle('speaking', on && !peers.get(id).muted);
  });
}

/* ---------- WebRTC mesh ---------- */

function signal(to, data) {
  ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'signal', to, data }));
}

function connectTo(id, peer, initiator) {
  const pc = new RTCPeerConnection({ ...ICE, ...pcCipherOptions() });
  peers.set(id, { ...peer, pc, pending: [] });

  for (const track of localStream.getTracks()) {
    installSenderCipher(pc.addTrack(track, localStream));
  }
  // A decrypt transform attached in ontrack is too late — Chrome never routes
  // frames through it. Attach as soon as the transceiver exists instead.
  attachReceiveCiphers(pc, id);

  pc.onicecandidate = (e) => {
    if (e.candidate) signal(id, { candidate: e.candidate });
  };

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
    entry.audioEl?.remove();
    entry.audioEl = el;
    audioBin.append(el);
    el.play().catch(() => showUnblock());

    watchSpeaking(id, stream);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
  };

  if (initiator) {
    pc.onnegotiationneeded = async () => {
      try {
        await pc.setLocalDescription();
        signal(id, { sdp: pc.localDescription });
      } catch (err) {
        console.warn('negotiation failed', err);
      }
    };
  }

  applyEnvelope(id, peer.envelope);
  renderPeer(id);
  return pc;
}

/** Attach the decrypt transform to every audio receiver we know about yet. */
function attachReceiveCiphers(pc, id) {
  for (const tx of pc.getTransceivers()) {
    if (tx.receiver) installReceiverCipher(tx.receiver, id);
  }
}

/** Try the key we were given against a peer's sealed session key. */
async function applyEnvelope(id, envelope) {
  const entry = peers.get(id);
  if (!entry) return;
  entry.envelope = envelope || null;

  const raw = envelope && listenKey ? await openSessionKey(envelope, listenKey) : null;
  entry.decrypting = !!raw;
  await setReceiveKey(id, raw);
  renderPeer(id);
}

async function refreshAllEnvelopes() {
  for (const [id, entry] of peers) {
    if (id !== myId) await applyEnvelope(id, entry.envelope);
  }
  updateKeyStatus();
}

async function onSignal(from, data) {
  const entry = peers.get(from);
  if (!entry?.pc) return;
  const pc = entry.pc;

  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      // The answering side's transceivers only exist now; attach before media flows.
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
  } catch (err) {
    console.warn('signal error', err);
  }
}

/* ---------- signaling socket ---------- */

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    ws.send(JSON.stringify({
      type: 'join', profile, muted, encrypted: encrypting, envelope: sessionEnvelope,
    }));
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'welcome': {
        myId = msg.id;
        peers.set(myId, { profile, muted, encrypted: encrypting });
        renderPeer(myId);
        watchSpeaking(myId, localStream);
        setStatus(msg.peers.length ? 'connected' : 'connected — waiting for others', 'live');
        // We just arrived, so we dial everyone already in the room.
        for (const p of msg.peers) connectTo(p.id, p, true);
        updateKeyStatus();
        break;
      }
      case 'peer-join':
        // They will dial us; just hold a connection ready to answer.
        connectTo(msg.peer.id, msg.peer, false);
        setStatus('connected', 'live');
        updateKeyStatus();
        break;
      case 'peer-leave':
        removePeer(msg.id);
        break;
      case 'peer-update': {
        const entry = peers.get(msg.peer.id);
        if (entry) {
          entry.profile = msg.peer.profile;
          entry.muted = msg.peer.muted;
          entry.encrypted = msg.peer.encrypted;
          await applyEnvelope(msg.peer.id, msg.peer.envelope);
          renderPeer(msg.peer.id);
        }
        break;
      }
      case 'signal':
        await onSignal(msg.from, msg.data);
        break;
      case 'full':
        setStatus(`the channel is full (${msg.max} people)`, 'error');
        break;
    }
  };

  ws.onclose = () => {
    for (const id of [...peers.keys()]) removePeer(id);
    setStatus('reconnecting…');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };

  ws.onerror = () => ws.close();
}

function pushUpdate() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'update', profile, muted, encrypted: encrypting, envelope: sessionEnvelope,
    }));
  }
  const me = peers.get(myId);
  if (me) {
    me.profile = profile;
    me.muted = muted;
    me.encrypted = encrypting;
    renderPeer(myId);
  }
}

/* ---------- controls ---------- */

function setMuted(next) {
  muted = next;
  for (const track of localStream.getAudioTracks()) track.enabled = !muted;
  $('muteIco').textContent = muted ? '🔇' : '🎙️';
  $('muteLabel').textContent = muted ? 'unmute' : 'mute';
  $('muteBtn').classList.toggle('off', muted);
  pushUpdate();
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

/* Encryption. Off by default. When on, outgoing audio is AES-GCM encrypted under
   a session key that RSA-OAEP seals to our identity; only listeners holding our
   private key can open it. Everyone else hears static. */
function setEncrypting(next) {
  encrypting = next;
  setEncryptionEnabled(encrypting);
  $('encryptBtn').classList.toggle('on', encrypting);
  $('encryptLabel').textContent = encrypting ? 'encryption: on' : 'encryption: off';
  $('encryptNote').hidden = !encrypting;
  pushUpdate();
}

if (!cipherSupported) {
  $('encryptBtn').disabled = true;
  $('encryptBtn').title = 'This browser has no encoded-transform support';
}

$('encryptBtn').onclick = () => setEncrypting(!encrypting);

/* key panel */

const keySheet = $('keySheet');

function updateKeyStatus() {
  const heard = [...peers].filter(([id, p]) => id !== myId && p.encrypted).length;
  const open = [...peers].filter(([id, p]) => id !== myId && p.encrypted && p.decrypting).length;
  const el = $('keyStatus');

  if (!listenKey) {
    el.textContent = heard
      ? `${heard} encrypted ${heard === 1 ? 'person' : 'people'} in the room — paste their key to hear them`
      : 'no key set — encrypted people will sound like static';
    el.className = 'key-status';
  } else if (!heard) {
    el.textContent = 'key loaded — nobody is encrypting right now';
    el.className = 'key-status ok';
  } else {
    el.textContent = `key opens ${open} of ${heard} encrypted ${heard === 1 ? 'stream' : 'streams'}`;
    el.className = open ? 'key-status ok' : 'key-status bad';
  }
}

async function showIdentity() {
  $('myKey').value = identity.privateKey;
  $('myKeyPrint').textContent = await fingerprint(identity.publicKey);
  $('listenInput').value = listenKey;
  updateKeyStatus();
}

$('keyBtn').onclick = async () => {
  await showIdentity();
  keySheet.hidden = false;
};

$('keyDoneBtn').onclick = () => { keySheet.hidden = true; };
keySheet.onclick = (e) => { if (e.target === keySheet) keySheet.hidden = true; };

$('copyKeyBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(identity.privateKey);
    $('copyKeyLabel').textContent = 'copied!';
  } catch {
    $('myKey').select();
    $('copyKeyLabel').textContent = 'press Ctrl+C';
  }
  setTimeout(() => ($('copyKeyLabel').textContent = 'copy key'), 1800);
};

$('newKeyBtn').onclick = async () => {
  identity = await newIdentity();
  await rotateSessionKey();
  await showIdentity();
  pushUpdate();
};

$('listenBtn').onclick = async () => {
  const text = $('listenInput').value.trim();
  if (text && !(await validatePrivateKey(text))) {
    $('keyStatus').textContent = "that doesn't look like an RSA private key";
    $('keyStatus').className = 'key-status bad';
    return;
  }
  listenKey = text;
  try {
    localStorage.setItem('vc-listen-key', listenKey);
  } catch { /* not persisted */ }
  await refreshAllEnvelopes();
};

$('clearListenBtn').onclick = async () => {
  listenKey = '';
  $('listenInput').value = '';
  localStorage.removeItem('vc-listen-key');
  await refreshAllEnvelopes();
};

/** New AES session key, sealed to our own public key for listeners to open. */
async function rotateSessionKey() {
  sessionKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  sessionEnvelope = await sealSessionKey(sessionKeyRaw, identity.publicKey);
  await setSendKey(sessionKeyRaw);
}

document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'm' && !$('sheet').contains(document.activeElement)) {
    if (document.activeElement?.tagName !== 'INPUT') setMuted(!muted);
  }
});

$('copyBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $('copyLabel').textContent = 'copied!';
    setTimeout(() => ($('copyLabel').textContent = 'copy link'), 1500);
  } catch {
    prompt('Copy this link:', location.href);
  }
};

/* profile editor */

const sheet = $('sheet');

function refreshPreview() {
  paintAvatar($('preview'), profile);
  $('nameInput').value = profile.name;
}

$('editBtn').onclick = () => {
  refreshPreview();
  sheet.hidden = false;
  $('nameInput').focus();
};

$('doneBtn').onclick = () => {
  profile.name = $('nameInput').value.trim().slice(0, 24) || profile.name;
  sheet.hidden = true;
  saveProfile(profile);
  pushUpdate();
};

sheet.onclick = (e) => {
  if (e.target === sheet) $('doneBtn').click();
};

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
  } catch {
    alert("couldn't read that image");
  }
  e.target.value = '';
};

// Downscale to a small square so avatars stay well under the signaling size limit.
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
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('bad image'));
    };
    img.src = url;
  });
}

/* ---------- boot: join the one channel on load ---------- */

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
  setStatus('preparing keys…');
  identity = await loadIdentity();
  await rotateSessionKey();

  setStatus('connecting…');
  connect();
  // Any interaction is a chance to un-suspend audio if the browser held it back.
  for (const evt of ['pointerdown', 'keydown', 'touchstart']) {
    document.addEventListener(evt, () => audioCtx?.resume().catch(() => {}));
  }
})();

window.addEventListener('beforeunload', () => ws?.close());

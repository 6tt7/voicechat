import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
// Mesh WebRTC means every peer connects to every other peer, so keep the room small.
const MAX_PEERS = Number(process.env.MAX_PEERS || 12);

/* ---------------------------------------------------------------------------
 * Admin credentials.
 *
 * Passwords are NEVER stored in plaintext. Each entry is "salt:scryptHash".
 * Multiple usernames can map to admin — they all grant the same powers.
 *
 * Override in production by setting ADMIN_ACCOUNTS to a JSON array of
 * { "username", "cred" } objects (generate `cred` with scrypt, 32-byte hash).
 * The defaults below are the two logins configured for this deployment.
 * ------------------------------------------------------------------------- */
const DEFAULT_ADMINS = [
  { username: 'ttpizza', cred: '59f674296f9c16d54185fbf400b60247:5004fb778856102ad071ca8834a80e97e52c01328a4e6bb0a6d376e182904ce7' },
  { username: 'shadow', cred: 'fd4243b0b03b2f30eb9c5598c6ef53d7:729b93dce92c92c65c47fdcd359804cd07ebc1212fc962520c8b2f1997a33c2c' },
];

function loadAdmins() {
  if (process.env.ADMIN_ACCOUNTS) {
    try {
      const parsed = JSON.parse(process.env.ADMIN_ACCOUNTS);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      console.warn('ADMIN_ACCOUNTS is not valid JSON; falling back to defaults');
    }
  }
  return DEFAULT_ADMINS;
}
const ADMINS = loadAdmins();

function verifyAdmin(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  for (const acc of ADMINS) {
    if (acc.username !== username) continue;
    const [salt, hashHex] = String(acc.cred).split(':');
    if (!salt || !hashHex) continue;
    const expected = Buffer.from(hashHex, 'hex');
    let actual;
    try {
      actual = scryptSync(password, salt, expected.length);
    } catch {
      return null;
    }
    // Constant-time compare so a wrong password can't be timed byte by byte.
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      return acc.username;
    }
  }
  return null;
}

/* ---------- login throttling: slow down brute force per IP ---------- */
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX = 6;
const loginHits = new Map(); // ip -> { count, resetAt }

function loginAllowed(ip) {
  const now = Date.now();
  const rec = loginHits.get(ip);
  if (!rec || now > rec.resetAt) {
    loginHits.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  rec.count += 1;
  return rec.count <= LOGIN_MAX;
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
// 512KB is plenty for SDP plus a downscaled avatar data URL.
const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });

/** The single channel. id -> peer record. */
const peers = new Map();
/** IP addresses an admin has banned this run. */
const bannedIps = new Set();
/** Whether new joins are blocked (admin room lock). */
let roomLocked = false;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, exceptId) {
  for (const [id, peer] of peers) {
    if (id !== exceptId) send(peer.ws, msg);
  }
}

function publicPeer(id) {
  const peer = peers.get(id);
  return {
    id,
    profile: peer.profile,
    muted: peer.muted,
    encrypted: peer.encrypted,
    // Server-authoritative moderation/status flags:
    admin: peer.isAdmin,
    adminName: peer.isAdmin ? peer.adminName : null,
    forcedMuted: peer.forcedMuted,
    spotlight: peer.spotlight,
  };
}

function sanitizeText(text, max) {
  return typeof text === 'string' ? text.slice(0, max) : '';
}

function sanitizeProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const name = typeof p.name === 'string' ? p.name.trim().slice(0, 24) : '';
  const avatar = typeof p.avatar === 'string' && p.avatar.startsWith('data:image/')
    ? p.avatar.slice(0, 400_000)
    : null;
  const color = typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#8b8bff';
  const emoji = typeof p.emoji === 'string' ? [...p.emoji].slice(0, 2).join('') : '';
  return { name: name || 'guest', avatar, color, emoji };
}

/* ---------- admin actions (all require an authenticated admin socket) ---------- */

function handleAdminAction(actorId, msg) {
  const actor = peers.get(actorId);
  if (!actor?.isAdmin) return; // authorization: only real admins act

  const action = msg.action;
  const target = typeof msg.target === 'string' ? peers.get(msg.target) : null;
  const log = (detail) => broadcast({ type: 'admin-log', by: actor.adminName, action, detail });

  switch (action) {
    case 'kick': {
      if (!target) return;
      send(target.ws, { type: 'kicked', by: actor.adminName, reason: sanitizeText(msg.text, 200) });
      log(`kicked ${target.profile.name}`);
      target.ws.close();
      break;
    }
    case 'ban': {
      if (!target) return;
      bannedIps.add(target.ip);
      send(target.ws, { type: 'banned', by: actor.adminName });
      log(`banned ${target.profile.name}`);
      target.ws.close();
      break;
    }
    case 'warn': {
      if (!target) return;
      send(target.ws, { type: 'warn', by: actor.adminName, text: sanitizeText(msg.text, 500) });
      break;
    }
    case 'announce': {
      broadcast({ type: 'announce', by: actor.adminName, text: sanitizeText(msg.text, 500) });
      break;
    }
    case 'rename': {
      if (!target) return;
      target.profile = { ...target.profile, name: sanitizeText(msg.text, 24).trim() || 'guest' };
      broadcast({ type: 'peer-update', peer: publicPeer(target === actor ? actorId : msg.target) });
      log(`renamed a user`);
      break;
    }
    case 'reset-avatar': {
      // Moderation: strip an inappropriate uploaded picture back to a default.
      if (!target) return;
      target.profile = { ...target.profile, avatar: null };
      broadcast({ type: 'peer-update', peer: publicPeer(msg.target) });
      log(`reset an avatar`);
      break;
    }
    case 'mute': {
      // Force-mute: honest clients stop playing this user and disable their mic.
      if (!target) return;
      target.forcedMuted = !!msg.value;
      send(target.ws, { type: 'force-mute', value: target.forcedMuted, by: actor.adminName });
      broadcast({ type: 'peer-update', peer: publicPeer(msg.target) });
      log(`${target.forcedMuted ? 'muted' : 'unmuted'} ${target.profile.name}`);
      break;
    }
    case 'spotlight': {
      for (const [, p] of peers) p.spotlight = false;
      if (target) target.spotlight = true;
      for (const [pid] of peers) broadcast({ type: 'peer-update', peer: publicPeer(pid) });
      break;
    }
    case 'confetti': {
      broadcast({ type: 'confetti', by: actor.adminName });
      break;
    }
    case 'lock': {
      roomLocked = !!msg.value;
      broadcast({ type: 'announce', by: actor.adminName, text: roomLocked ? 'room locked' : 'room unlocked' });
      break;
    }
  }
}

wss.on('connection', (ws, req) => {
  const id = randomUUID();
  const ip = clientIp(req);
  let joined = false;

  if (bannedIps.has(ip)) {
    send(ws, { type: 'banned' });
    ws.close();
    return;
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'join': {
        if (joined) return;
        if (roomLocked) {
          send(ws, { type: 'locked' });
          ws.close();
          return;
        }
        if (peers.size >= MAX_PEERS) {
          send(ws, { type: 'full', max: MAX_PEERS });
          ws.close();
          return;
        }
        joined = true;
        peers.set(id, {
          ws,
          ip,
          profile: sanitizeProfile(msg.profile),
          muted: !!msg.muted,
          encrypted: !!msg.encrypted,
          isAdmin: false,
          adminName: null,
          forcedMuted: false,
          spotlight: false,
        });
        send(ws, {
          type: 'welcome',
          id,
          peers: [...peers.keys()].filter((p) => p !== id).map(publicPeer),
        });
        broadcast({ type: 'peer-join', peer: publicPeer(id) }, id);
        break;
      }

      case 'signal': {
        // Relays SDP, ICE, and ECDH public keys between two peers untouched.
        if (!joined || typeof msg.to !== 'string') return;
        const targetPeer = peers.get(msg.to);
        if (targetPeer) send(targetPeer.ws, { type: 'signal', from: id, data: msg.data });
        break;
      }

      case 'update': {
        if (!joined) return;
        const peer = peers.get(id);
        if (msg.profile) peer.profile = sanitizeProfile(msg.profile);
        if (typeof msg.muted === 'boolean') peer.muted = msg.muted;
        if (typeof msg.encrypted === 'boolean') peer.encrypted = msg.encrypted;
        broadcast({ type: 'peer-update', peer: publicPeer(id) }, id);
        break;
      }

      case 'admin-login': {
        if (!joined) return;
        if (!loginAllowed(ip)) {
          send(ws, { type: 'admin-login-result', ok: false, reason: 'too many attempts, wait a minute' });
          return;
        }
        const who = verifyAdmin(msg.username, msg.password);
        if (!who) {
          send(ws, { type: 'admin-login-result', ok: false, reason: 'wrong username or password' });
          return;
        }
        const peer = peers.get(id);
        peer.isAdmin = true;
        peer.adminName = who;
        send(ws, { type: 'admin-login-result', ok: true, adminName: who });
        broadcast({ type: 'peer-update', peer: publicPeer(id) });
        break;
      }

      case 'admin-action': {
        if (!joined) return;
        handleAdminAction(id, msg);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (peers.delete(id)) broadcast({ type: 'peer-leave', id });
  });
});

// Drop connections that stopped answering so the roster does not fill with ghosts.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`voice channel live on http://localhost:${PORT}`);
});

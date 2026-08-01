import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const DEFAULT_ADMINS = [
  { username: 'ttpizza', cred: '59f674296f9c16d54185fbf400b60247:5004fb778856102ad071ca8834a80e97e52c01328a4e6bb0a6d376e182904ce7' },
  { username: 'shadow', cred: 'fd4243b0b03b2f30eb9c5598c6ef53d7:729b93dce92c92c65c47fdcd359804cd07ebc1212fc962520c8b2f1997a33c2c' },
];

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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

function verifyAdmin(username, password, accounts) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  for (const account of accounts) {
    if (account.username !== username) continue;
    const [salt, hashHex] = String(account.cred).split(':');
    if (!salt || !hashHex) continue;
    const expected = Buffer.from(hashHex, 'hex');
    let actual;
    try {
      actual = scryptSync(password, salt, expected.length);
    } catch {
      return null;
    }
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      return account.username;
    }
  }
  return null;
}

export function sanitizeProfile(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const name = typeof source.name === 'string' ? source.name.trim().slice(0, 24) : '';
  const avatar = typeof source.avatar === 'string' && source.avatar.startsWith('data:image/')
    ? source.avatar.slice(0, 400_000)
    : null;
  const color = typeof source.color === 'string' && /^#[0-9a-f]{6}$/i.test(source.color)
    ? source.color
    : '#46d39a';
  const emoji = typeof source.emoji === 'string' ? [...source.emoji].slice(0, 2).join('') : '';
  return { name: name || 'guest', avatar, color, emoji };
}

function sanitizeText(text, max) {
  return typeof text === 'string' ? text.slice(0, max) : '';
}

export function createVoiceChatServer({
  maxPeers = positiveInteger(process.env.MAX_PEERS, 12),
  publicDir = path.join(dirname, 'public'),
  heartbeatMs = 30_000,
  adminAccounts = loadAdmins(),
} = {}) {
  maxPeers = positiveInteger(maxPeers, 12);

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "worker-src 'self'",
        "connect-src 'self' ws: wss:",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "style-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
      'Permissions-Policy': 'microphone=(self)',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  });
  app.use(express.static(publicDir));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });
  const peers = new Map();
  const bannedIps = new Set();
  const loginHits = new Map();
  let roomLocked = false;

  const clientIp = (request) => {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
    return request.socket.remoteAddress || 'unknown';
  };

  const send = (socket, message) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  };

  const broadcast = (message, exceptId) => {
    for (const [id, peer] of peers) {
      if (id !== exceptId) send(peer.ws, message);
    }
  };

  const publicPeer = (id) => {
    const peer = peers.get(id);
    return {
      id,
      profile: peer.profile,
      muted: peer.muted,
      encrypted: peer.encrypted,
      admin: peer.isAdmin,
      adminName: peer.isAdmin ? peer.adminName : null,
      forcedMuted: peer.forcedMuted,
      spotlight: peer.spotlight,
    };
  };

  const loginAllowed = (ip) => {
    const now = Date.now();
    const hit = loginHits.get(ip);
    if (!hit || now > hit.resetAt) {
      loginHits.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    hit.count += 1;
    return hit.count <= 6;
  };

  const handleAdminAction = (actorId, message) => {
    const actor = peers.get(actorId);
    if (!actor?.isAdmin) return;
    const action = message.action;
    const target = typeof message.target === 'string' ? peers.get(message.target) : null;
    const audit = (detail) => broadcast({
      type: 'admin-log', by: actor.adminName, action, detail,
    });

    switch (action) {
      case 'kick':
        if (target) {
          send(target.ws, {
            type: 'kicked', by: actor.adminName, reason: sanitizeText(message.text, 200),
          });
          audit(`kicked ${target.profile.name}`);
          target.ws.close();
        }
        break;
      case 'ban':
        if (target) {
          bannedIps.add(target.ip);
          send(target.ws, { type: 'banned', by: actor.adminName });
          audit(`banned ${target.profile.name}`);
          target.ws.close();
        }
        break;
      case 'warn':
        if (target) send(target.ws, {
          type: 'warn', by: actor.adminName, text: sanitizeText(message.text, 500),
        });
        break;
      case 'announce':
        broadcast({
          type: 'announce', by: actor.adminName, text: sanitizeText(message.text, 500),
        });
        break;
      case 'rename':
        if (target) {
          target.profile = {
            ...target.profile,
            name: sanitizeText(message.text, 24).trim() || 'guest',
          };
          broadcast({ type: 'peer-update', peer: publicPeer(message.target) });
          audit('renamed a user');
        }
        break;
      case 'reset-avatar':
        if (target) {
          target.profile = { ...target.profile, avatar: null };
          broadcast({ type: 'peer-update', peer: publicPeer(message.target) });
          audit('reset an avatar');
        }
        break;
      case 'mute':
        if (target) {
          target.forcedMuted = !!message.value;
          send(target.ws, {
            type: 'force-mute', value: target.forcedMuted, by: actor.adminName,
          });
          broadcast({ type: 'peer-update', peer: publicPeer(message.target) });
          audit(`${target.forcedMuted ? 'muted' : 'unmuted'} ${target.profile.name}`);
        }
        break;
      case 'spotlight':
        for (const peer of peers.values()) peer.spotlight = false;
        if (target) target.spotlight = true;
        for (const [id] of peers) broadcast({ type: 'peer-update', peer: publicPeer(id) });
        break;
      case 'confetti':
        broadcast({ type: 'confetti', by: actor.adminName });
        break;
      case 'lock':
        roomLocked = !!message.value;
        broadcast({
          type: 'announce',
          by: actor.adminName,
          text: roomLocked ? 'room locked' : 'room unlocked',
        });
        break;
    }
  };

  wss.on('connection', (socket, request) => {
    const id = randomUUID();
    const ip = clientIp(request);
    let joined = false;

    if (bannedIps.has(ip)) {
      send(socket, { type: 'banned' });
      socket.close();
      return;
    }

    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (!message || typeof message.type !== 'string') return;

      switch (message.type) {
        case 'join': {
          if (joined) return;
          if (roomLocked) {
            send(socket, { type: 'locked' });
            socket.close();
            return;
          }
          if (peers.size >= maxPeers) {
            send(socket, { type: 'full', max: maxPeers });
            socket.close();
            return;
          }
          joined = true;
          peers.set(id, {
            ws: socket,
            ip,
            profile: sanitizeProfile(message.profile),
            muted: !!message.muted,
            encrypted: message.encrypted !== false,
            isAdmin: false,
            adminName: null,
            forcedMuted: false,
            spotlight: false,
          });
          send(socket, {
            type: 'welcome',
            id,
            peers: [...peers.keys()].filter((peerId) => peerId !== id).map(publicPeer),
          });
          broadcast({ type: 'peer-join', peer: publicPeer(id) }, id);
          break;
        }
        case 'signal': {
          if (!joined || typeof message.to !== 'string') return;
          const target = peers.get(message.to);
          if (target) send(target.ws, { type: 'signal', from: id, data: message.data });
          break;
        }
        case 'update': {
          if (!joined) return;
          const peer = peers.get(id);
          if (message.profile) peer.profile = sanitizeProfile(message.profile);
          if (typeof message.muted === 'boolean') peer.muted = message.muted;
          if (typeof message.encrypted === 'boolean') peer.encrypted = message.encrypted;
          broadcast({ type: 'peer-update', peer: publicPeer(id) }, id);
          break;
        }
        case 'admin-login': {
          if (!joined) return;
          if (!loginAllowed(ip)) {
            send(socket, {
              type: 'admin-login-result', ok: false, reason: 'too many attempts, wait a minute',
            });
            return;
          }
          const adminName = verifyAdmin(message.username, message.password, adminAccounts);
          if (!adminName) {
            send(socket, {
              type: 'admin-login-result', ok: false, reason: 'wrong username or password',
            });
            return;
          }
          const peer = peers.get(id);
          peer.isAdmin = true;
          peer.adminName = adminName;
          send(socket, { type: 'admin-login-result', ok: true, adminName });
          broadcast({ type: 'peer-update', peer: publicPeer(id) });
          break;
        }
        case 'admin-action':
          if (joined) handleAdminAction(id, message);
          break;
      }
    });

    socket.on('close', () => {
      if (peers.delete(id)) broadcast({ type: 'peer-leave', id });
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  async function close() {
    clearInterval(heartbeat);
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  return { app, server, wss, peers, bannedIps, close };
}

export function startVoiceChatServer({
  port = process.env.PORT || 3000,
  maxPeers = process.env.MAX_PEERS || 12,
} = {}) {
  const voiceChat = createVoiceChatServer({ maxPeers });
  voiceChat.server.listen(port, () => {
    const address = voiceChat.server.address();
    const actualPort = typeof address === 'object' ? address.port : port;
    console.log(`voice channel live on http://localhost:${actualPort}`);
  });
  return voiceChat;
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  startVoiceChatServer();
}

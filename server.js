import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function sanitizeProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const name = typeof p.name === 'string' ? p.name.trim().slice(0, 24) : '';
  const avatar = typeof p.avatar === 'string' && p.avatar.startsWith('data:image/')
    ? p.avatar.slice(0, 400_000)
    : null;
  const color = typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#46d39a';
  const emoji = typeof p.emoji === 'string' ? [...p.emoji].slice(0, 2).join('') : '';
  return { name: name || 'guest', avatar, color, emoji };
}

export function sanitizeEnvelope(envelope) {
  return typeof envelope === 'string' && envelope.length <= 1024 ? envelope : null;
}

export function createVoiceChatServer({
  maxPeers = positiveInteger(process.env.MAX_PEERS, 12),
  publicDir = path.join(dirname, 'public'),
  heartbeatMs = 30_000,
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
  // 512KB is plenty for SDP plus a downscaled avatar data URL.
  const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });

  /** The single channel. id -> { ws, profile, muted, encrypted, envelope } */
  const peers = new Map();

  function send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
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
      // The server can relay this RSA-OAEP envelope but cannot open it.
      envelope: peer.envelope,
    };
  }

  wss.on('connection', (ws) => {
    const id = randomUUID();
    let joined = false;
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
          if (peers.size >= maxPeers) {
            send(ws, { type: 'full', max: maxPeers });
            ws.close();
            return;
          }
          joined = true;
          peers.set(id, {
            ws,
            profile: sanitizeProfile(msg.profile),
            muted: !!msg.muted,
            encrypted: !!msg.encrypted,
            envelope: sanitizeEnvelope(msg.envelope),
          });
          // The newcomer gets the roster and is the one who dials everyone already here.
          send(ws, {
            type: 'welcome',
            id,
            peers: [...peers.keys()].filter((peerId) => peerId !== id).map(publicPeer),
          });
          broadcast({ type: 'peer-join', peer: publicPeer(id) }, id);
          break;
        }

        case 'signal': {
          if (!joined || typeof msg.to !== 'string') return;
          const target = peers.get(msg.to);
          if (target) send(target.ws, { type: 'signal', from: id, data: msg.data });
          break;
        }

        case 'update': {
          if (!joined) return;
          const peer = peers.get(id);
          if (msg.profile) peer.profile = sanitizeProfile(msg.profile);
          if (typeof msg.muted === 'boolean') peer.muted = msg.muted;
          if (typeof msg.encrypted === 'boolean') peer.encrypted = msg.encrypted;
          if ('envelope' in msg) peer.envelope = sanitizeEnvelope(msg.envelope);
          broadcast({ type: 'peer-update', peer: publicPeer(id) }, id);
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
  }, heartbeatMs);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  async function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  return { app, server, wss, peers, close };
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

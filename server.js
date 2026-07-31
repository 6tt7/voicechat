import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
// Mesh WebRTC means every peer connects to every other peer, so keep the room small.
const MAX_PEERS = Number(process.env.MAX_PEERS || 12);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
// 512KB is plenty for SDP plus a downscaled avatar data URL.
const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });

/** The single channel. id -> { ws, profile, muted } */
const peers = new Map();

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
  return { id, profile: peer.profile, muted: peer.muted, scrambled: peer.scrambled };
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
        if (peers.size >= MAX_PEERS) {
          send(ws, { type: 'full', max: MAX_PEERS });
          ws.close();
          return;
        }
        joined = true;
        peers.set(id, {
          ws,
          profile: sanitizeProfile(msg.profile),
          muted: !!msg.muted,
          scrambled: !!msg.scrambled,
        });
        // The newcomer gets the roster and is the one who dials everyone already here.
        send(ws, {
          type: 'welcome',
          id,
          peers: [...peers.keys()].filter((p) => p !== id).map(publicPeer),
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
        if (typeof msg.scrambled === 'boolean') peer.scrambled = msg.scrambled;
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
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`voice channel live on http://localhost:${PORT}`);
});

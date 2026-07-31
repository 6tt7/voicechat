import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createVoiceChatServer, sanitizeProfile } from '../server.js';

class TestClient {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      const waiterIndex = this.waiters.findIndex(({ type }) => !type || type === message.type);
      if (waiterIndex >= 0) {
        const [{ resolve, timer }] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(timer);
        resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  next(type) {
    const queuedIndex = this.messages.findIndex((message) => !type || message.type === type);
    if (queuedIndex >= 0) return Promise.resolve(this.messages.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${type || 'a message'}`));
      }, 2_000);
      this.waiters.push({ type, resolve, timer });
    });
  }

  close() {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return new TestClient(socket);
}

async function startServer(maxPeers = 4) {
  const voiceChat = createVoiceChatServer({ maxPeers, heartbeatMs: 60_000 });
  await new Promise((resolve) => voiceChat.server.listen(0, '127.0.0.1', resolve));
  const { port } = voiceChat.server.address();
  return { ...voiceChat, httpUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` };
}

test('sanitizeProfile applies public profile limits and defaults', () => {
  const profile = sanitizeProfile({
    name: `  ${'a'.repeat(40)}  `,
    avatar: 'https://example.com/not-a-data-url.png',
    color: 'red',
    emoji: '🐸extra',
  });

  assert.equal(profile.name, 'a'.repeat(24));
  assert.equal(profile.avatar, null);
  assert.equal(profile.color, '#46d39a');
  assert.equal(profile.emoji, '🐸e');
  assert.equal(sanitizeProfile(null).name, 'guest');
});

test('serves the WebAssembly client and redesigned shell', async (t) => {
  const voiceChat = await startServer();
  t.after(() => voiceChat.close());

  const page = await fetch(voiceChat.httpUrl);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-powered-by'), null);
  assert.equal(page.headers.get('permissions-policy'), 'microphone=(self)');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(page.headers.get('content-security-policy'), /worker-src 'self'/);
  const html = await page.text();
  assert.match(html, /One room\. Zero friction\./);
  assert.match(html, /boot\.js/);

  const wasm = await fetch(`${voiceChat.httpUrl}/voicechat-runtime.wasm`);
  assert.equal(wasm.status, 200);
  assert.match(wasm.headers.get('content-type'), /application\/wasm/);
  assert.ok((await wasm.arrayBuffer()).byteLength > 1_000);

  const cipher = await fetch(`${voiceChat.httpUrl}/voice-cipher.js`);
  assert.equal(cipher.status, 200);
  assert.match(await cipher.text(), /AES-CTR/);
});

test('joins peers, sanitizes updates, relays signaling, and announces departures', async (t) => {
  const voiceChat = await startServer();
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await voiceChat.close();
  });

  const first = await connect(voiceChat.wsUrl);
  clients.push(first);
  first.send({
    type: 'join',
    profile: { name: 'first', color: '#112233', emoji: '🦊' },
    muted: false,
  });
  const firstWelcome = await first.next('welcome');
  assert.equal(firstWelcome.peers.length, 0);

  const second = await connect(voiceChat.wsUrl);
  clients.push(second);
  second.send({
    type: 'join',
    profile: { name: 'second', color: '#445566', emoji: '🐸' },
    muted: true,
    scrambled: true,
  });
  const secondWelcome = await second.next('welcome');
  assert.equal(secondWelcome.peers.length, 1);
  assert.equal(secondWelcome.peers[0].id, firstWelcome.id);
  const secondJoin = await first.next('peer-join');
  assert.equal(secondJoin.peer.id, secondWelcome.id);
  assert.equal(secondJoin.peer.scrambled, true);

  second.send({
    type: 'update',
    profile: { name: '  renamed  ', color: 'invalid', emoji: '🐙' },
    muted: false,
    scrambled: false,
  });
  const update = await first.next('peer-update');
  assert.equal(update.peer.profile.name, 'renamed');
  assert.equal(update.peer.profile.color, '#46d39a');
  assert.equal(update.peer.muted, false);
  assert.equal(update.peer.scrambled, false);

  second.send({ type: 'signal', to: firstWelcome.id, data: { candidate: 'ice-test' } });
  const signal = await first.next('signal');
  assert.equal(signal.from, secondWelcome.id);
  assert.deepEqual(signal.data, { candidate: 'ice-test' });

  second.close();
  assert.equal((await first.next('peer-leave')).id, secondWelcome.id);
});

test('rejects arrivals after the configured mesh limit', async (t) => {
  const voiceChat = await startServer(1);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await voiceChat.close();
  });

  const first = await connect(voiceChat.wsUrl);
  clients.push(first);
  first.send({ type: 'join', profile: { name: 'first' } });
  await first.next('welcome');

  const second = await connect(voiceChat.wsUrl);
  clients.push(second);
  second.send({ type: 'join', profile: { name: 'second' } });
  assert.deepEqual(await second.next('full'), { type: 'full', max: 1 });
});

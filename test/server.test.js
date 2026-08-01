import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
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

async function startServer(maxPeers = 4, adminAccounts) {
  const voiceChat = createVoiceChatServer({ maxPeers, heartbeatMs: 60_000, adminAccounts });
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
  assert.match(html, /one room/);
  assert.match(html, /Voice only\. Peer to peer\. No account\./);
  assert.match(html, /boot\.js/);
  assert.match(html, /Connection console/);
  assert.match(html, /Admin login/);
  assert.doesNotMatch(html, /app\.js/);

  const wasm = await fetch(`${voiceChat.httpUrl}/voicechat-runtime.wasm`);
  assert.equal(wasm.status, 200);
  assert.match(wasm.headers.get('content-type'), /application\/wasm/);
  assert.ok((await wasm.arrayBuffer()).byteLength > 1_000);

  const cipher = await fetch(`${voiceChat.httpUrl}/voice-cipher.js`);
  assert.equal(cipher.status, 200);
  assert.match(await cipher.text(), /AES-GCM/);

  assert.equal((await fetch(`${voiceChat.httpUrl}/app.js`)).status, 404);
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
  first.send({ type: 'admin-login', username: 'nope', password: 'wrong' });
  assert.equal((await first.next('admin-login-result')).ok, false);

  const second = await connect(voiceChat.wsUrl);
  clients.push(second);
  second.send({
    type: 'join',
    profile: { name: 'second', color: '#445566', emoji: '🐸' },
    muted: true,
    encrypted: true,
  });
  const secondWelcome = await second.next('welcome');
  assert.equal(secondWelcome.peers.length, 1);
  assert.equal(secondWelcome.peers[0].id, firstWelcome.id);
  const secondJoin = await first.next('peer-join');
  assert.equal(secondJoin.peer.id, secondWelcome.id);
  assert.equal(secondJoin.peer.encrypted, true);
  assert.equal(secondJoin.peer.admin, false);

  second.send({
    type: 'update',
    profile: { name: '  renamed  ', color: 'invalid', emoji: '🐙' },
    muted: false,
    encrypted: false,
  });
  const update = await first.next('peer-update');
  assert.equal(update.peer.profile.name, 'renamed');
  assert.equal(update.peer.profile.color, '#46d39a');
  assert.equal(update.peer.muted, false);
  assert.equal(update.peer.encrypted, false);

  second.send({ type: 'signal', to: firstWelcome.id, data: { dh: 'ephemeral-public-key' } });
  const signal = await first.next('signal');
  assert.equal(signal.from, secondWelcome.id);
  assert.deepEqual(signal.data, { dh: 'ephemeral-public-key' });

  second.close();
  assert.equal((await first.next('peer-leave')).id, secondWelcome.id);
});

test('authenticates admins server-side and applies moderated room actions', async (t) => {
  const salt = 'test-admin-salt';
  const adminAccounts = [{
    username: 'moderator',
    cred: `${salt}:${scryptSync('correct horse battery staple', salt, 32).toString('hex')}`,
  }];
  const voiceChat = await startServer(4, adminAccounts);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await voiceChat.close();
  });

  const moderator = await connect(voiceChat.wsUrl);
  clients.push(moderator);
  moderator.send({ type: 'join', profile: { name: 'mod' } });
  await moderator.next('welcome');

  const listener = await connect(voiceChat.wsUrl);
  clients.push(listener);
  listener.send({ type: 'join', profile: { name: 'listener' } });
  const listenerWelcome = await listener.next('welcome');
  await moderator.next('peer-join');

  moderator.send({
    type: 'admin-login',
    username: 'moderator',
    password: 'correct horse battery staple',
  });
  assert.deepEqual(await moderator.next('admin-login-result'), {
    type: 'admin-login-result',
    ok: true,
    adminName: 'moderator',
  });
  const promoted = await listener.next('peer-update');
  assert.equal(promoted.peer.admin, true);
  assert.equal(promoted.peer.adminName, 'moderator');

  moderator.send({
    type: 'admin-action',
    action: 'warn',
    target: listenerWelcome.id,
    text: 'Keep it civil.',
  });
  assert.deepEqual(await listener.next('warn'), {
    type: 'warn',
    by: 'moderator',
    text: 'Keep it civil.',
  });

  moderator.send({
    type: 'admin-action',
    action: 'mute',
    target: listenerWelcome.id,
    value: true,
  });
  assert.deepEqual(await listener.next('force-mute'), {
    type: 'force-mute',
    value: true,
    by: 'moderator',
  });
  assert.equal((await listener.next('peer-update')).peer.forcedMuted, true);

  moderator.send({ type: 'admin-action', action: 'lock', value: true });
  assert.equal((await listener.next('announce')).text, 'room locked');

  const lateArrival = await connect(voiceChat.wsUrl);
  clients.push(lateArrival);
  lateArrival.send({ type: 'join', profile: { name: 'late' } });
  assert.deepEqual(await lateArrival.next('locked'), { type: 'locked' });
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

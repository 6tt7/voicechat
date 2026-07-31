// Runs the frame cipher off the main thread via RTCRtpScriptTransform.
import { createCipherTransform, importAesKey } from './voice-cipher.js';

const sending = { enabled: false, key: null };
/** peer id -> { key } for that peer's incoming audio */
const receiving = new Map();

function receivingCtx(peerId) {
  if (!receiving.has(peerId)) receiving.set(peerId, { key: null });
  return receiving.get(peerId);
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  switch (msg.type) {
    case 'enabled':
      sending.enabled = !!msg.value;
      break;
    case 'sendKey':
      sending.key = msg.raw ? await importAesKey(msg.raw, 'encrypt') : null;
      break;
    case 'receiveKey': {
      const ctx = receivingCtx(msg.peerId);
      ctx.key = msg.raw ? await importAesKey(msg.raw, 'decrypt') : null;
      break;
    }
    case 'forget':
      receiving.delete(msg.peerId);
      break;
  }
};

// Fired once per sender/receiver that gets an RTCRtpScriptTransform attached.
self.onrtctransform = (event) => {
  const { operation, peerId } = event.transformer.options;
  const ctx = operation === 'encrypt' ? sending : receivingCtx(peerId);
  const { readable, writable } = event.transformer;

  readable
    .pipeThrough(createCipherTransform(ctx, operation))
    .pipeTo(writable)
    .catch(() => { /* transport closed */ });
};

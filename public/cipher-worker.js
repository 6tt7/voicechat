// Runs the audio cipher off the main thread via RTCRtpScriptTransform.
// Keys are per peer link (ECDH-derived) and arrive as structured-cloned
// CryptoKey objects — never as raw bytes.
import { createCipherTransform } from './voice-cipher.js';

let enabled = false;
const keys = new Map(); // peerId -> CryptoKey

self.onmessage = (e) => {
  const msg = e.data || {};
  switch (msg.type) {
    case 'enabled':
      enabled = !!msg.value;
      break;
    case 'peerKey':
      if (msg.key) keys.set(msg.peerId, msg.key); else keys.delete(msg.peerId);
      break;
    case 'forget':
      keys.delete(msg.peerId);
      break;
  }
};

// Fired once per sender/receiver that gets an RTCRtpScriptTransform attached.
self.onrtctransform = (event) => {
  const { operation, peerId } = event.transformer.options;
  const ctx = {
    get enabled() { return enabled; },
    get key() { return keys.get(peerId); },
  };
  const { readable, writable } = event.transformer;

  readable
    .pipeThrough(createCipherTransform(ctx, operation))
    .pipeTo(writable)
    .catch(() => { /* transport closed */ });
};

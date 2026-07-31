// Attaches the cipher to outgoing and incoming audio, preferring the standard
// RTCRtpScriptTransform (worker) and falling back to Chrome's older
// createEncodedStreams (main thread).
import { createCipherTransform, importAesKey } from './voice-cipher.js';

const hasScriptTransform = typeof window.RTCRtpScriptTransform === 'function';
const hasEncodedStreams = typeof RTCRtpSender.prototype.createEncodedStreams === 'function';

export const cipherMode = hasScriptTransform ? 'worker' : hasEncodedStreams ? 'main' : null;
export const cipherSupported = cipherMode !== null;

// Used by the main-thread fallback; the worker keeps its own copies in sync.
const sending = { enabled: false, key: null };
const receiving = new Map();

function receivingCtx(peerId) {
  if (!receiving.has(peerId)) receiving.set(peerId, { key: null });
  return receiving.get(peerId);
}

let worker = null;
function cipherWorker() {
  worker ||= new Worker('cipher-worker.js', { type: 'module' });
  return worker;
}

/** Chrome requires this at RTCPeerConnection construction time. */
export function pcCipherOptions() {
  return hasScriptTransform ? {} : { encodedInsertableStreams: hasEncodedStreams };
}

function attach(target, options, direction, ctx) {
  if (!cipherSupported || target.__ciphered) return;
  target.__ciphered = true;

  try {
    if (cipherMode === 'worker') {
      target.transform = new RTCRtpScriptTransform(cipherWorker(), options);
    } else {
      const { readable, writable } = target.createEncodedStreams();
      readable
        .pipeThrough(createCipherTransform(ctx, direction))
        .pipeTo(writable)
        .catch(() => { /* transport closed */ });
    }
  } catch (err) {
    console.warn('cipher unavailable', err);
    target.__ciphered = false;
  }
}

export function installSenderCipher(sender) {
  attach(sender, { operation: 'encrypt' }, 'encrypt', sending);
}

export function installReceiverCipher(receiver, peerId) {
  attach(receiver, { operation: 'decrypt', peerId }, 'decrypt', receivingCtx(peerId));
}

export function setEncryptionEnabled(on) {
  sending.enabled = on;
  if (cipherMode === 'worker') cipherWorker().postMessage({ type: 'enabled', value: on });
}

/** @param {Uint8Array|null} raw AES key bytes used for our outgoing audio */
export async function setSendKey(raw) {
  sending.key = raw ? await importAesKey(raw, 'encrypt') : null;
  if (cipherMode === 'worker') {
    cipherWorker().postMessage({ type: 'sendKey', raw: raw ? raw.buffer.slice(0) : null });
  }
}

/** @param {Uint8Array|null} raw AES key bytes recovered for one peer's audio */
export async function setReceiveKey(peerId, raw) {
  receivingCtx(peerId).key = raw ? await importAesKey(raw, 'decrypt') : null;
  if (cipherMode === 'worker') {
    cipherWorker().postMessage({
      type: 'receiveKey',
      peerId,
      raw: raw ? raw.buffer.slice(0) : null,
    });
  }
}

export function forgetPeer(peerId) {
  receiving.delete(peerId);
  if (cipherMode === 'worker') cipherWorker().postMessage({ type: 'forget', peerId });
}

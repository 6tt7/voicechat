// Attaches the audio cipher to senders and receivers. Each peer link has its
// own AES-GCM key (derived by ECDH in the C++/WASM client), so keys are stored per
// peer id. Prefers the standard RTCRtpScriptTransform (worker), falling back to
// Chrome's older createEncodedStreams (main thread).
import { createCipherTransform } from './voice-cipher.js';

const hasScriptTransform = typeof window.RTCRtpScriptTransform === 'function';
const hasEncodedStreams = typeof RTCRtpSender.prototype.createEncodedStreams === 'function';

export const cipherMode = hasScriptTransform ? 'worker' : hasEncodedStreams ? 'main' : null;
export const cipherSupported = cipherMode !== null;

// Main-thread fallback state; the worker keeps its own mirror.
let enabled = false;
const keys = new Map(); // peerId -> CryptoKey (used for both directions of a link)

let worker = null;
function cipherWorker() {
  worker ||= new Worker('cipher-worker.js', { type: 'module' });
  return worker;
}

/** Chrome requires this at RTCPeerConnection construction time. */
export function pcCipherOptions() {
  return hasScriptTransform ? {} : { encodedInsertableStreams: hasEncodedStreams };
}

function attach(target, options, direction, peerId) {
  if (!cipherSupported || target.__ciphered) return;
  target.__ciphered = true;

  try {
    if (cipherMode === 'worker') {
      target.transform = new RTCRtpScriptTransform(cipherWorker(), options);
    } else {
      const ctx = { get enabled() { return enabled; }, get key() { return keys.get(peerId); } };
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

export function installSenderCipher(sender, peerId) {
  attach(sender, { operation: 'encrypt', peerId }, 'encrypt', peerId);
}

export function installReceiverCipher(receiver, peerId) {
  attach(receiver, { operation: 'decrypt', peerId }, 'decrypt', peerId);
}

export function setEncryptionEnabled(on) {
  enabled = on;
  if (cipherMode === 'worker') cipherWorker().postMessage({ type: 'enabled', value: on });
}

/** @param {CryptoKey|null} key the ECDH-derived AES-GCM key for this link */
export function setPeerKey(peerId, key) {
  if (key) keys.set(peerId, key); else keys.delete(peerId);
  // CryptoKey is structured-cloneable, so the derived key crosses to the worker
  // without ever being exported to raw bytes.
  if (cipherMode === 'worker') cipherWorker().postMessage({ type: 'peerKey', peerId, key: key || null });
}

export function forgetPeer(peerId) {
  keys.delete(peerId);
  if (cipherMode === 'worker') cipherWorker().postMessage({ type: 'forget', peerId });
}

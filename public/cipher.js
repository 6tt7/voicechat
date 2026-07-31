// Attaches the debug cipher to outgoing audio, preferring the standard
// RTCRtpScriptTransform (worker) and falling back to Chrome's older
// createEncodedStreams (main thread).
import { createCipherTransform } from './voice-cipher.js';

const hasScriptTransform = typeof window.RTCRtpScriptTransform === 'function';
const hasEncodedStreams = typeof RTCRtpSender.prototype.createEncodedStreams === 'function';

export const cipherMode = hasScriptTransform ? 'worker' : hasEncodedStreams ? 'main' : null;
export const cipherSupported = cipherMode !== null;

// Shared with the main-thread transforms; the worker keeps its own copy in sync.
const state = { enabled: false };

let worker = null;
function cipherWorker() {
  worker ||= new Worker('cipher-worker.js', { type: 'module' });
  return worker;
}

/** Chrome requires this at RTCPeerConnection construction time. */
export function pcCipherOptions() {
  return hasScriptTransform ? {} : { encodedInsertableStreams: hasEncodedStreams };
}

export function installSenderCipher(sender) {
  if (!cipherSupported || sender.__ciphered) return;
  sender.__ciphered = true;

  try {
    if (cipherMode === 'worker') {
      sender.transform = new RTCRtpScriptTransform(cipherWorker(), { operation: 'encrypt' });
    } else {
      const { readable, writable } = sender.createEncodedStreams();
      readable
        .pipeThrough(createCipherTransform(state))
        .pipeTo(writable)
        .catch(() => { /* sender closed */ });
    }
  } catch (err) {
    console.warn('cipher unavailable on this sender', err);
    sender.__ciphered = false;
  }
}

export function setCipherEnabled(on) {
  state.enabled = on;
  if (cipherMode === 'worker') cipherWorker().postMessage({ type: 'enabled', value: on });
}

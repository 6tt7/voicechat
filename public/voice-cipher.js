// Core of the debug cipher, shared by the worker and the main-thread fallback.
//
// Encrypts outgoing encoded audio frames with AES-CTR. The key is generated
// locally and never sent anywhere, so no peer can undo this — which is the
// point: receivers play the ciphertext straight into their Opus decoder.
//
// AES-CTR is a keystream cipher, so ciphertext is exactly as long as the
// plaintext and the RTP framing stays valid.

// The Opus TOC byte carries the frame's mode/bandwidth/stride. Leaving it clear
// keeps the far-end decoder parsing frames, so the ciphertext comes out as
// audible static instead of silent decode failures.
const CLEAR_HEADER_BYTES = 1;

let keyPromise = null;

function sessionKey() {
  keyPromise ||= crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(16)),
    'AES-CTR',
    false,
    ['encrypt'],
  );
  return keyPromise;
}

/**
 * @param {{enabled: boolean}} state live toggle, flipped from outside
 * @returns {TransformStream} for an RTCRtpSender's encoded frame stream
 */
export function createCipherTransform(state) {
  let counter = 0;

  return new TransformStream({
    async transform(frame, controller) {
      if (!state.enabled || frame.data.byteLength <= CLEAR_HEADER_BYTES) {
        controller.enqueue(frame);
        return;
      }

      try {
        const data = new Uint8Array(frame.data);
        // Unique counter block per frame so no keystream is ever reused.
        const iv = new Uint8Array(16);
        new DataView(iv.buffer).setUint32(12, counter++ >>> 0);

        const ciphertext = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: 'AES-CTR', counter: iv, length: 32 },
            await sessionKey(),
            data.subarray(CLEAR_HEADER_BYTES),
          ),
        );
        data.set(ciphertext, CLEAR_HEADER_BYTES);
        frame.data = data.buffer;
      } catch {
        // Never drop the stream over a debug feature; send the frame untouched.
      }

      controller.enqueue(frame);
    },
  });
}

// Frame-level cipher, shared by the worker and the main-thread fallback.
//
// Audio frames are encrypted with AES-GCM under a per-link key that ECDH
// (Diffie-Hellman) derived by the C++/WASM client. Both ends of a link derive the
// same key, so each decrypts the other; anyone without it (the server, a
// third party) feeds ciphertext into their Opus decoder and hears static.
//
// Wire format of an encrypted frame:
//   [ opus TOC (1) ][ ciphertext+tag ][ iv (12) ][ magic (2) ]
//
// The Opus TOC byte stays in the clear so the far-end decoder keeps parsing
// frames — that is what makes undecrypted audio audible static rather than
// silent decode failures. The trailing magic marks a frame as ours, so a
// listener holding a key never mangles someone's unencrypted audio.

const CLEAR_HEADER_BYTES = 1;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAGIC = [0x5a, 0xe5];
const MIN_ENCRYPTED = CLEAR_HEADER_BYTES + GCM_TAG_BYTES + IV_BYTES + MAGIC.length;

/**
 * @param {{enabled?: boolean, key: CryptoKey|null}} ctx mutated live from outside
 * @param {'encrypt'|'decrypt'} direction
 */
export function createCipherTransform(ctx, direction) {
  const apply = direction === 'encrypt' ? encryptFrame : decryptFrame;
  return new TransformStream({
    async transform(frame, controller) {
      await apply(frame, ctx);
      controller.enqueue(frame);
    },
  });
}

async function encryptFrame(frame, ctx) {
  if (!ctx.enabled || !ctx.key || frame.data.byteLength <= CLEAR_HEADER_BYTES) return;

  try {
    const src = new Uint8Array(frame.data);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ctx.key, src.subarray(CLEAR_HEADER_BYTES)),
    );

    const out = new Uint8Array(CLEAR_HEADER_BYTES + sealed.length + IV_BYTES + MAGIC.length);
    out[0] = src[0];
    out.set(sealed, CLEAR_HEADER_BYTES);
    out.set(iv, CLEAR_HEADER_BYTES + sealed.length);
    out.set(MAGIC, out.length - MAGIC.length);
    frame.data = out.buffer;
  } catch {
    // Never break the call over the cipher; send the frame untouched.
  }
}

async function decryptFrame(frame, ctx) {
  if (!ctx.key) return;

  const src = new Uint8Array(frame.data);
  const n = src.length;
  if (n < MIN_ENCRYPTED || src[n - 2] !== MAGIC[0] || src[n - 1] !== MAGIC[1]) return;

  try {
    const ivStart = n - MAGIC.length - IV_BYTES;
    // GCM authenticates, so a wrong key throws here instead of emitting noise.
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: src.subarray(ivStart, ivStart + IV_BYTES) },
        ctx.key,
        src.subarray(CLEAR_HEADER_BYTES, ivStart),
      ),
    );

    const out = new Uint8Array(CLEAR_HEADER_BYTES + plain.length);
    out[0] = src[0];
    out.set(plain, CLEAR_HEADER_BYTES);
    frame.data = out.buffer;
  } catch {
    // Wrong key or tampered frame: leave the ciphertext, listener hears static.
  }
}

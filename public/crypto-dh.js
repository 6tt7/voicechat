// Elliptic-curve Diffie-Hellman (P-256) key agreement.
//
// Every peer link gets a fresh ephemeral ECDH keypair. The two sides exchange
// public keys over the signaling channel and each derives the same shared
// secret from (my private key + your public key) — the server, which only
// relays the public keys, can never compute it. An HKDF step turns the raw
// secret into an AES-GCM key used to encrypt that link's audio.
//
// Ephemeral-per-link means past audio stays private even if a later key leaks
// (forward secrecy), and nobody has to copy-paste a key by hand.

const CURVE = { name: 'ECDH', namedCurve: 'P-256' };

function b64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** A fresh ephemeral keypair plus our public key as a base64 raw point. */
export async function makeEphemeralKeys() {
  const pair = await crypto.subtle.generateKey(CURVE, false, ['deriveBits']);
  const rawPub = await crypto.subtle.exportKey('raw', pair.publicKey);
  return { privateKey: pair.privateKey, publicKeyB64: b64(rawPub) };
}

/**
 * Derive the shared AES-GCM key from our private key and the peer's public key.
 * Both sides pass the same pair of public keys (in a stable order) as the HKDF
 * salt, so they land on identical key material.
 */
export async function deriveSharedKey(privateKey, peerPublicKeyB64, ourPublicKeyB64) {
  const peerPub = await crypto.subtle.importKey('raw', unb64(peerPublicKeyB64), CURVE, false, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, privateKey, 256);

  const salt = saltFromPubs(ourPublicKeyB64, peerPublicKeyB64);
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('voicechat-audio') },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  const fp = await fingerprint(ourPublicKeyB64, peerPublicKeyB64);
  return { key, fingerprint: fp };
}

// Order-independent so both peers compute the same salt and fingerprint.
function saltFromPubs(a, b) {
  const [x, y] = [a, b].sort();
  return new TextEncoder().encode(x + '|' + y);
}

/** Short digest of the two public keys — read aloud to confirm a link. */
export async function fingerprint(a, b) {
  const digest = await crypto.subtle.digest('SHA-256', saltFromPubs(a, b));
  return [...new Uint8Array(digest).slice(0, 6)]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
    .replace(/(.{4})(?=.)/g, '$1-');
}

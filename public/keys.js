// RSA identity + key exchange.
//
// Audio itself is encrypted with AES-GCM (RSA cannot encrypt a stream: a
// 2048-bit key takes at most 190 bytes per operation and is far too slow for
// 50 frames a second). RSA-OAEP does the job it is good at — wrapping the AES
// session key so only a holder of the private key can recover it.
//
// You publish your PRIVATE key to the people you want to be able to hear you.
// That is unusual for RSA and deliberate here: this is a one-to-many broadcast
// with manual key handout, so the key you share is the one that decrypts.

const RSA_PARAMS = {
  name: 'RSA-OAEP',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

const STORE = 'vc-rsa-identity';

export function b64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(text) {
  return Uint8Array.from(atob(text.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
}

async function exportIdentity(pair) {
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', pair.privateKey),
    crypto.subtle.exportKey('spki', pair.publicKey),
  ]);
  return { privateKey: b64(privateKey), publicKey: b64(publicKey) };
}

/** Loads the stored identity, generating one on first run. */
export async function loadIdentity() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (saved?.privateKey && saved?.publicKey) return saved;
  } catch { /* regenerate below */ }

  const pair = await crypto.subtle.generateKey(RSA_PARAMS, true, ['encrypt', 'decrypt']);
  const identity = await exportIdentity(pair);
  try {
    localStorage.setItem(STORE, JSON.stringify(identity));
  } catch { /* private mode: identity lasts for this tab only */ }
  return identity;
}

export async function newIdentity() {
  const pair = await crypto.subtle.generateKey(RSA_PARAMS, true, ['encrypt', 'decrypt']);
  const identity = await exportIdentity(pair);
  try {
    localStorage.setItem(STORE, JSON.stringify(identity));
  } catch { /* not persisted */ }
  return identity;
}

const importPublic = (spki) =>
  crypto.subtle.importKey('spki', unb64(spki), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);

const importPrivate = (pkcs8) =>
  crypto.subtle.importKey('pkcs8', unb64(pkcs8), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);

/** True if the text is an RSA private key this browser will accept. */
export async function validatePrivateKey(text) {
  try {
    await importPrivate(text.trim());
    return true;
  } catch {
    return false;
  }
}

/** Wraps raw AES key bytes for anyone holding the matching private key. */
export async function sealSessionKey(rawAesKey, publicKeyB64) {
  const key = await importPublic(publicKeyB64);
  return b64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, rawAesKey));
}

/** Recovers AES key bytes from an envelope; null when the key doesn't match. */
export async function openSessionKey(envelopeB64, privateKeyB64) {
  try {
    const key = await importPrivate(privateKeyB64);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, key, unb64(envelopeB64)));
  } catch {
    return null;
  }
}

/** Short, readable digest so two people can verify a key over voice. */
export async function fingerprint(keyB64) {
  const digest = await crypto.subtle.digest('SHA-256', unb64(keyB64));
  return [...new Uint8Array(digest).slice(0, 6)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .replace(/(.{4})(?=.)/g, '$1-');
}

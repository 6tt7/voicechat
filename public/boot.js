import createVoiceChat from './voicechat-runtime.js';
import {
  cipherSupported,
  forgetPeer,
  installReceiverCipher,
  installSenderCipher,
  pcCipherOptions,
  setEncryptionEnabled,
  setReceiveKey,
  setSendKey,
} from './cipher.js';
import {
  fingerprint,
  loadIdentity,
  newIdentity,
  openSessionKey,
  sealSessionKey,
  validatePrivateKey,
} from './keys.js';

const status = document.getElementById('status');
const statusDot = document.getElementById('statusDot');

try {
  globalThis.voiceCipher = Object.freeze({
    cipherSupported,
    forgetPeer,
    installReceiverCipher,
    installSenderCipher,
    pcCipherOptions,
    setEncryptionEnabled,
    setReceiveKey,
    setSendKey,
  });
  globalThis.voiceKeys = Object.freeze({
    fingerprint,
    loadIdentity,
    newIdentity,
    openSessionKey,
    sealSessionKey,
    validatePrivateKey,
  });
  await createVoiceChat();
} catch (error) {
  console.error('WebAssembly startup failed', error);
  status.textContent = 'could not start the WebAssembly client';
  statusDot.className = 'dot error';
}

import createVoiceChat from './voicechat-runtime.js';
import {
  cipherSupported,
  installSenderCipher,
  pcCipherOptions,
  setCipherEnabled,
} from './cipher.js';

const status = document.getElementById('status');
const statusDot = document.getElementById('statusDot');

try {
  globalThis.voiceCipher = Object.freeze({
    cipherSupported,
    installSenderCipher,
    pcCipherOptions,
    setCipherEnabled,
  });
  await createVoiceChat();
} catch (error) {
  console.error('WebAssembly startup failed', error);
  status.textContent = 'could not start the WebAssembly client';
  statusDot.className = 'dot error';
}

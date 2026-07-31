// Runs the debug cipher off the main thread via RTCRtpScriptTransform.
import { createCipherTransform } from './voice-cipher.js';

const state = { enabled: false };

self.onmessage = (e) => {
  if (e.data?.type === 'enabled') state.enabled = !!e.data.value;
};

// Fired once per sender that gets an RTCRtpScriptTransform attached.
self.onrtctransform = (event) => {
  const { readable, writable } = event.transformer;
  readable
    .pipeThrough(createCipherTransform(state))
    .pipeTo(writable)
    .catch(() => { /* sender closed */ });
};

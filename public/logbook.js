// Categorized in-app debug log, shown in the console panel.
//
// Everything interesting the client does routes through log(category, ...) so
// the panel can filter by category — signaling, WebRTC, the Diffie-Hellman
// handshakes with each peer, media, admin events, and general system notes.

export const CATEGORIES = {
  system: { label: 'system', color: '#9aa4bf' },
  signal: { label: 'signaling', color: '#5ec8f2' },
  webrtc: { label: 'webrtc', color: '#7c8cff' },
  dh: { label: 'key exchange', color: '#46d39a' },
  media: { label: 'media', color: '#ffb547' },
  admin: { label: 'admin', color: '#ff6b9d' },
};

const MAX = 600;
const entries = [];
const listeners = new Set();

export function log(category, message, data) {
  const entry = {
    t: Date.now(),
    category: CATEGORIES[category] ? category : 'system',
    message: String(message),
    data: data === undefined ? null : safe(data),
  };
  entries.push(entry);
  if (entries.length > MAX) entries.shift();
  for (const fn of listeners) fn(entry);
  return entry;
}

function safe(data) {
  try {
    if (typeof data === 'string') return data;
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function getEntries() {
  return entries.slice();
}

export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearLog() {
  entries.length = 0;
  for (const fn of listeners) fn(null);
}

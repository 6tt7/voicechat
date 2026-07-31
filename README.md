# the channel

One voice room. No accounts, no logins, no lobby — you open the page, your mic connects, you're in.
Identity is just a profile picture and a name kept in your own browser.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000. Anyone who opens the same URL lands in the same (and only) channel.

## How it works

- **Audio is peer-to-peer.** Every participant opens a direct WebRTC connection to every other
  participant (a full mesh). Voice never passes through the server.
- **The server only does signaling.** `server.js` keeps an in-memory list of who is in the room and
  relays SDP/ICE between them over WebSocket. Nothing is written to disk, and there is no database.
- **Profiles are browser-local.** Your emoji/color avatar (or an uploaded picture, downscaled to a
  192px square) and name live in `localStorage` and are sent to peers only while you're connected.

Because it's a mesh, bandwidth grows with the square of the room size. `MAX_PEERS` (default 12)
caps it; past that, new arrivals are told the channel is full.

```bash
PORT=8080 MAX_PEERS=6 npm start
```

## Using it over the internet

Browsers only grant microphone access on `localhost` or over **HTTPS**, so deploy behind TLS
(Render, Fly.io, a Caddy/nginx reverse proxy — anything terminating HTTPS works; the WebSocket
upgrade rides the same port).

Only Google's public STUN servers are configured. That covers most home networks, but peers behind
symmetric NAT or strict corporate firewalls will fail to connect without a TURN relay. To add one,
extend `iceServers` at the top of [public/app.js](public/app.js):

```js
{ urls: 'turn:your-turn-host:3478', username: 'user', credential: 'pass' }
```

## Controls

| | |
|---|---|
| **mute** | toggle your mic (or press `M`) |
| **you** | change your picture — shuffle an emoji avatar or upload an image |
| **copy link** | grab the room URL to send to someone |

A green ring around an avatar means that person is talking.

## Encryption

Off by default. Turn it on and your outgoing audio is encrypted with AES-GCM; only people who hold
your key can hear you, and everyone else gets static. Open **keys** to see your key, copy it, or
paste someone else's.

**RSA does the key exchange, AES does the audio.** RSA cannot encrypt a media stream — a 2048-bit
key takes at most 190 bytes per operation and is orders of magnitude too slow for 50 frames a
second. So each session generates a random AES-256 key, seals it with RSA-OAEP, and ships that
344-character envelope through the signaling server. The server can relay it but never open it.

The key shown in the panel is your **RSA private key**. Handing it out is what lets others decrypt
you. That's inverted from normal RSA use and deliberate: this is a one-to-many broadcast with manual
key handout, so the key you share has to be the one that opens the envelope. Anyone holding it can
hear you (and anyone else using that same keypair). The fingerprint under the key is a short SHA-256
digest — read it aloud to confirm you both have the same key.

Badges: 🔒 amber means encrypted and you can't open it; 🔓 green means encrypted and your key works.
The panel tells you exactly how many streams your key opens.

### What this does and doesn't give you

Audio is encrypted end to end — the server relays ciphertext and cannot decode it. Frames are
authenticated (AES-GCM), so a wrong key or a tampered frame is rejected rather than played as noise.

It is **not** a hardened messenger. Keys travel by copy-paste, so anyone who intercepts one has full
access; there's no forward secrecy (one key covers the whole session) and no identity verification
beyond reading fingerprints aloud. Note also that WebRTC already encrypts every call with DTLS-SRTP
in transit — what this adds is that peers without your key can't hear you either.

### Implementation

Frames are transformed via
[`RTCRtpScriptTransform`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpScriptTransform) in
a worker, falling back to Chrome's older `createEncodedStreams`; browsers with neither get the button
disabled. Wire format is `[opus TOC (1)][ciphertext+tag][iv (12)][magic (2)]`, about 12 kbps of
overhead.

Two details that are load-bearing, both in [public/voice-cipher.js](public/voice-cipher.js) and
[public/app.js](public/app.js):

- The one-byte Opus TOC header stays in the clear. Encrypt it too and the far-end decoder rejects
  frames outright, so listeners without the key get silence and decoder errors instead of static.
- The decrypt transform is attached as soon as the transceiver exists — right after `addTrack` for
  the caller, right after `setRemoteDescription` for the answerer. Attaching it in `ontrack` (the
  obvious place) is too late: Chrome routes no frames through it, and audio stays encrypted while
  the UI claims otherwise.

## Diffie-Hellman encryption (replaces the copy-paste keys)

Every peer link now runs an **ephemeral ECDH (P-256) handshake**: the two sides
exchange public keys over the signaling channel and each derives the same
AES-GCM key via HKDF. The server only relays public keys and can never compute
the secret. Ephemeral-per-link means past audio stays private even if a key
later leaks (forward secrecy), and nobody copies a key by hand. Each peer card
shows a 🔒 and a shared-key fingerprint — read it aloud to confirm a link.
On by default; the encryption button toggles the app layer (WebRTC's DTLS-SRTP
still encrypts transport underneath regardless).

## Console (debug logs)

The **console** button opens a categorized log — system, signaling, webrtc,
key exchange, media, admin — with filter chips. The Diffie-Hellman handshake
for every peer (with fingerprints) shows up under "key exchange".

## Admin

Login is **server-side only** (see `server.js`): passwords are stored as
`salt:scryptHash`, compared in constant time, and rate-limited to 6 tries per
minute per IP. Override the accounts in production with the `ADMIN_ACCOUNTS`
env var (JSON). Admins appear on a raised **stage** with a crown and an animated
RGB name. The admin panel + tapping a person gives: kick, ban IP, warn,
announce (types out live to everyone), rename, reset avatar, force-mute, room
lock, spotlight, and confetti. Every listener also has a local per-person
volume slider (how loudly *they* hear someone). Themes: dark / light / midnight.

### Not built (and why)

Some items from the request were left out because they target or harm people
who never consented:

- **Full-screen strobe + high-pitch tone** — flashing and loud high-frequency
  audio are seizure and hearing-damage risks. Omitted entirely.
- **Spawn an image on someone's screen** and **forward a user to a website** —
  injecting content into or navigating another person's browser is harassment /
  phishing. Omitted; admins can *reset* an inappropriate avatar instead.
- **Force another user's volume up/down** — remotely controlling someone's
  playback is a harm vector. Replaced with a local slider each person controls
  for themselves.
- **Hidden admin-only features** — nothing is concealed; both admin logins live
  in `server.js` (as hashes) and are documented here.

Note: `mfa123` is a weak password. Set a strong one via `ADMIN_ACCOUNTS` before
this is public-facing.

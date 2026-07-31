# the channel

A single, account-free WebRTC voice room with a C++/WebAssembly browser client.

Open the page, allow microphone access, and you are in. Your profile is kept in your own browser,
audio travels directly between participants, and the server only relays the small messages needed
to establish each peer-to-peer connection.

## What is included

- C++20 application logic compiled to WebAssembly
- direct peer-to-peer WebRTC audio
- mandatory DTLS-SRTP media encryption with pairwise safety codes
- responsive desktop and mobile interface
- local emoji, color, or uploaded-photo profiles
- selectable microphone input
- optional hold-Space push to talk
- per-participant volume controls
- speaking and muted indicators
- reconnect handling and a capped full-mesh room
- automated signaling, capacity, sanitization, and static-asset tests

## Run it

The generated WebAssembly artifacts are committed, so running the app only requires Node.js 18 or
newer:

```bash
npm ci
npm start
```

Open <http://localhost:3000>. Anyone opening the same URL joins the same room.

```bash
PORT=8080 MAX_PEERS=6 npm start
```

## Build the WebAssembly client

Install and activate [Emscripten](https://emscripten.org/docs/getting_started/downloads.html), then:

```bash
npm run build:wasm
```

This compiles [`src/client.cpp`](src/client.cpp) into:

- `public/voicechat-runtime.wasm` — the native WebAssembly module
- `public/voicechat-runtime.js` — generated Emscripten bindings

`public/boot.js` loads the module and bridges the owner's encoded-audio debug cipher into C++.
WebRTC, media devices, Web Audio, local storage, and the DOM are browser APIs, so the C++ module
reaches them through Emscripten's generated JavaScript bindings. The owner's `cipher.js`,
`cipher-worker.js`, and `voice-cipher.js` modules remain hand-written JavaScript because the
standard encoded-transform API runs in a browser worker.

The checked-in artifacts are built and reproducibility-checked in CI with Emscripten 6.0.5.

## Test it

```bash
npm run check
```

The check runs Node syntax validation and the integration suite. CI also recompiles the C++ source
and fails if the committed `.js` or `.wasm` output is stale.

## Architecture

The browser client is C++/WebAssembly. It owns profiles, DOM rendering, call controls, media-device
switching, speaking meters, signaling state, reconnects, and the WebRTC peer mesh.

`server.js` serves the static client and hosts one WebSocket channel. It assigns participant IDs,
sanitizes public profiles, maintains the in-memory roster, enforces `MAX_PEERS`, and relays SDP/ICE.
It never receives voice audio and writes nothing to disk.

WebRTC encrypts each media path with DTLS-SRTP, including when packets travel through a TURN relay.
After a peer connects, the client reads both certificate fingerprints from the WebRTC statistics
report, sorts them into the same order on both ends, hashes them with SHA-256, and displays the first
48 bits as a safety code. Participants can compare that code over another trusted channel to detect
a signaling-layer man-in-the-middle.

Because the room is a full mesh, each participant connects directly to every other participant and
bandwidth grows quickly with room size. The default limit is 12.

## Deploy it

Microphone access requires `localhost` or HTTPS. Deploy behind TLS on Render, Fly.io, Caddy, nginx,
or another HTTPS host; the WebSocket upgrade uses the same port.

The client includes public Google STUN servers. Peers behind symmetric NAT or strict corporate
firewalls may still require a TURN relay. Add TURN credentials to `rtcConfiguration()` in
`src/client.cpp`, rebuild the WebAssembly artifacts, and redeploy.

## Controls

| Control | Action |
|---|---|
| **Mute** | Toggle the microphone, or press `M` |
| **Push to talk** | Enable it under Audio, then hold `Space` or the mic button |
| **Profile** | Change your local display name and avatar |
| **Invite** | Copy the room URL |
| **Audio** | Select a microphone and push-to-talk mode |
| **Volume** | Adjust an individual remote participant on their card |
| **Encrypt (debug)** | Encrypt outgoing frames with an unshared key so peers hear static |

A green pulse around a participant means they are speaking.

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

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

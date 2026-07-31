#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/eventloop.h>
#include <emscripten/val.h>

using emscripten::val;

namespace {

struct Profile {
  std::string name;
  std::string emoji;
  std::string color;
  std::string avatar;
};

struct Peer {
  explicit Peer(std::string peerId) : id(std::move(peerId)) {}

  std::string id;
  Profile profile;
  bool muted = false;
  bool encrypted = false;
  bool decrypting = false;
  std::string envelope;
  double volume = 1.0;
  val pc = val::undefined();
  val card = val::undefined();
  val audioElement = val::undefined();
  val volumeInput = val::undefined();
  val safetyCode = val::undefined();
  val source = val::undefined();
  val analyser = val::undefined();
  std::vector<float> meterBuffer = std::vector<float>(512);
  std::vector<val> pendingCandidates;
  int meterTimer = 0;
  int quietFrames = 0;
  bool speaking = false;
};

val document = val::global("document");
val windowObject = val::global("window");
val navigatorObject = val::global("navigator");
val json = val::global("JSON");
val mathObject = val::global("Math");
val ws = val::undefined();
val localStream = val::undefined();
val audioContext = val::undefined();
val identity = val::undefined();
val sessionKeyRaw = val::undefined();

std::unordered_map<std::string, std::unique_ptr<Peer>> peers;
std::string myId;
Profile profile;
std::string preferredMic;
bool muted = false;
bool manualMuted = false;
bool pushToTalk = false;
bool pushPressed = false;
bool encrypting = false;
bool audioBlocked = false;
bool micFallbackTried = false;
bool microphoneReady = false;
int reconnectDelay = 1000;
std::string sessionEnvelope;
std::string listenKey;

const std::vector<std::string> emojis = {
  "🦊", "🐼", "🐸", "🐙", "🦉", "🐝", "🦄", "🐺", "🐳", "🦕", "🐢", "🦋",
  "🐧", "🦔", "🐨", "🦁", "🐮", "🐷", "🦀", "🐬", "🦩", "🐿️", "🦇", "🐤",
};
const std::vector<std::string> colors = {
  "#2dd4bf", "#46d39a", "#ffb547", "#ff6b6b",
  "#5ec8f2", "#38bdf8", "#f97362", "#4ade80",
};
const std::vector<std::string> adjectives = {
  "quiet", "loud", "fuzzy", "quick", "lazy", "brave", "odd", "tiny", "lucky", "wired",
};
const std::vector<std::string> nouns = {
  "comet", "moth", "pixel", "ember", "echo", "tuba", "wren", "onion", "radio", "ghost",
};

val byId(const std::string& id) {
  return document.call<val>("getElementById", id);
}

std::string js(const char* text) {
  return text;
}

bool present(const val& value) {
  return !value.isUndefined() && !value.isNull();
}

std::string stringProperty(const val& object, const char* name, const std::string& fallback = "") {
  if (!present(object)) return fallback;
  const val value = object[name];
  return value.isString() ? value.as<std::string>() : fallback;
}

val callback(const char* name) {
  return val::module_property(name);
}

val callback(const char* name, const std::string& firstArgument) {
  return val::module_property(name).call<val>("bind", val::undefined(), firstArgument);
}

void showIdentity();

template <typename T>
const T& pick(const std::vector<T>& options) {
  const double random = mathObject.call<val>("random").as<double>();
  const auto index = static_cast<std::size_t>(random * static_cast<double>(options.size()));
  return options[std::min(index, options.size() - 1)];
}

Profile randomProfile() {
  return {
    pick(adjectives) + "-" + pick(nouns),
    pick(emojis),
    pick(colors),
    "",
  };
}

val profileValue(const Profile& source) {
  val result = val::object();
  result.set("name", source.name);
  result.set("emoji", source.emoji);
  result.set("color", source.color);
  result.set("avatar", source.avatar.empty() ? val::null() : val(source.avatar));
  return result;
}

Profile profileFromValue(const val& source) {
  Profile result;
  result.name = stringProperty(source, "name", "guest");
  result.emoji = stringProperty(source, "emoji", "🙂");
  result.color = stringProperty(source, "color", "#46d39a");
  result.avatar = stringProperty(source, "avatar");
  return result;
}

void saveProfile() {
  val storage = windowObject["localStorage"];
  storage.call<void>("setItem", js("vc-profile"), json.call<val>("stringify", profileValue(profile)));
}

bool looksPurple(const std::string& hex) {
  if (hex.size() != 7 || hex.front() != '#') return false;
  const int packed = std::strtol(hex.c_str() + 1, nullptr, 16);
  const int red = (packed >> 16) & 255;
  const int green = (packed >> 8) & 255;
  const int blue = packed & 255;
  return blue > green + 80 && blue > red + 40;
}

void loadProfile() {
  profile = randomProfile();
  val saved = windowObject["localStorage"].call<val>("getItem", js("vc-profile"));
  if (present(saved)) {
    val decoded = json.call<val>("parse", saved);
    if (present(decoded) && !stringProperty(decoded, "name").empty()) {
      Profile loaded = profileFromValue(decoded);
      if (looksPurple(loaded.color)) loaded.color = "#2dd4bf";
      if (!loaded.name.empty()) profile = std::move(loaded);
    }
  } else {
    saveProfile();
  }
}

void loadSettings() {
  val storage = windowObject["localStorage"];
  val savedMic = storage.call<val>("getItem", js("vc-microphone"));
  if (present(savedMic)) preferredMic = savedMic.as<std::string>();
  val savedPtt = storage.call<val>("getItem", js("vc-push-to-talk"));
  pushToTalk = present(savedPtt) && savedPtt.as<std::string>() == "true";
  val savedListenKey = storage.call<val>("getItem", js("vc-listen-key"));
  if (present(savedListenKey)) listenKey = savedListenKey.as<std::string>();
  muted = pushToTalk;
}

void paintAvatar(val element, const Profile& source) {
  val style = element["style"];
  if (!source.avatar.empty()) {
    const std::string escaped = json.call<val>("stringify", source.avatar).as<std::string>();
    style.set("backgroundImage", "url(" + escaped + ")");
    style.set("backgroundColor", js("transparent"));
    element.set("textContent", std::string());
  } else {
    style.set("backgroundImage", js("none"));
    style.set("backgroundColor", source.color);
    element.set("textContent", source.emoji.empty() ? js("🙂") : source.emoji);
  }
}

void updateRoomCount() {
  const int count = static_cast<int>(peers.size());
  byId("peerCount").set("textContent", std::to_string(count));
  byId("peerCountLabel").set("textContent", js("connected"));
  byId("empty").set("hidden", count > 1);
}

Peer* peerFor(const std::string& id) {
  const auto found = peers.find(id);
  return found == peers.end() ? nullptr : found->second.get();
}

void setStatus(const std::string& text, const std::string& state = "") {
  byId("status").set("textContent", text);
  byId("statusDot").set("className", state.empty() ? "dot" : "dot " + state);
}

void onPeerVolume(const std::string& id, val event);

val cardFor(Peer& peer) {
  if (present(peer.card)) return peer.card;

  val card = document.call<val>("createElement", js("li"));
  card.set("className", js("peer"));

  val avatar = document.call<val>("createElement", js("div"));
  avatar.set("className", js("avatar"));
  avatar.set("ariaHidden", js("true"));
  card.call<val>("append", avatar);

  val name = document.call<val>("createElement", js("div"));
  name.set("className", js("name"));
  card.call<val>("append", name);

  if (peer.id == myId) {
    card["classList"].call<void>("add", js("me"));
    byId("grid").call<val>("prepend", card);
  } else {
    val volume = document.call<val>("createElement", js("label"));
    volume.set("className", js("volume"));
    val caption = document.call<val>("createElement", js("span"));
    caption.set("textContent", js("VOL"));
    val input = document.call<val>("createElement", js("input"));
    input.set("type", js("range"));
    input.set("min", js("0"));
    input.set("max", js("1"));
    input.set("step", js("0.05"));
    input.set("value", js("1"));
    input.call<void>("addEventListener", js("input"), callback("onPeerVolume", peer.id));
    volume.call<val>("append", caption, input);
    card.call<val>("append", volume);
    peer.volumeInput = input;

    val safety = document.call<val>("createElement", js("span"));
    safety.set("className", js("safety-code"));
    safety.set("textContent", js("◆ DTLS-SRTP"));
    safety.call<void>(
      "setAttribute",
      js("title"),
      js("This connection is encrypted. A verification code appears after it connects.")
    );
    card.call<val>("append", safety);
    peer.safetyCode = safety;
    byId("grid").call<val>("append", card);
  }

  peer.card = card;
  return peer.card;
}

void renderPeer(const std::string& id) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  val card = cardFor(*peer);
  paintAvatar(card.call<val>("querySelector", js(".avatar")), peer->profile);
  card.call<val>("querySelector", js(".name")).set("textContent", peer->profile.name);
  card["classList"].call<void>("toggle", js("muted"), peer->muted);
  card["classList"].call<void>("toggle", js("encrypted"), peer->encrypted);
  card["classList"].call<void>("toggle", js("unlocked"), peer->encrypted && peer->decrypting);
  if (present(peer->volumeInput)) {
    peer->volumeInput.call<void>(
      "setAttribute",
      js("aria-label"),
      "Volume for " + peer->profile.name
    );
  }
  updateRoomCount();
}

void updateKeyStatus() {
  int encryptedPeers = 0;
  int openPeers = 0;
  for (const auto& [id, peer] : peers) {
    if (id == myId || !peer->encrypted) continue;
    ++encryptedPeers;
    if (peer->decrypting) ++openPeers;
  }

  val status = byId("keyStatus");
  if (listenKey.empty()) {
    status.set(
      "textContent",
      encryptedPeers
        ? "Paste their key to hear " + std::to_string(encryptedPeers) + " encrypted stream(s)."
        : js("No listening key set.")
    );
    status.set("className", js("key-status"));
  } else if (!encryptedPeers) {
    status.set("textContent", js("Key loaded. Nobody else is encrypting."));
    status.set("className", js("key-status ok"));
  } else {
    status.set(
      "textContent",
      "Key opens " + std::to_string(openPeers) + " of "
        + std::to_string(encryptedPeers) + " encrypted stream(s)."
    );
    status.set("className", openPeers ? js("key-status ok") : js("key-status bad"));
  }
}

void onEnvelopeOpened(const std::string& id, val raw) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  peer->decrypting = present(raw);
  val cipher = val::global("voiceCipher");
  if (present(cipher)) cipher.call<val>("setReceiveKey", id, raw);
  renderPeer(id);
  updateKeyStatus();
}

void applyEnvelope(const std::string& id, const std::string& envelope) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  peer->envelope = envelope;
  if (envelope.empty() || listenKey.empty()) {
    onEnvelopeOpened(id, val::null());
    return;
  }
  val keys = val::global("voiceKeys");
  keys.call<val>("openSessionKey", envelope, listenKey)
    .call<val>("then", callback("onEnvelopeOpened", id));
}

void refreshAllEnvelopes() {
  std::vector<std::pair<std::string, std::string>> envelopes;
  for (const auto& [id, peer] : peers) {
    if (id != myId) envelopes.emplace_back(id, peer->envelope);
  }
  for (const auto& [id, envelope] : envelopes) applyEnvelope(id, envelope);
  updateKeyStatus();
}

void stopMeter(Peer& peer) {
  if (peer.meterTimer) {
    emscripten_clear_interval(peer.meterTimer);
    peer.meterTimer = 0;
  }
  if (present(peer.source)) peer.source.call<void>("disconnect");
  peer.source = val::undefined();
  peer.analyser = val::undefined();
}

void removePeer(const std::string& id) {
  const auto found = peers.find(id);
  if (found == peers.end()) return;
  Peer& peer = *found->second;
  if (present(peer.pc)) peer.pc.call<void>("close");
  stopMeter(peer);
  if (present(peer.audioElement)) peer.audioElement.call<void>("remove");
  if (present(peer.card)) peer.card.call<void>("remove");
  val cipher = val::global("voiceCipher");
  if (present(cipher)) cipher.call<void>("forgetPeer", id);
  peers.erase(found);
  updateRoomCount();
  updateKeyStatus();
}

void showUnblock() {
  if (audioBlocked) return;
  audioBlocked = true;
  byId("unblock").set("hidden", false);
}

val ensureAudioContext() {
  if (!present(audioContext)) {
    val constructor = windowObject["AudioContext"];
    if (!present(constructor)) constructor = windowObject["webkitAudioContext"];
    if (!present(constructor)) return val::undefined();
    audioContext = constructor.new_();
  }
  if (stringProperty(audioContext, "state") == "suspended") {
    audioContext.call<val>("resume");
    showUnblock();
  }
  return audioContext;
}

void meterTick(void* pointer) {
  auto* peer = static_cast<Peer*>(pointer);
  if (!peer || !present(peer->analyser)) return;
  peer->analyser.call<void>(
    "getFloatTimeDomainData",
    val(emscripten::typed_memory_view(peer->meterBuffer.size(), peer->meterBuffer.data()))
  );
  double sum = 0.0;
  for (const float sample : peer->meterBuffer) sum += sample * sample;
  const double rms = std::sqrt(sum / static_cast<double>(peer->meterBuffer.size()));

  bool nextSpeaking = peer->speaking;
  if (rms > 0.045) {
    peer->quietFrames = 0;
    nextSpeaking = true;
  } else if (peer->speaking && ++peer->quietFrames > 6) {
    nextSpeaking = false;
  }

  if (nextSpeaking != peer->speaking) {
    peer->speaking = nextSpeaking;
    if (present(peer->card)) {
      peer->card["classList"].call<void>("toggle", js("speaking"), nextSpeaking && !peer->muted);
    }
  }
}

void watchSpeaking(Peer& peer, const val& stream) {
  stopMeter(peer);
  val context = ensureAudioContext();
  if (!present(context)) return;
  peer.source = context.call<val>("createMediaStreamSource", stream);
  peer.analyser = context.call<val>("createAnalyser");
  peer.analyser.set("fftSize", 512);
  peer.source.call<val>("connect", peer.analyser);
  peer.meterTimer = emscripten_set_interval(meterTick, 60, &peer);
}

bool socketOpen() {
  return present(ws) && ws["readyState"].as<int>() == 1;
}

void sendValue(const val& value) {
  if (socketOpen()) ws.call<void>("send", json.call<val>("stringify", value));
}

void signal(const std::string& target, const val& data) {
  val message = val::object();
  message.set("type", js("signal"));
  message.set("to", target);
  message.set("data", data);
  sendValue(message);
}

val rtcConfiguration() {
  val urls = val::array();
  urls.call<void>("push", js("stun:stun.l.google.com:19302"));
  urls.call<void>("push", js("stun:stun1.l.google.com:19302"));
  val stun = val::object();
  stun.set("urls", urls);
  val servers = val::array();
  servers.call<void>("push", stun);
  val configuration = val::object();
  configuration.set("iceServers", servers);
  val cipher = val::global("voiceCipher");
  if (present(cipher)) {
    val options = cipher.call<val>("pcCipherOptions");
    val encodedInsertableStreams = options["encodedInsertableStreams"];
    if (present(encodedInsertableStreams)) {
      configuration.set("encodedInsertableStreams", encodedInsertableStreams);
    }
  }
  return configuration;
}

void onIceCandidate(const std::string& id, val event) {
  val candidate = event["candidate"];
  if (!present(candidate)) return;
  val data = val::object();
  data.set("candidate", candidate);
  signal(id, data);
}

void sendLocalDescription(const std::string& id) {
  Peer* peer = peerFor(id);
  if (!peer || !present(peer->pc)) return;
  val data = val::object();
  data.set("sdp", peer->pc["localDescription"]);
  signal(id, data);
}

void warnPromise(val error) {
  val::global("console").call<void>("warn", js("WebRTC operation failed"), error);
}

void onNegotiationNeeded(const std::string& id) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  peer->pc.call<val>("setLocalDescription")
    .call<val>("then", callback("sendLocalDescription", id))
    .call<val>("catch", callback("warnPromise"));
}

void attachReceiveCiphers(const std::string& id) {
  Peer* peer = peerFor(id);
  if (!peer || !present(peer->pc)) return;
  val transceivers = peer->pc.call<val>("getTransceivers");
  val cipher = val::global("voiceCipher");
  for (int i = 0; i < transceivers["length"].as<int>(); ++i) {
    val receiver = transceivers[i]["receiver"];
    if (present(receiver) && present(cipher)) {
      cipher.call<void>("installReceiverCipher", receiver, id);
    }
  }
}

void onRemoteDescriptionSet(const std::string& id, bool offer) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  // Chrome must see the decrypt transform before media starts flowing.
  attachReceiveCiphers(id);
  for (const val& candidate : peer->pendingCandidates) {
    peer->pc.call<val>("addIceCandidate", candidate);
  }
  peer->pendingCandidates.clear();
  if (offer) {
    peer->pc.call<val>("setLocalDescription")
      .call<val>("then", callback("sendLocalDescription", id))
      .call<val>("catch", callback("warnPromise"));
  }
}

void onRemoteOfferSet(const std::string& id) {
  onRemoteDescriptionSet(id, true);
}

void onRemoteAnswerSet(const std::string& id) {
  onRemoteDescriptionSet(id, false);
}

void onSignal(const std::string& from, const val& data) {
  Peer* peer = peerFor(from);
  if (!peer || !present(peer->pc)) return;

  val description = data["sdp"];
  val candidate = data["candidate"];
  if (present(description)) {
    const bool offer = stringProperty(description, "type") == "offer";
    peer->pc.call<val>("setRemoteDescription", description)
      .call<val>("then", callback(offer ? "onRemoteOfferSet" : "onRemoteAnswerSet", from))
      .call<val>("catch", callback("warnPromise"));
  } else if (present(candidate)) {
    if (present(peer->pc["remoteDescription"])) {
      peer->pc.call<val>("addIceCandidate", candidate)
        .call<val>("catch", callback("warnPromise"));
    } else {
      peer->pendingCandidates.push_back(candidate);
    }
  }
}

void onTrack(const std::string& id, val event) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  val cipher = val::global("voiceCipher");
  if (present(cipher) && present(event["receiver"])) {
    cipher.call<void>("installReceiverCipher", event["receiver"], id);
  }
  val streams = event["streams"];
  if (streams["length"].as<int>() == 0) return;
  val stream = streams[0];

  if (present(peer->audioElement)) peer->audioElement.call<void>("remove");
  val audio = val::global("Audio").new_();
  audio.set("srcObject", stream);
  audio.set("autoplay", true);
  audio.set("playsInline", true);
  audio.set("volume", peer->volume);
  peer->audioElement = audio;
  byId("audio").call<val>("append", audio);
  audio.call<val>("play").call<val>("catch", callback("showUnblock"));
  watchSpeaking(*peer, stream);
}

void onSecurityDigest(const std::string& id, val buffer) {
  Peer* peer = peerFor(id);
  if (!peer || !present(peer->safetyCode)) return;
  val bytes = val::global("Uint8Array").new_(buffer);
  constexpr char digits[] = "0123456789ABCDEF";
  std::string code;
  for (int i = 0; i < 6; ++i) {
    if (i && i % 2 == 0) code.push_back(' ');
    const int byte = bytes[i].as<int>();
    code.push_back(digits[(byte >> 4) & 15]);
    code.push_back(digits[byte & 15]);
  }
  peer->safetyCode.set("textContent", "◆ " + code);
  peer->safetyCode.call<void>(
    "setAttribute",
    js("title"),
    js("Compare this safety code with this person through another trusted channel.")
  );
}

void onSecurityStats(const std::string& id, val report) {
  Peer* peer = peerFor(id);
  if (!peer) return;

  val transport = val::undefined();
  val iterator = report.call<val>("values");
  while (true) {
    val item = iterator.call<val>("next");
    if (item["done"].as<bool>()) break;
    val stat = item["value"];
    if (stringProperty(stat, "type") == "transport"
        && !stringProperty(stat, "localCertificateId").empty()
        && !stringProperty(stat, "remoteCertificateId").empty()) {
      transport = stat;
      break;
    }
  }
  if (!present(transport)) return;

  val localCertificate = report.call<val>("get", stringProperty(transport, "localCertificateId"));
  val remoteCertificate = report.call<val>("get", stringProperty(transport, "remoteCertificateId"));
  std::string localFingerprint = stringProperty(localCertificate, "fingerprint");
  std::string remoteFingerprint = stringProperty(remoteCertificate, "fingerprint");
  if (localFingerprint.empty() || remoteFingerprint.empty()) return;
  if (localFingerprint > remoteFingerprint) std::swap(localFingerprint, remoteFingerprint);

  val encoded = val::global("TextEncoder").new_().call<val>(
    "encode",
    localFingerprint + "|" + remoteFingerprint
  );
  val crypto = val::global("crypto");
  crypto["subtle"].call<val>("digest", js("SHA-256"), encoded)
    .call<val>("then", callback("onSecurityDigest", id))
    .call<val>("catch", callback("warnPromise"));
}

void onConnectionStateChange(const std::string& id) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  const std::string state = stringProperty(peer->pc, "connectionState");
  if (state == "failed") {
    peer->pc.call<void>("restartIce");
  } else if (state == "connected") {
    peer->pc.call<val>("getStats")
      .call<val>("then", callback("onSecurityStats", id))
      .call<val>("catch", callback("warnPromise"));
  }
}

void connectTo(const std::string& id, const val& publicPeer, bool initiator) {
  removePeer(id);
  auto entry = std::make_unique<Peer>(id);
  entry->profile = profileFromValue(publicPeer["profile"]);
  entry->muted = publicPeer["muted"].as<bool>();
  entry->encrypted = present(publicPeer["encrypted"]) && publicPeer["encrypted"].as<bool>();
  entry->envelope = stringProperty(publicPeer, "envelope");
  Peer& peer = *entry;
  peers.emplace(id, std::move(entry));

  peer.pc = val::global("RTCPeerConnection").new_(rtcConfiguration());
  val tracks = localStream.call<val>("getTracks");
  const int trackCount = tracks["length"].as<int>();
  for (int i = 0; i < trackCount; ++i) {
    val sender = peer.pc.call<val>("addTrack", tracks[i], localStream);
    val cipher = val::global("voiceCipher");
    if (present(cipher)) cipher.call<void>("installSenderCipher", sender);
  }
  attachReceiveCiphers(id);

  peer.pc.set("onicecandidate", callback("onIceCandidate", id));
  peer.pc.set("ontrack", callback("onTrack", id));
  peer.pc.set("onconnectionstatechange", callback("onConnectionStateChange", id));
  if (initiator) {
    peer.pc.set("onnegotiationneeded", callback("onNegotiationNeeded", id));
  }
  applyEnvelope(id, peer.envelope);
  renderPeer(id);
}

void updateMuteUi() {
  val button = byId("muteBtn");
  std::string label;
  std::string icon;
  bool talking = false;

  if (pushToTalk) {
    if (manualMuted) {
      label = "Muted";
      icon = "×";
    } else {
      talking = !muted;
      label = talking ? "Talking" : "Hold to talk";
      icon = talking ? "◉" : "●";
    }
  } else {
    label = muted ? "Unmute" : "Mute";
    icon = muted ? "×" : "●";
  }

  byId("muteLabel").set("textContent", label);
  byId("muteIco").set("textContent", icon);
  button["classList"].call<void>("toggle", js("off"), muted);
  button["classList"].call<void>("toggle", js("talking"), talking);
  button.call<void>(
    "setAttribute",
    js("aria-pressed"),
    muted ? js("true") : js("false")
  );
}

void pushUpdate() {
  val message = val::object();
  message.set("type", js("update"));
  message.set("profile", profileValue(profile));
  message.set("muted", muted);
  message.set("encrypted", encrypting);
  message.set("envelope", sessionEnvelope.empty() ? val::null() : val(sessionEnvelope));
  sendValue(message);

  Peer* self = peerFor(myId);
  if (self) {
    self->profile = profile;
    self->muted = muted;
    self->encrypted = encrypting;
    renderPeer(myId);
  }
}

void syncAudioState() {
  const bool nextMuted = manualMuted || (pushToTalk && !pushPressed);
  const bool changed = nextMuted != muted;
  muted = nextMuted;
  if (present(localStream)) {
    val tracks = localStream.call<val>("getAudioTracks");
    for (int i = 0; i < tracks["length"].as<int>(); ++i) {
      tracks[i].set("enabled", !muted);
    }
  }
  updateMuteUi();
  if (changed) pushUpdate();
}

void onWsOpen(val) {
  reconnectDelay = 1000;
  val message = val::object();
  message.set("type", js("join"));
  message.set("profile", profileValue(profile));
  message.set("muted", muted);
  message.set("encrypted", encrypting);
  message.set("envelope", sessionEnvelope.empty() ? val::null() : val(sessionEnvelope));
  sendValue(message);
}

void onWsMessage(val event) {
  val message = json.call<val>("parse", event["data"]);
  const std::string type = stringProperty(message, "type");
  if (type == "welcome") {
    myId = stringProperty(message, "id");
    auto self = std::make_unique<Peer>(myId);
    self->profile = profile;
    self->muted = muted;
    self->encrypted = encrypting;
    Peer& selfReference = *self;
    peers.emplace(myId, std::move(self));
    renderPeer(myId);
    watchSpeaking(selfReference, localStream);

    val roster = message["peers"];
    const int count = roster["length"].as<int>();
    setStatus(count ? "connected" : "connected — waiting for others", "live");
    for (int i = 0; i < count; ++i) {
      val publicPeer = roster[i];
      connectTo(stringProperty(publicPeer, "id"), publicPeer, true);
    }
    updateKeyStatus();
  } else if (type == "peer-join") {
    val publicPeer = message["peer"];
    connectTo(stringProperty(publicPeer, "id"), publicPeer, false);
    setStatus("connected", "live");
  } else if (type == "peer-leave") {
    removePeer(stringProperty(message, "id"));
    if (peers.size() == 1) setStatus("connected — waiting for others", "live");
  } else if (type == "peer-update") {
    val publicPeer = message["peer"];
    Peer* peer = peerFor(stringProperty(publicPeer, "id"));
    if (peer) {
      peer->profile = profileFromValue(publicPeer["profile"]);
      peer->muted = publicPeer["muted"].as<bool>();
      peer->encrypted = present(publicPeer["encrypted"]) && publicPeer["encrypted"].as<bool>();
      applyEnvelope(peer->id, stringProperty(publicPeer, "envelope"));
      renderPeer(peer->id);
    }
  } else if (type == "signal") {
    onSignal(stringProperty(message, "from"), message["data"]);
  } else if (type == "full") {
    setStatus("the channel is full (" + std::to_string(message["max"].as<int>()) + " people)", "error");
  }
}

void connectSocket();

void reconnect(void*) {
  connectSocket();
}

void onWsClose(val) {
  std::vector<std::string> ids;
  ids.reserve(peers.size());
  for (const auto& [id, _] : peers) ids.push_back(id);
  for (const std::string& id : ids) removePeer(id);
  myId.clear();
  setStatus("reconnecting…");
  emscripten_async_call(reconnect, nullptr, reconnectDelay);
  reconnectDelay = std::min(reconnectDelay * 2, 10'000);
}

void onWsError(val) {
  if (present(ws)) ws.call<void>("close");
}

void connectSocket() {
  const std::string protocol = stringProperty(windowObject["location"], "protocol") == "https:"
    ? "wss://" : "ws://";
  ws = val::global("WebSocket").new_(protocol + stringProperty(windowObject["location"], "host"));
  ws.set("onopen", callback("onWsOpen"));
  ws.set("onmessage", callback("onWsMessage"));
  ws.set("onclose", callback("onWsClose"));
  ws.set("onerror", callback("onWsError"));
}

val audioConstraints(const std::string& deviceId) {
  val audio = val::object();
  audio.set("echoCancellation", true);
  audio.set("noiseSuppression", true);
  audio.set("autoGainControl", true);
  if (!deviceId.empty()) {
    val exact = val::object();
    exact.set("exact", deviceId);
    audio.set("deviceId", exact);
  }
  val constraints = val::object();
  constraints.set("audio", audio);
  constraints.set("video", false);
  return constraints;
}

void requestInitialMicrophone(const std::string& deviceId) {
  navigatorObject["mediaDevices"].call<val>("getUserMedia", audioConstraints(deviceId))
    .call<val>("then", callback("onInitialMicReady"))
    .call<val>("catch", callback("onInitialMicError"));
}

void populateMicrophones();

void onSessionEnvelope(val envelope) {
  sessionEnvelope = envelope.as<std::string>();
  if (microphoneReady && !present(ws)) {
    setStatus("connecting…");
    connectSocket();
  } else if (present(ws)) {
    pushUpdate();
    showIdentity();
    setStatus("connected", "live");
  } else {
    showIdentity();
  }
}

void onSendKeyInstalled(val) {
  val::global("voiceKeys").call<val>(
    "sealSessionKey",
    sessionKeyRaw,
    stringProperty(identity, "publicKey")
  ).call<val>("then", callback("onSessionEnvelope"))
    .call<val>("catch", callback("warnPromise"));
}

void rotateSessionKey() {
  sessionKeyRaw = val::global("crypto").call<val>(
    "getRandomValues",
    val::global("Uint8Array").new_(32)
  );
  val::global("voiceCipher").call<val>("setSendKey", sessionKeyRaw)
    .call<val>("then", callback("onSendKeyInstalled"))
    .call<val>("catch", callback("warnPromise"));
}

void onIdentityReady(val loadedIdentity) {
  identity = loadedIdentity;
  rotateSessionKey();
}

void onNewIdentity(val loadedIdentity) {
  identity = loadedIdentity;
  setStatus("rotating encryption key…");
  rotateSessionKey();
}

void makeNewKey(val) {
  val::global("voiceKeys").call<val>("newIdentity")
    .call<val>("then", callback("onNewIdentity"))
    .call<val>("catch", callback("warnPromise"));
}

void onInitialMicReady(val stream) {
  localStream = stream;
  microphoneReady = true;
  val tracks = localStream.call<val>("getAudioTracks");
  for (int i = 0; i < tracks["length"].as<int>(); ++i) tracks[i].set("enabled", !muted);
  setStatus("preparing keys…");
  populateMicrophones();
  val::global("voiceKeys").call<val>("loadIdentity")
    .call<val>("then", callback("onIdentityReady"))
    .call<val>("catch", callback("warnPromise"));
}

void onInitialMicError(val) {
  if (!preferredMic.empty() && !micFallbackTried) {
    micFallbackTried = true;
    preferredMic.clear();
    windowObject["localStorage"].call<void>("removeItem", js("vc-microphone"));
    requestInitialMicrophone("");
    return;
  }
  setStatus("microphone blocked — allow it and reload", "error");
}

void onDevices(val devices) {
  val select = byId("micSelect");
  select.set("textContent", std::string());
  int microphoneNumber = 0;
  const int count = devices["length"].as<int>();
  for (int i = 0; i < count; ++i) {
    val device = devices[i];
    if (stringProperty(device, "kind") != "audioinput") continue;
    ++microphoneNumber;
    const std::string id = stringProperty(device, "deviceId");
    std::string label = stringProperty(device, "label");
    if (label.empty()) label = microphoneNumber == 1
      ? "System default" : "Microphone " + std::to_string(microphoneNumber);
    val option = document.call<val>("createElement", js("option"));
    option.set("value", id);
    option.set("textContent", label);
    if (id == preferredMic) option.set("selected", true);
    select.call<val>("append", option);
  }
  select.set("disabled", microphoneNumber == 0);
}

void populateMicrophones() {
  val mediaDevices = navigatorObject["mediaDevices"];
  if (!present(mediaDevices["enumerateDevices"])) return;
  mediaDevices.call<val>("enumerateDevices")
    .call<val>("then", callback("onDevices"))
    .call<val>("catch", callback("warnPromise"));
}

void onMicChanged(const std::string& requestedId, val stream) {
  val newTracks = stream.call<val>("getAudioTracks");
  if (newTracks["length"].as<int>() == 0) return;
  val newTrack = newTracks[0];
  newTrack.set("enabled", !muted);

  for (auto& [_, entry] : peers) {
    if (!present(entry->pc)) continue;
    val senders = entry->pc.call<val>("getSenders");
    for (int i = 0; i < senders["length"].as<int>(); ++i) {
      val sender = senders[i];
      val track = sender["track"];
      if (present(track) && stringProperty(track, "kind") == "audio") {
        sender.call<val>("replaceTrack", newTrack);
      }
    }
  }

  if (present(localStream)) {
    val oldTracks = localStream.call<val>("getTracks");
    for (int i = 0; i < oldTracks["length"].as<int>(); ++i) oldTracks[i].call<void>("stop");
  }
  localStream = stream;
  preferredMic = requestedId;
  val settings = newTrack.call<val>("getSettings");
  const std::string actualId = stringProperty(settings, "deviceId");
  if (!actualId.empty()) preferredMic = actualId;
  windowObject["localStorage"].call<void>("setItem", js("vc-microphone"), preferredMic);

  Peer* self = peerFor(myId);
  if (self) watchSpeaking(*self, localStream);
  byId("micSelect").set("disabled", false);
  byId("settingsNote").set("textContent", js("Microphone changed."));
  populateMicrophones();
}

void onMicChangeError(val) {
  byId("micSelect").set("disabled", false);
  byId("settingsNote").set("textContent", js("Could not open that microphone."));
}

void onMicSelect(val event) {
  const std::string requestedId = event["target"]["value"].as<std::string>();
  byId("micSelect").set("disabled", true);
  byId("settingsNote").set("textContent", js("Switching microphone…"));
  navigatorObject["mediaDevices"].call<val>("getUserMedia", audioConstraints(requestedId))
    .call<val>("then", callback("onMicChanged", requestedId))
    .call<val>("catch", callback("onMicChangeError"));
}

void onPeerVolume(const std::string& id, val event) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  peer->volume = std::clamp(std::stod(event["target"]["value"].as<std::string>()), 0.0, 1.0);
  if (present(peer->audioElement)) peer->audioElement.set("volume", peer->volume);
}

void refreshPreview() {
  paintAvatar(byId("preview"), profile);
  byId("nameInput").set("value", profile.name);
}

void openProfile(val) {
  refreshPreview();
  byId("profileSheet").set("hidden", false);
  byId("nameInput").call<void>("focus");
}

void closeProfile(val) {
  byId("profileSheet").set("hidden", true);
}

void saveProfileEditor(val) {
  std::string name = byId("nameInput")["value"].as<std::string>();
  const auto first = name.find_first_not_of(" \t\r\n");
  const auto last = name.find_last_not_of(" \t\r\n");
  if (first != std::string::npos) name = name.substr(first, last - first + 1);
  if (!name.empty()) profile.name = name.substr(0, 24);
  saveProfile();
  pushUpdate();
  closeProfile(val::undefined());
}

void rerollProfile(val) {
  std::string nextEmoji = profile.emoji;
  std::string nextColor = profile.color;
  while (nextEmoji == profile.emoji) nextEmoji = pick(emojis);
  while (nextColor == profile.color) nextColor = pick(colors);
  profile.emoji = std::move(nextEmoji);
  profile.color = std::move(nextColor);
  profile.avatar.clear();
  refreshPreview();
  saveProfile();
  pushUpdate();
}

void onImageLoad(const std::string& url, val event) {
  val image = event["currentTarget"];
  constexpr int size = 192;
  val canvas = document.call<val>("createElement", js("canvas"));
  canvas.set("width", size);
  canvas.set("height", size);
  val context = canvas.call<val>("getContext", js("2d"));
  const double width = image["width"].as<double>();
  const double height = image["height"].as<double>();
  const double side = std::min(width, height);
  context.call<void>(
    "drawImage",
    image,
    (width - side) / 2.0,
    (height - side) / 2.0,
    side,
    side,
    0,
    0,
    size,
    size
  );
  val::global("URL").call<void>("revokeObjectURL", url);
  profile.avatar = canvas.call<val>("toDataURL", js("image/jpeg"), 0.82).as<std::string>();
  refreshPreview();
  saveProfile();
  pushUpdate();
  byId("fileInput").set("value", std::string());
}

void onImageError(const std::string& url, val) {
  val::global("URL").call<void>("revokeObjectURL", url);
  val::global("alert")(js("Could not read that image."));
  byId("fileInput").set("value", std::string());
}

void onFileInput(val event) {
  val files = event["target"]["files"];
  if (files["length"].as<int>() == 0) return;
  const std::string url = val::global("URL").call<val>("createObjectURL", files[0]).as<std::string>();
  val image = val::global("Image").new_();
  image.set("onload", callback("onImageLoad", url));
  image.set("onerror", callback("onImageError", url));
  image.set("src", url);
}

void openSettings(val) {
  byId("settingsNote").set("textContent", std::string());
  byId("pttToggle").set("checked", pushToTalk);
  populateMicrophones();
  byId("settingsSheet").set("hidden", false);
  byId("micSelect").call<void>("focus");
}

void closeSettings(val) {
  byId("settingsSheet").set("hidden", true);
}

void openSecurity(val) {
  byId("securitySheet").set("hidden", false);
  byId("securityCloseBtn").call<void>("focus");
}

void closeSecurity(val) {
  byId("securitySheet").set("hidden", true);
}

void onPushToTalkToggle(val event) {
  pushToTalk = event["target"]["checked"].as<bool>();
  pushPressed = false;
  manualMuted = false;
  windowObject["localStorage"].call<void>(
    "setItem",
    js("vc-push-to-talk"),
    pushToTalk ? js("true") : js("false")
  );
  syncAudioState();
}

void updateEncryptionUi() {
  val button = byId("encryptBtn");
  button["classList"].call<void>("toggle", js("on"), encrypting);
  button.call<void>("setAttribute", js("aria-pressed"), encrypting ? js("true") : js("false"));
  byId("encryptLabel").set("textContent", encrypting ? js("Encryption on") : js("Encryption off"));
  byId("encryptNote").set("hidden", !encrypting);
}

void onEncryptClick(val) {
  val cipher = val::global("voiceCipher");
  if (!present(cipher) || !cipher["cipherSupported"].as<bool>()) return;
  encrypting = !encrypting;
  cipher.call<void>("setEncryptionEnabled", encrypting);
  updateEncryptionUi();
  pushUpdate();
}

void onFingerprint(val fingerprintValue) {
  byId("myKeyPrint").set("textContent", fingerprintValue);
}

void showIdentity() {
  if (!present(identity)) return;
  byId("myKey").set("value", stringProperty(identity, "privateKey"));
  byId("listenInput").set("value", listenKey);
  val::global("voiceKeys").call<val>(
    "fingerprint",
    stringProperty(identity, "publicKey")
  ).call<val>("then", callback("onFingerprint"));
  updateKeyStatus();
}

void openKeys(val) {
  showIdentity();
  byId("keySheet").set("hidden", false);
  byId("keyCloseBtn").call<void>("focus");
}

void closeKeys(val) {
  byId("keySheet").set("hidden", true);
}

void keyCopyReset(void*) {
  byId("copyKeyLabel").set("textContent", js("Copy key"));
}

void onKeyCopySuccess(val = val::undefined()) {
  byId("copyKeyLabel").set("textContent", js("Copied!"));
  emscripten_async_call(keyCopyReset, nullptr, 1500);
}

void onKeyCopyFallback(val = val::undefined()) {
  byId("myKey").call<void>("select");
  byId("copyKeyLabel").set("textContent", js("Press Ctrl+C"));
  emscripten_async_call(keyCopyReset, nullptr, 1800);
}

void copyKey(val) {
  if (!present(identity)) return;
  val clipboard = navigatorObject["clipboard"];
  if (present(clipboard) && present(clipboard["writeText"])) {
    clipboard.call<val>("writeText", stringProperty(identity, "privateKey"))
      .call<val>("then", callback("onKeyCopySuccess"))
      .call<val>("catch", callback("onKeyCopyFallback"));
  } else {
    onKeyCopyFallback();
  }
}

void onListenValidated(val valid) {
  const std::string candidate = byId("listenInput")["value"].as<std::string>();
  if (!valid.as<bool>()) {
    byId("keyStatus").set("textContent", js("That is not a valid RSA private key."));
    byId("keyStatus").set("className", js("key-status bad"));
    return;
  }
  listenKey = candidate;
  windowObject["localStorage"].call<void>("setItem", js("vc-listen-key"), listenKey);
  refreshAllEnvelopes();
}

void listenWithKey(val) {
  const std::string candidate = byId("listenInput")["value"].as<std::string>();
  if (candidate.empty()) {
    onListenValidated(val(true));
    return;
  }
  val::global("voiceKeys").call<val>("validatePrivateKey", candidate)
    .call<val>("then", callback("onListenValidated"));
}

void clearListenKey(val) {
  listenKey.clear();
  byId("listenInput").set("value", std::string());
  windowObject["localStorage"].call<void>("removeItem", js("vc-listen-key"));
  refreshAllEnvelopes();
}

void onMuteClick(val) {
  if (pushToTalk) return;
  manualMuted = !manualMuted;
  syncAudioState();
}

void onMutePointerDown(val event) {
  if (!pushToTalk) return;
  event.call<void>("preventDefault");
  pushPressed = true;
  syncAudioState();
}

void releasePushToTalk() {
  if (!pushToTalk || !pushPressed) return;
  pushPressed = false;
  syncAudioState();
}

bool typingInControl() {
  val active = document["activeElement"];
  const std::string tag = stringProperty(active, "tagName");
  return tag == "INPUT" || tag == "SELECT" || tag == "TEXTAREA"
    || (present(active["isContentEditable"]) && active["isContentEditable"].as<bool>());
}

void onKeyDown(val event) {
  if (typingInControl()) return;
  const std::string key = stringProperty(event, "key");
  if (key == "m" || key == "M") {
    manualMuted = !manualMuted;
    syncAudioState();
  } else if (key == " " && pushToTalk && !event["repeat"].as<bool>()) {
    event.call<void>("preventDefault");
    pushPressed = true;
    syncAudioState();
  } else if (key == "Escape") {
    closeProfile(val::undefined());
    closeSettings(val::undefined());
    closeSecurity(val::undefined());
    closeKeys(val::undefined());
  }
}

void onKeyUp(val event) {
  if (stringProperty(event, "key") == " ") releasePushToTalk();
}

void onGlobalPointerUp(val) {
  releasePushToTalk();
}

void onOverlayClick(const std::string& sheetId, val event) {
  if (event["target"].strictlyEquals(byId(sheetId))) {
    byId(sheetId).set("hidden", true);
  }
}

void copyReset(void*) {
  byId("copyLabel").set("textContent", js("Invite"));
}

void onCopySuccess(val = val::undefined()) {
  byId("copyLabel").set("textContent", js("Copied!"));
  emscripten_async_call(copyReset, nullptr, 1500);
}

void onCopyFallback(val = val::undefined()) {
  val::global("prompt")(js("Copy this link:"), stringProperty(windowObject["location"], "href"));
}

void copyInvite(val) {
  val clipboard = navigatorObject["clipboard"];
  if (present(clipboard) && present(clipboard["writeText"])) {
    clipboard.call<val>("writeText", stringProperty(windowObject["location"], "href"))
      .call<val>("then", callback("onCopySuccess"))
      .call<val>("catch", callback("onCopyFallback"));
  } else {
    onCopyFallback();
  }
}

void unblockAudio(val) {
  if (present(audioContext)) audioContext.call<val>("resume");
  for (auto& [_, peer] : peers) {
    if (present(peer->audioElement)) peer->audioElement.call<val>("play");
  }
  audioBlocked = false;
  byId("unblock").set("hidden", true);
}

void resumeAudio(val) {
  if (present(audioContext) && stringProperty(audioContext, "state") == "suspended") {
    audioContext.call<val>("resume");
  }
}

void onBeforeUnload(val) {
  if (present(ws)) ws.call<void>("close");
}

void bindEvents() {
  byId("muteBtn").call<void>("addEventListener", js("click"), callback("onMuteClick"));
  byId("muteBtn").call<void>("addEventListener", js("pointerdown"), callback("onMutePointerDown"));
  byId("editBtn").call<void>("addEventListener", js("click"), callback("openProfile"));
  byId("profileCloseBtn").call<void>("addEventListener", js("click"), callback("closeProfile"));
  byId("doneBtn").call<void>("addEventListener", js("click"), callback("saveProfileEditor"));
  byId("rerollBtn").call<void>("addEventListener", js("click"), callback("rerollProfile"));
  byId("fileInput").call<void>("addEventListener", js("change"), callback("onFileInput"));
  byId("profileSheet").call<void>(
    "addEventListener",
    js("click"),
    callback("onOverlayClick", "profileSheet")
  );

  byId("settingsBtn").call<void>("addEventListener", js("click"), callback("openSettings"));
  byId("settingsCloseBtn").call<void>("addEventListener", js("click"), callback("closeSettings"));
  byId("settingsDoneBtn").call<void>("addEventListener", js("click"), callback("closeSettings"));
  byId("micSelect").call<void>("addEventListener", js("change"), callback("onMicSelect"));
  byId("pttToggle").call<void>("addEventListener", js("change"), callback("onPushToTalkToggle"));
  byId("settingsSheet").call<void>(
    "addEventListener",
    js("click"),
    callback("onOverlayClick", "settingsSheet")
  );

  byId("encryptBtn").call<void>("addEventListener", js("click"), callback("onEncryptClick"));
  byId("keyBtn").call<void>("addEventListener", js("click"), callback("openKeys"));
  byId("keyCloseBtn").call<void>("addEventListener", js("click"), callback("closeKeys"));
  byId("keyDoneBtn").call<void>("addEventListener", js("click"), callback("closeKeys"));
  byId("copyKeyBtn").call<void>("addEventListener", js("click"), callback("copyKey"));
  byId("newKeyBtn").call<void>("addEventListener", js("click"), callback("makeNewKey"));
  byId("listenBtn").call<void>("addEventListener", js("click"), callback("listenWithKey"));
  byId("clearListenBtn").call<void>("addEventListener", js("click"), callback("clearListenKey"));
  byId("keySheet").call<void>(
    "addEventListener",
    js("click"),
    callback("onOverlayClick", "keySheet")
  );

  byId("securityBtn").call<void>("addEventListener", js("click"), callback("openSecurity"));
  byId("securityCloseBtn").call<void>("addEventListener", js("click"), callback("closeSecurity"));
  byId("securityDoneBtn").call<void>("addEventListener", js("click"), callback("closeSecurity"));
  byId("securitySheet").call<void>(
    "addEventListener",
    js("click"),
    callback("onOverlayClick", "securitySheet")
  );

  byId("copyBtn").call<void>("addEventListener", js("click"), callback("copyInvite"));
  byId("emptyCopyBtn").call<void>("addEventListener", js("click"), callback("copyInvite"));
  byId("unblock").call<void>("addEventListener", js("click"), callback("unblockAudio"));

  document.call<void>("addEventListener", js("keydown"), callback("onKeyDown"));
  document.call<void>("addEventListener", js("keyup"), callback("onKeyUp"));
  document.call<void>("addEventListener", js("pointerup"), callback("onGlobalPointerUp"));
  document.call<void>("addEventListener", js("pointercancel"), callback("onGlobalPointerUp"));
  document.call<void>("addEventListener", js("pointerdown"), callback("resumeAudio"));
  windowObject.call<void>("addEventListener", js("blur"), callback("onGlobalPointerUp"));
  windowObject.call<void>("addEventListener", js("beforeunload"), callback("onBeforeUnload"));

  val mediaDevices = navigatorObject["mediaDevices"];
  if (present(mediaDevices) && present(mediaDevices["addEventListener"])) {
    mediaDevices.call<void>("addEventListener", js("devicechange"), callback("populateMicrophones"));
  }
}

void startClient() {
  loadProfile();
  loadSettings();
  bindEvents();
  updateMuteUi();
  updateEncryptionUi();

  val cipher = val::global("voiceCipher");
  if (!present(cipher) || !cipher["cipherSupported"].as<bool>()) {
    val button = byId("encryptBtn");
    button.set("disabled", true);
    button.set("title", js("This browser has no encoded-transform support"));
  }

  val mediaDevices = navigatorObject["mediaDevices"];
  if (!present(mediaDevices) || !present(mediaDevices["getUserMedia"])) {
    setStatus("this browser cannot do voice chat", "error");
    return;
  }

  setStatus("asking for your microphone…");
  requestInitialMicrophone(preferredMic);
}

} // namespace

EMSCRIPTEN_BINDINGS(voicechat_client) {
  emscripten::function("onPeerVolume", &onPeerVolume);
  emscripten::function("onIceCandidate", &onIceCandidate);
  emscripten::function("sendLocalDescription", &sendLocalDescription);
  emscripten::function("warnPromise", &warnPromise);
  emscripten::function("onNegotiationNeeded", &onNegotiationNeeded);
  emscripten::function("onRemoteOfferSet", &onRemoteOfferSet);
  emscripten::function("onRemoteAnswerSet", &onRemoteAnswerSet);
  emscripten::function("onTrack", &onTrack);
  emscripten::function("onEnvelopeOpened", &onEnvelopeOpened);
  emscripten::function("onSecurityDigest", &onSecurityDigest);
  emscripten::function("onSecurityStats", &onSecurityStats);
  emscripten::function("onConnectionStateChange", &onConnectionStateChange);
  emscripten::function("showUnblock", &showUnblock);
  emscripten::function("onWsOpen", &onWsOpen);
  emscripten::function("onWsMessage", &onWsMessage);
  emscripten::function("onWsClose", &onWsClose);
  emscripten::function("onWsError", &onWsError);
  emscripten::function("onInitialMicReady", &onInitialMicReady);
  emscripten::function("onInitialMicError", &onInitialMicError);
  emscripten::function("onSessionEnvelope", &onSessionEnvelope);
  emscripten::function("onSendKeyInstalled", &onSendKeyInstalled);
  emscripten::function("onIdentityReady", &onIdentityReady);
  emscripten::function("onNewIdentity", &onNewIdentity);
  emscripten::function("makeNewKey", &makeNewKey);
  emscripten::function("onDevices", &onDevices);
  emscripten::function("populateMicrophones", &populateMicrophones);
  emscripten::function("onMicChanged", &onMicChanged);
  emscripten::function("onMicChangeError", &onMicChangeError);
  emscripten::function("onMicSelect", &onMicSelect);
  emscripten::function("openProfile", &openProfile);
  emscripten::function("closeProfile", &closeProfile);
  emscripten::function("saveProfileEditor", &saveProfileEditor);
  emscripten::function("rerollProfile", &rerollProfile);
  emscripten::function("onImageLoad", &onImageLoad);
  emscripten::function("onImageError", &onImageError);
  emscripten::function("onFileInput", &onFileInput);
  emscripten::function("openSettings", &openSettings);
  emscripten::function("closeSettings", &closeSettings);
  emscripten::function("openSecurity", &openSecurity);
  emscripten::function("closeSecurity", &closeSecurity);
  emscripten::function("onPushToTalkToggle", &onPushToTalkToggle);
  emscripten::function("onEncryptClick", &onEncryptClick);
  emscripten::function("onFingerprint", &onFingerprint);
  emscripten::function("openKeys", &openKeys);
  emscripten::function("closeKeys", &closeKeys);
  emscripten::function("onKeyCopySuccess", &onKeyCopySuccess);
  emscripten::function("onKeyCopyFallback", &onKeyCopyFallback);
  emscripten::function("copyKey", &copyKey);
  emscripten::function("onListenValidated", &onListenValidated);
  emscripten::function("listenWithKey", &listenWithKey);
  emscripten::function("clearListenKey", &clearListenKey);
  emscripten::function("onMuteClick", &onMuteClick);
  emscripten::function("onMutePointerDown", &onMutePointerDown);
  emscripten::function("onKeyDown", &onKeyDown);
  emscripten::function("onKeyUp", &onKeyUp);
  emscripten::function("onGlobalPointerUp", &onGlobalPointerUp);
  emscripten::function("onOverlayClick", &onOverlayClick);
  emscripten::function("onCopySuccess", &onCopySuccess);
  emscripten::function("onCopyFallback", &onCopyFallback);
  emscripten::function("copyInvite", &copyInvite);
  emscripten::function("unblockAudio", &unblockAudio);
  emscripten::function("resumeAudio", &resumeAudio);
  emscripten::function("onBeforeUnload", &onBeforeUnload);
}

int main() {
  startClient();
  return 0;
}

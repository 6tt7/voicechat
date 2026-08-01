#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
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
  bool encrypted = true;
  bool secured = false;
  bool admin = false;
  bool forcedMuted = false;
  bool spotlight = false;
  std::string adminName;
  std::string fingerprint;
  std::string dhPublicKey;
  std::string peerDhPublicKey;
  std::string pendingDh;
  double volume = 1.0;
  val dhPrivateKey = val::undefined();
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

struct LogEntry {
  double timestamp;
  std::string category;
  std::string message;
  std::string data;
};

val document = val::global("document");
val windowObject = val::global("window");
val navigatorObject = val::global("navigator");
val json = val::global("JSON");
val mathObject = val::global("Math");
val ws = val::undefined();
val localStream = val::undefined();
val audioContext = val::undefined();

std::unordered_map<std::string, std::unique_ptr<Peer>> peers;
std::string myId;
Profile profile;
std::string preferredMic;
bool muted = false;
bool manualMuted = false;
bool pushToTalk = false;
bool pushPressed = false;
bool encrypting = true;
bool audioBlocked = false;
bool micFallbackTried = false;
bool ejected = false;
bool adminAuthenticated = false;
bool roomLocked = false;
int reconnectDelay = 1000;
std::string authenticatedAdminName;
std::string popoverId;

std::vector<LogEntry> logEntries;
std::unordered_set<std::string> activeLogCategories = {
  "system", "signal", "webrtc", "dh", "media", "admin",
};

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

void renderLog();
void refreshPopover(const std::string& id);

std::string logLabel(const std::string& category) {
  if (category == "signal") return "signaling";
  if (category == "webrtc") return "webrtc";
  if (category == "dh") return "key exchange";
  return category;
}

std::string logColor(const std::string& category) {
  if (category == "signal") return "#79bcd2";
  if (category == "webrtc") return "#d09a72";
  if (category == "dh") return "#7fc9a1";
  if (category == "media") return "#e0ad5c";
  if (category == "admin") return "#e78a73";
  return "#aaa397";
}

void logEvent(
  const std::string& category,
  const std::string& message,
  const std::string& data = ""
) {
  logEntries.push_back({
    val::global("Date").call<val>("now").as<double>(),
    category,
    message,
    data,
  });
  if (logEntries.size() > 600) logEntries.erase(logEntries.begin());
  if (!byId("consoleSheet")["hidden"].as<bool>()) renderLog();
}

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
void openPopover(const std::string& id, val event = val::undefined());

val cardFor(Peer& peer) {
  if (present(peer.card)) return peer.card;

  val card = document.call<val>("createElement", js("li"));
  card.set("className", js("peer"));
  card.call<void>("addEventListener", js("click"), callback("openPopover", peer.id));

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
  card.call<val>("querySelector", js(".name")).set(
    "textContent",
    peer->admin && !peer->adminName.empty() ? peer->adminName : peer->profile.name
  );
  card["classList"].call<void>("toggle", js("muted"), peer->muted || peer->forcedMuted);
  card["classList"].call<void>("toggle", js("encrypted"), peer->encrypted);
  card["classList"].call<void>("toggle", js("unlocked"), peer->secured);
  card["classList"].call<void>("toggle", js("admin"), peer->admin);
  card["classList"].call<void>("toggle", js("spotlight"), peer->spotlight);
  val container = peer->admin ? byId("adminStage") : byId("grid");
  if (!card["parentElement"].strictlyEquals(container)) container.call<val>("append", card);
  byId("adminStage").set("hidden", byId("adminStage")["children"]["length"].as<int>() == 0);
  if (present(peer->safetyCode) && peer->secured) {
    peer->safetyCode.set("textContent", "🔒 " + peer->fingerprint);
    peer->safetyCode.call<void>("setAttribute", js("title"), js("Per-link ECDH key fingerprint"));
  }
  if (present(peer->audioElement)) peer->audioElement.set("muted", peer->forcedMuted);
  if (present(peer->volumeInput)) {
    peer->volumeInput.call<void>(
      "setAttribute",
      js("aria-label"),
      "Volume for " + peer->profile.name
    );
  }
  updateRoomCount();
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
  byId("adminStage").set("hidden", byId("adminStage")["children"]["length"].as<int>() == 0);
  updateRoomCount();
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
  val cipher = val::global("voiceCipher");
  val transceivers = peer->pc.call<val>("getTransceivers");
  for (int i = 0; i < transceivers["length"].as<int>(); ++i) {
    val receiver = transceivers[i]["receiver"];
    if (present(cipher) && present(receiver)) {
      cipher.call<void>("installReceiverCipher", receiver, id);
    }
  }
}

val ecdhAlgorithm() {
  val algorithm = val::object();
  algorithm.set("name", js("ECDH"));
  algorithm.set("namedCurve", js("P-256"));
  return algorithm;
}

val stringArray(const std::vector<std::string>& values) {
  val result = val::array();
  for (const std::string& value : values) result.call<void>("push", value);
  return result;
}

std::string bufferToBase64(val buffer) {
  val bytes = val::global("Uint8Array").new_(buffer);
  std::string binary;
  binary.reserve(bytes["length"].as<int>());
  for (int i = 0; i < bytes["length"].as<int>(); ++i) {
    binary.push_back(static_cast<char>(bytes[i].as<int>()));
  }
  return val::global("btoa")(binary).as<std::string>();
}

val base64ToBytes(const std::string& encoded) {
  const std::string binary = val::global("atob")(encoded).as<std::string>();
  val bytes = val::global("Uint8Array").new_(static_cast<int>(binary.size()));
  for (std::size_t i = 0; i < binary.size(); ++i) {
    bytes.set(static_cast<unsigned>(i), static_cast<unsigned char>(binary[i]));
  }
  return bytes;
}

std::string dhSalt(const Peer& peer) {
  return peer.dhPublicKey < peer.peerDhPublicKey
    ? peer.dhPublicKey + "|" + peer.peerDhPublicKey
    : peer.peerDhPublicKey + "|" + peer.dhPublicKey;
}

void deriveWithPeer(const std::string& id, const std::string& peerPublicKey);

void onDhFingerprint(const std::string& id, val buffer) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  val bytes = val::global("Uint8Array").new_(buffer);
  constexpr char digits[] = "0123456789abcdef";
  std::string code;
  for (int i = 0; i < 6; ++i) {
    if (i && i % 2 == 0) code.push_back('-');
    const int byte = bytes[i].as<int>();
    code.push_back(digits[(byte >> 4) & 15]);
    code.push_back(digits[byte & 15]);
  }
  peer->fingerprint = code;
  logEvent("dh", "shared key established with " + peer->profile.name, code);
  renderPeer(id);
  refreshPopover(id);
}

void onSharedKey(const std::string& id, val key) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  val::global("voiceCipher").call<void>("setPeerKey", id, key);
  peer->secured = true;
  val encoded = val::global("TextEncoder").new_().call<val>("encode", dhSalt(*peer));
  val::global("crypto")["subtle"].call<val>("digest", js("SHA-256"), encoded)
    .call<val>("then", callback("onDhFingerprint", id))
    .call<val>("catch", callback("warnPromise"));
}

void onHkdfImported(const std::string& id, val hkdfKey) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  val encoder = val::global("TextEncoder").new_();
  val derive = val::object();
  derive.set("name", js("HKDF"));
  derive.set("hash", js("SHA-256"));
  derive.set("salt", encoder.call<val>("encode", dhSalt(*peer)));
  derive.set("info", encoder.call<val>("encode", js("voicechat-audio")));
  val aes = val::object();
  aes.set("name", js("AES-GCM"));
  aes.set("length", 256);
  val::global("crypto")["subtle"].call<val>(
    "deriveKey",
    derive,
    hkdfKey,
    aes,
    false,
    stringArray({"encrypt", "decrypt"})
  ).call<val>("then", callback("onSharedKey", id))
    .call<val>("catch", callback("warnPromise"));
}

void onDhBits(const std::string& id, val sharedBits) {
  val::global("crypto")["subtle"].call<val>(
    "importKey",
    js("raw"),
    sharedBits,
    js("HKDF"),
    false,
    stringArray({"deriveKey"})
  ).call<val>("then", callback("onHkdfImported", id))
    .call<val>("catch", callback("warnPromise"));
}

void onPeerDhImported(const std::string& id, val peerPublicKey) {
  Peer* peer = peerFor(id);
  if (!peer || !present(peer->dhPrivateKey)) return;
  val algorithm = val::object();
  algorithm.set("name", js("ECDH"));
  algorithm.set("public", peerPublicKey);
  val::global("crypto")["subtle"].call<val>(
    "deriveBits",
    algorithm,
    peer->dhPrivateKey,
    256
  ).call<val>("then", callback("onDhBits", id))
    .call<val>("catch", callback("warnPromise"));
}

void deriveWithPeer(const std::string& id, const std::string& peerPublicKey) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  peer->peerDhPublicKey = peerPublicKey;
  if (!present(peer->dhPrivateKey)) {
    peer->pendingDh = peerPublicKey;
    return;
  }
  val::global("crypto")["subtle"].call<val>(
    "importKey",
    js("raw"),
    base64ToBytes(peerPublicKey),
    ecdhAlgorithm(),
    false,
    stringArray({})
  ).call<val>("then", callback("onPeerDhImported", id))
    .call<val>("catch", callback("warnPromise"));
}

void onDhPublic(const std::string& id, val rawPublicKey) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  peer->dhPublicKey = bufferToBase64(rawPublicKey);
  val data = val::object();
  data.set("dh", peer->dhPublicKey);
  signal(id, data);
  logEvent("dh", "sent ephemeral public key to " + peer->profile.name);
  if (!peer->pendingDh.empty()) {
    const std::string pending = std::exchange(peer->pendingDh, "");
    deriveWithPeer(id, pending);
  }
}

void onDhKeys(const std::string& id, val pair) {
  Peer* peer = peerFor(id);
  if (!peer) return;
  peer->dhPrivateKey = pair["privateKey"];
  val::global("crypto")["subtle"].call<val>("exportKey", js("raw"), pair["publicKey"])
    .call<val>("then", callback("onDhPublic", id))
    .call<val>("catch", callback("warnPromise"));
}

void beginDh(const std::string& id) {
  val::global("crypto")["subtle"].call<val>(
    "generateKey",
    ecdhAlgorithm(),
    false,
    stringArray({"deriveBits"})
  ).call<val>("then", callback("onDhKeys", id))
    .call<val>("catch", callback("warnPromise"));
}

void onRemoteDescriptionSet(const std::string& id, bool offer) {
  Peer* peer = peerFor(id);
  if (!peer) return;
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

  const std::string dh = stringProperty(data, "dh");
  if (!dh.empty()) {
    deriveWithPeer(from, dh);
    return;
  }

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
  audio.set("muted", peer->forcedMuted);
  peer->audioElement = audio;
  byId("audio").call<val>("append", audio);
  audio.call<val>("play").call<val>("catch", callback("showUnblock"));
  logEvent("media", "receiving audio from " + peer->profile.name);
  watchSpeaking(*peer, stream);
}

void onSecurityDigest(const std::string& id, val buffer) {
  Peer* peer = peerFor(id);
  if (!peer || !present(peer->safetyCode)) return;
  if (peer->secured) return;
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
  logEvent("webrtc", peer->profile.name + ": " + state);
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
  entry->encrypted = !present(publicPeer["encrypted"]) || publicPeer["encrypted"].as<bool>();
  entry->admin = present(publicPeer["admin"]) && publicPeer["admin"].as<bool>();
  entry->adminName = stringProperty(publicPeer, "adminName");
  entry->forcedMuted = present(publicPeer["forcedMuted"]) && publicPeer["forcedMuted"].as<bool>();
  entry->spotlight = present(publicPeer["spotlight"]) && publicPeer["spotlight"].as<bool>();
  Peer& peer = *entry;
  peers.emplace(id, std::move(entry));

  peer.pc = val::global("RTCPeerConnection").new_(rtcConfiguration());
  val tracks = localStream.call<val>("getTracks");
  const int trackCount = tracks["length"].as<int>();
  for (int i = 0; i < trackCount; ++i) {
    val sender = peer.pc.call<val>("addTrack", tracks[i], localStream);
    val cipher = val::global("voiceCipher");
    if (present(cipher)) cipher.call<void>("installSenderCipher", sender, id);
  }
  attachReceiveCiphers(id);

  peer.pc.set("onicecandidate", callback("onIceCandidate", id));
  peer.pc.set("ontrack", callback("onTrack", id));
  peer.pc.set("onconnectionstatechange", callback("onConnectionStateChange", id));
  if (initiator) {
    peer.pc.set("onnegotiationneeded", callback("onNegotiationNeeded", id));
  }
  logEvent("webrtc", std::string(initiator ? "dialing " : "answering ") + peer.profile.name);
  beginDh(id);
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
    const Peer* self = peerFor(myId);
    const bool forced = self && self->forcedMuted;
    val tracks = localStream.call<val>("getAudioTracks");
    for (int i = 0; i < tracks["length"].as<int>(); ++i) {
      tracks[i].set("enabled", !muted && !forced);
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
  sendValue(message);
  logEvent("signal", "connected to signaling server");
}

void hideToast(void*) { byId("toast").set("hidden", true); }
void hideAnnouncement(void*) { byId("announce").set("hidden", true); }
void clearConfetti(void*) { byId("confetti").set("textContent", std::string()); }

void showToast(const std::string& text) {
  byId("toast").set("textContent", text);
  byId("toast").set("hidden", false);
  emscripten_async_call(hideToast, nullptr, 3500);
}

void showAnnouncement(const std::string& by, const std::string& text) {
  byId("announce").set("textContent", "📢 " + by + ": " + text);
  byId("announce").set("hidden", false);
  emscripten_async_call(hideAnnouncement, nullptr, 6500);
}

void confettiBurst() {
  const std::vector<std::string> pieces = {
    "#7fc9a1", "#e0ad5c", "#d8795b", "#79bcd2", "#f2eee5",
  };
  val box = byId("confetti");
  box.set("textContent", std::string());
  for (int i = 0; i < 64; ++i) {
    val piece = document.call<val>("createElement", js("i"));
    val style = piece["style"];
    style.set("left", std::to_string(mathObject.call<val>("random").as<double>() * 100.0) + "vw");
    style.set("background", pieces[static_cast<std::size_t>(i) % pieces.size()]);
    style.set("animationDelay", std::to_string(mathObject.call<val>("random").as<double>() * 0.4) + "s");
    box.call<val>("append", piece);
  }
  emscripten_async_call(clearConfetti, nullptr, 2800);
}

bool handleAdminServerMessage(const val& message) {
  const std::string type = stringProperty(message, "type");
  if (type == "admin-login-result") {
    if (present(message["ok"]) && message["ok"].as<bool>()) {
      adminAuthenticated = true;
      authenticatedAdminName = stringProperty(message, "adminName");
      byId("adminLoginSheet").set("hidden", true);
      byId("adminPass").set("value", std::string());
      byId("adminBtn")["classList"].call<void>("add", js("on"));
      byId("adminBtnLabel").set("textContent", "Admin: " + authenticatedAdminName);
      byId("adminPanel").set("hidden", false);
      byId("adminWho").set("textContent", authenticatedAdminName);
      logEvent("admin", "signed in as admin " + authenticatedAdminName);
    } else {
      byId("adminLoginMsg").set("textContent", stringProperty(message, "reason", "login failed"));
      byId("adminLoginMsg").set("className", js("key-status bad"));
    }
    return true;
  }
  if (type == "kicked" || type == "banned") {
    ejected = true;
    const std::string by = stringProperty(message, "by");
    const std::string reason = stringProperty(message, "reason");
    setStatus(
      type == "banned" ? (by.empty() ? "you are banned from this room" : "banned by " + by)
                       : "removed by " + by + (reason.empty() ? "" : ": " + reason),
      "error"
    );
    if (present(ws)) ws.call<void>("close");
    return true;
  }
  if (type == "warn") {
    byId("warnBy").set("textContent", stringProperty(message, "by", "admin"));
    byId("warnText").set("textContent", stringProperty(message, "text"));
    byId("warnSheet").set("hidden", false);
    logEvent("admin", "warning from " + stringProperty(message, "by"));
    return true;
  }
  if (type == "force-mute") {
    Peer* self = peerFor(myId);
    if (self) self->forcedMuted = present(message["value"]) && message["value"].as<bool>();
    syncAudioState();
    showToast(
      std::string(self && self->forcedMuted ? "Muted" : "Unmuted")
        + " by " + stringProperty(message, "by")
    );
    return true;
  }
  if (type == "announce") {
    showAnnouncement(stringProperty(message, "by", "admin"), stringProperty(message, "text"));
    logEvent("admin", "announcement from " + stringProperty(message, "by"), stringProperty(message, "text"));
    return true;
  }
  if (type == "confetti") {
    confettiBurst();
    return true;
  }
  if (type == "admin-log") {
    logEvent("admin", stringProperty(message, "by") + " → " + stringProperty(message, "detail"));
    return true;
  }
  return false;
}

void onWsMessage(val event) {
  val message = json.call<val>("parse", event["data"]);
  if (handleAdminServerMessage(message)) return;
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
    logEvent("system", "joined room with " + std::to_string(count) + " other(s)");
    for (int i = 0; i < count; ++i) {
      val publicPeer = roster[i];
      connectTo(stringProperty(publicPeer, "id"), publicPeer, true);
    }
  } else if (type == "peer-join") {
    val publicPeer = message["peer"];
    logEvent("system", stringProperty(publicPeer["profile"], "name", "someone") + " joined");
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
      peer->encrypted = !present(publicPeer["encrypted"]) || publicPeer["encrypted"].as<bool>();
      peer->admin = present(publicPeer["admin"]) && publicPeer["admin"].as<bool>();
      peer->adminName = stringProperty(publicPeer, "adminName");
      peer->forcedMuted = present(publicPeer["forcedMuted"]) && publicPeer["forcedMuted"].as<bool>();
      peer->spotlight = present(publicPeer["spotlight"]) && publicPeer["spotlight"].as<bool>();
      renderPeer(peer->id);
      if (peer->id == myId) syncAudioState();
      refreshPopover(peer->id);
    }
  } else if (type == "signal") {
    onSignal(stringProperty(message, "from"), message["data"]);
  } else if (type == "full") {
    setStatus("the channel is full (" + std::to_string(message["max"].as<int>()) + " people)", "error");
  } else if (type == "locked") {
    setStatus("the room is locked right now", "error");
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
  if (ejected) return;
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

void onInitialMicReady(val stream) {
  localStream = stream;
  val tracks = localStream.call<val>("getAudioTracks");
  for (int i = 0; i < tracks["length"].as<int>(); ++i) tracks[i].set("enabled", !muted);
  val::global("voiceCipher").call<void>("setEncryptionEnabled", encrypting);
  logEvent("system", "Diffie-Hellman ready; each link derives its own key");
  setStatus("connecting…");
  populateMicrophones();
  connectSocket();
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
  event.call<void>("stopPropagation");
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

void renderLog() {
  val list = byId("logList");
  list.set("textContent", std::string());
  for (const LogEntry& entry : logEntries) {
    if (!activeLogCategories.count(entry.category)) continue;
    val row = document.call<val>("createElement", js("div"));
    row.set("className", js("logrow"));
    row["dataset"].set("cat", entry.category);
    val time = document.call<val>("createElement", js("span"));
    time.set("className", js("logtime"));
    time.set(
      "textContent",
      val::global("Date").new_(entry.timestamp).call<val>("toLocaleTimeString")
    );
    val category = document.call<val>("createElement", js("span"));
    category.set("className", js("logcat"));
    category.set("textContent", logLabel(entry.category));
    category["style"].set("color", logColor(entry.category));
    val message = document.call<val>("createElement", js("span"));
    message.set("className", js("logmsg"));
    message.set("textContent", entry.message + (entry.data.empty() ? "" : "  " + entry.data));
    row.call<val>("append", time, category, message);
    list.call<val>("append", row);
  }
  list.set("scrollTop", list["scrollHeight"]);
}

void openConsole(val) {
  renderLog();
  byId("consoleSheet").set("hidden", false);
}

void closeConsole(val) { byId("consoleSheet").set("hidden", true); }

void clearLogs(val) {
  logEntries.clear();
  renderLog();
}

void toggleLogCategory(const std::string& category, val) {
  val chip = byId("chip-" + category);
  if (activeLogCategories.count(category)) {
    activeLogCategories.erase(category);
    chip["classList"].call<void>("remove", js("on"));
  } else {
    activeLogCategories.insert(category);
    chip["classList"].call<void>("add", js("on"));
  }
  renderLog();
}

void applyTheme(const std::string& requested) {
  const std::string theme = requested == "light" || requested == "midnight" ? requested : "dark";
  document["documentElement"]["dataset"].set("theme", theme);
  windowObject["localStorage"].call<void>("setItem", js("vc-theme"), theme);
  byId("themeSelect").set("value", theme);
}

void onThemeChange(val event) {
  applyTheme(event["target"]["value"].as<std::string>());
}

void closePopover(val = val::undefined()) {
  popoverId.clear();
  byId("popoverSheet").set("hidden", true);
}

void refreshPopover(const std::string& id) {
  if (popoverId != id || byId("popoverSheet")["hidden"].as<bool>()) return;
  Peer* peer = peerFor(id);
  if (!peer) { closePopover(); return; }
  byId("popTitle").set(
    "textContent",
    peer->admin && !peer->adminName.empty() ? peer->adminName : peer->profile.name
  );
  byId("popFpr").set(
    "textContent",
    peer->secured ? "secured · " + peer->fingerprint : js("negotiating encryption…")
  );
  byId("popVolumeWrap").set("hidden", id == myId);
  byId("popVolume").set("value", std::to_string(static_cast<int>(peer->volume * 100.0)));
  byId("popAdmin").set("hidden", !adminAuthenticated || id == myId || peer->admin);
}

void openPopover(const std::string& id, val) {
  if (!peerFor(id)) return;
  popoverId = id;
  byId("popoverSheet").set("hidden", false);
  refreshPopover(id);
}

void onPopoverVolume(val event) {
  Peer* peer = peerFor(popoverId);
  if (!peer) return;
  peer->volume = std::clamp(std::stod(event["target"]["value"].as<std::string>()) / 100.0, 0.0, 1.0);
  if (present(peer->audioElement)) peer->audioElement.set("volume", peer->volume);
  if (present(peer->volumeInput)) peer->volumeInput.set("value", std::to_string(peer->volume));
}

void sendAdminAction(
  const std::string& action,
  const std::string& target = "",
  const std::string& text = "",
  bool includeValue = false,
  bool value = false
) {
  val message = val::object();
  message.set("type", js("admin-action"));
  message.set("action", action);
  if (!target.empty()) message.set("target", target);
  if (!text.empty()) message.set("text", text);
  if (includeValue) message.set("value", value);
  sendValue(message);
}

void openAdmin(val) {
  if (adminAuthenticated) {
    const bool hidden = byId("adminPanel")["hidden"].as<bool>();
    byId("adminPanel").set("hidden", !hidden);
  } else {
    byId("adminLoginSheet").set("hidden", false);
    byId("adminUser").call<void>("focus");
  }
}

void closeAdminLogin(val) { byId("adminLoginSheet").set("hidden", true); }
void closeAdminPanel(val) { byId("adminPanel").set("hidden", true); }

void submitAdminLogin(val) {
  byId("adminLoginMsg").set("textContent", js("Checking…"));
  byId("adminLoginMsg").set("className", js("key-status"));
  val message = val::object();
  message.set("type", js("admin-login"));
  message.set("username", byId("adminUser")["value"]);
  message.set("password", byId("adminPass")["value"]);
  sendValue(message);
}

void onAdminPasswordKey(val event) {
  if (stringProperty(event, "key") == "Enter") submitAdminLogin(val::undefined());
}

void onPeerAdminAction(const std::string& action, val) {
  if (popoverId.empty()) return;
  if (action == "warn" || action == "rename") {
    val answer = val::global("prompt")(action == "warn" ? js("Warning message:") : js("New name:"));
    if (present(answer) && !answer.as<std::string>().empty()) {
      sendAdminAction(action, popoverId, answer.as<std::string>());
    }
  } else if (action == "mute") {
    Peer* peer = peerFor(popoverId);
    sendAdminAction(action, popoverId, "", true, !(peer && peer->forcedMuted));
  } else {
    sendAdminAction(action, popoverId);
  }
}

void sendAnnouncement(val) {
  const std::string text = byId("announceInput")["value"].as<std::string>();
  if (text.empty()) return;
  sendAdminAction("announce", "", text);
  byId("announceInput").set("value", std::string());
}

void requestConfetti(val) { sendAdminAction("confetti"); }

void toggleRoomLock(val) {
  roomLocked = !roomLocked;
  sendAdminAction("lock", "", "", true, roomLocked);
  byId("lockBtn").set("textContent", roomLocked ? js("Unlock room") : js("Lock room"));
}

void clearSpotlight(val) { sendAdminAction("spotlight"); }
void closeWarning(val) { byId("warnSheet").set("hidden", true); }

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
}

void onEncryptClick(val) {
  val cipher = val::global("voiceCipher");
  if (!present(cipher) || !cipher["cipherSupported"].as<bool>()) return;
  encrypting = !encrypting;
  cipher.call<void>("setEncryptionEnabled", encrypting);
  updateEncryptionUi();
  logEvent("dh", std::string("app-layer encryption ") + (encrypting ? "enabled" : "disabled"));
  pushUpdate();
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
    closeConsole(val::undefined());
    closeAdminLogin(val::undefined());
    closePopover();
    closeWarning(val::undefined());
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

  byId("consoleBtn").call<void>("addEventListener", js("click"), callback("openConsole"));
  byId("consoleDoneBtn").call<void>("addEventListener", js("click"), callback("closeConsole"));
  byId("logClearBtn").call<void>("addEventListener", js("click"), callback("clearLogs"));
  byId("themeSelect").call<void>("addEventListener", js("change"), callback("onThemeChange"));
  byId("consoleSheet").call<void>(
    "addEventListener", js("click"), callback("onOverlayClick", "consoleSheet")
  );
  for (const char* categoryName : {"system", "signal", "webrtc", "dh", "media", "admin"}) {
    const std::string category = categoryName;
    byId("chip-" + category).call<void>(
      "addEventListener", js("click"), callback("toggleLogCategory", category)
    );
  }

  byId("adminBtn").call<void>("addEventListener", js("click"), callback("openAdmin"));
  byId("adminLoginBtn").call<void>("addEventListener", js("click"), callback("submitAdminLogin"));
  byId("adminLoginCancelBtn").call<void>("addEventListener", js("click"), callback("closeAdminLogin"));
  byId("adminPass").call<void>("addEventListener", js("keydown"), callback("onAdminPasswordKey"));
  byId("adminPanelCloseBtn").call<void>("addEventListener", js("click"), callback("closeAdminPanel"));
  byId("announceBtn").call<void>("addEventListener", js("click"), callback("sendAnnouncement"));
  byId("confettiBtn").call<void>("addEventListener", js("click"), callback("requestConfetti"));
  byId("lockBtn").call<void>("addEventListener", js("click"), callback("toggleRoomLock"));
  byId("spotlightClearBtn").call<void>("addEventListener", js("click"), callback("clearSpotlight"));
  byId("adminLoginSheet").call<void>(
    "addEventListener", js("click"), callback("onOverlayClick", "adminLoginSheet")
  );

  byId("popCloseBtn").call<void>("addEventListener", js("click"), callback("closePopover"));
  byId("popVolume").call<void>("addEventListener", js("input"), callback("onPopoverVolume"));
  byId("popoverSheet").call<void>(
    "addEventListener", js("click"), callback("onOverlayClick", "popoverSheet")
  );
  for (const char* actionName : {"warn", "mute", "rename", "reset-avatar", "spotlight", "kick", "ban"}) {
    const std::string action = actionName;
    byId("action-" + action).call<void>(
      "addEventListener", js("click"), callback("onPeerAdminAction", action)
    );
  }
  byId("warnCloseBtn").call<void>("addEventListener", js("click"), callback("closeWarning"));

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
  val savedTheme = windowObject["localStorage"].call<val>("getItem", js("vc-theme"));
  applyTheme(present(savedTheme) ? savedTheme.as<std::string>() : "dark");
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
  emscripten::function("onDhKeys", &onDhKeys);
  emscripten::function("onDhPublic", &onDhPublic);
  emscripten::function("onPeerDhImported", &onPeerDhImported);
  emscripten::function("onDhBits", &onDhBits);
  emscripten::function("onHkdfImported", &onHkdfImported);
  emscripten::function("onSharedKey", &onSharedKey);
  emscripten::function("onDhFingerprint", &onDhFingerprint);
  emscripten::function("onTrack", &onTrack);
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
  emscripten::function("openConsole", &openConsole);
  emscripten::function("closeConsole", &closeConsole);
  emscripten::function("clearLogs", &clearLogs);
  emscripten::function("toggleLogCategory", &toggleLogCategory);
  emscripten::function("onThemeChange", &onThemeChange);
  emscripten::function("openPopover", &openPopover);
  emscripten::function("closePopover", &closePopover);
  emscripten::function("onPopoverVolume", &onPopoverVolume);
  emscripten::function("openAdmin", &openAdmin);
  emscripten::function("closeAdminLogin", &closeAdminLogin);
  emscripten::function("closeAdminPanel", &closeAdminPanel);
  emscripten::function("submitAdminLogin", &submitAdminLogin);
  emscripten::function("onAdminPasswordKey", &onAdminPasswordKey);
  emscripten::function("onPeerAdminAction", &onPeerAdminAction);
  emscripten::function("sendAnnouncement", &sendAnnouncement);
  emscripten::function("requestConfetti", &requestConfetti);
  emscripten::function("toggleRoomLock", &toggleRoomLock);
  emscripten::function("clearSpotlight", &clearSpotlight);
  emscripten::function("closeWarning", &closeWarning);
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

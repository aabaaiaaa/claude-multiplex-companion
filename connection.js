// The page's side of the connection to the desktop app (see PROTOCOL.md).

export const PAIRING_KEY = "cmx-companion-pairing";
export const CLIENT_KEY = "cmx-companion-client";

/** How long a direct connection may take to open before it's retried. */
const CONNECT_TIMEOUT_MS = 20000;
/** "The app isn't there" this many times in a row ends the pairing; fewer may be the server. */
const UNAVAILABLE_LIMIT = 3;

/** ICE states after which WebRTC soon drops its candidate pairs from the stats. */
const ICE_GAVE_UP = ["disconnected", "failed"];

/** Wait this long before each retry; the last value repeats. */
const RETRY_MS = [1000, 2000, 5000, 10000];

/** STUN plus the free openrelay TURN servers, for phones on another network. */
const CLOUD_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

function store(get) {
  try { return get(); } catch { return null; }
}

/** The pairing from the link's `#peer=…&server=…`, else the one this page remembers. */
export function readPairing(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const peer = params.get("peer");
  if (peer) return { peer, server: params.get("server") };
  const saved = store(() => JSON.parse(localStorage.getItem(PAIRING_KEY) ?? "null"));
  return saved && typeof saved.peer === "string" ? saved : null;
}

function clientId() {
  let id = store(() => localStorage.getItem(CLIENT_KEY));
  if (!id) {
    id = crypto.randomUUID();
    store(() => localStorage.setItem(CLIENT_KEY, id));
  }
  return id;
}

/** "host udp" from a candidate line, plus whether its address is a hidden name; never the address. */
export function describeCandidateLine(line) {
  const parts = line.replace(/^a=/, "").split(" ");
  const typ = parts.indexOf("typ");
  const type = (typ >= 0 && parts[typ + 1]) || "?";
  return `${type} ${(parts[2] ?? "?").toLowerCase()}${parts[4]?.endsWith(".local") ? " (mDNS name)" : ""}`;
}

function peerOptions(server) {
  if (!server) return { config: { iceServers: CLOUD_ICE_SERVERS } };
  const [host, port] = server.split(":");
  return { host, port: Number(port), path: "/", secure: Number(port) === 443, config: { iceServers: [] } };
}

/**
 * Statuses: "unpaired", "connecting", "connected", "reconnecting", "ended".
 * `onEnded(reason)` gets "disconnected", "replaced" or "unavailable".
 * `onTrouble()` runs when a direct connection didn't open in time.
 */
export class Connection {
  constructor({ onStatus, onMessage, onEnded, onTrouble = () => {}, onLog = () => {} }) {
    this.onStatus = onStatus;
    this.log = onLog;
    this.unavailable = 0;
    this.openTimer = null;
    this.onMessage = onMessage;
    this.onEnded = onEnded;
    this.onTrouble = onTrouble;
    this.status = "connecting";
    this.peer = null;
    this.conn = null;
    this.attempt = 0;
    this.timer = null;
    this.pairing = null;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.status === "reconnecting") this.retryNow();
    });
  }

  start() {
    this.pairing = readPairing(location.hash);
    if (!this.pairing) {
      this.setStatus("unpaired");
      return;
    }
    store(() => localStorage.setItem(PAIRING_KEY, JSON.stringify(this.pairing)));
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    this.connect();
  }

  setStatus(s) {
    this.status = s;
    this.onStatus(s);
  }

  connect() {
    this.timer = null;
    this.dropPeer();
    const options = peerOptions(this.pairing.server);
    this.log(`Connecting via ${this.pairing.server ? `local server ${this.pairing.server}` : "the PeerJS cloud server"}, ${options.config.iceServers.length} relay servers`);
    const peer = new Peer(crypto.randomUUID(), { ...options, debug: 2, logFunction: (...args) => this.log(`PeerJS: ${args.map(String).join(" ")}`) });
    this.peer = peer;
    peer.on("open", () => {
      if (peer !== this.peer) return;
      this.log("Pairing server: connected");
      // Binary, so PeerJS splits large messages; its JSON mode drops anything over ~16 KB.
      const conn = peer.connect(this.pairing.peer, { serialization: "binary", reliable: true });
      this.conn = conn;
      this.watchIce(conn);
      clearTimeout(this.openTimer);
      this.openTimer = setTimeout(() => {
        if (conn !== this.conn || conn.open) return;
        this.log(`No direct connection after ${CONNECT_TIMEOUT_MS / 1000}s`);
        this.onTrouble();
        // Once ICE has given up, the candidates were already reported.
        if (ICE_GAVE_UP.includes(conn.peerConnection?.iceConnectionState)) this.scheduleRetry();
        else this.reportCandidates(conn).finally(() => this.scheduleRetry());
      }, CONNECT_TIMEOUT_MS);
      conn.on("open", () => {
        if (conn !== this.conn) return;
        clearTimeout(this.openTimer);
        this.log("Direct connection: open");
        this.reportCandidates(conn);
        this.unavailable = 0;
        this.attempt = 0;
        this.setStatus("connected");
        this.send({ type: "hello", clientId: clientId() });
      });
      conn.on("data", m => {
        if (conn !== this.conn || !m || m.v !== 1) return;
        if (m.type === "goodbye") this.end(m.reason === "replaced" ? "replaced" : "disconnected");
        else this.onMessage(m);
      });
      conn.on("close", () => { if (conn === this.conn) { this.log("Direct connection: closed"); this.scheduleRetry(); } });
      conn.on("error", err => { if (conn === this.conn) { this.log(`Direct connection error: ${err?.type ?? err}`); this.scheduleRetry(); } });
    });
    peer.on("error", err => {
      if (peer !== this.peer) return;
      this.log(`Pairing server error: ${err?.type ?? "unknown"} ${err?.message ?? ""}`.trim());
      if (err?.type === "peer-unavailable" && ++this.unavailable >= UNAVAILABLE_LIMIT) this.end("unavailable");
      else this.scheduleRetry();
    });
    peer.on("disconnected", () => {
      if (peer !== this.peer) return;
      this.log("Pairing server: disconnected");
      if (this.status !== "connected") this.scheduleRetry();
    });
  }

  /** Logs how WebRTC gets on: address gathering and the connection's state, and the
   *  candidates the moment ICE gives up, while its pairs are still in the stats. */
  watchIce(conn) {
    const pc = conn.peerConnection;
    if (!pc) return;
    let reported = false;
    pc.addEventListener("icegatheringstatechange", () => this.log(`ICE gathering: ${pc.iceGatheringState}`));
    pc.addEventListener("iceconnectionstatechange", () => {
      this.log(`ICE connection state: ${pc.iceConnectionState}`);
      if (!reported && ICE_GAVE_UP.includes(pc.iceConnectionState)) {
        reported = true;
        this.reportCandidates(conn);
      }
    });
    pc.addEventListener("signalingstatechange", () => this.log(`Signalling state: ${pc.signalingState}`));
    // PeerJS hands each address the computer sends to this; logging here shows whether any arrive.
    const add = pc.addIceCandidate.bind(pc);
    pc.addIceCandidate = async candidate => {
      const line = candidate?.candidate;
      if (line) this.log(`remote candidate received: ${describeCandidateLine(line)}`);
      try {
        await add(candidate);
      } catch (err) {
        this.log(`remote candidate rejected: ${err?.name ?? "error"}`);
        throw err;
      }
    };
    pc.addEventListener("icecandidate", e => {
      const c = e.candidate;
      if (c) this.log(`local candidate: ${c.type ?? "?"} ${c.protocol ?? ""}${c.address?.endsWith(".local") ? " (mDNS name)" : ""}`);
    });
  }

  /** The candidates each side offered and how each pair fared, from WebRTC's own stats. */
  async reportCandidates(conn) {
    const pc = conn.peerConnection;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      const kinds = { "local-candidate": [], "remote-candidate": [] };
      const pairs = [];
      stats.forEach(s => {
        if (kinds[s.type]) kinds[s.type].push(`${s.candidateType}/${s.protocol}`);
        if (s.type === "candidate-pair") pairs.push(`${s.state}${s.nominated ? " (nominated)" : ""}`);
      });
      this.log(`This phone offered: ${kinds["local-candidate"].join(", ") || "none"}`);
      this.log(`The computer offered: ${kinds["remote-candidate"].join(", ") || "none"}`);
      this.log(`Candidate pairs: ${pairs.join(", ") || "none"}`);
    } catch (e) {
      this.log(`Couldn't read WebRTC stats: ${e}`);
    }
  }

  scheduleRetry() {
    if (this.status === "ended" || this.timer) return;
    this.conn = null;
    this.setStatus("reconnecting");
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt += 1;
    this.log(`Retrying in ${delay / 1000}s`);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  retryNow() {
    clearTimeout(this.timer);
    this.connect();
  }

  /** Detach before destroying: PeerJS fires "disconnected" and "close" from destroy(). */
  dropPeer() {
    clearTimeout(this.openTimer);
    const peer = this.peer;
    this.peer = null;
    this.conn = null;
    peer?.destroy();
  }

  /** Whether the message went: false while not connected. */
  send(message) {
    if (!this.conn?.open) return false;
    this.conn.send({ v: 1, ...message });
    return true;
  }

  end(reason) {
    if (this.status === "ended") return;
    clearTimeout(this.timer);
    this.timer = null;
    store(() => localStorage.removeItem(PAIRING_KEY));
    this.dropPeer();
    this.setStatus("ended");
    this.onEnded(reason);
  }
}

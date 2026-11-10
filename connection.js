// The page's side of the connection to the desktop app (see PROTOCOL.md).

export const PAIRING_KEY = "cmx-companion-pairing";
export const CLIENT_KEY = "cmx-companion-client";

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

function peerOptions(server) {
  if (!server) return { config: { iceServers: CLOUD_ICE_SERVERS } };
  const [host, port] = server.split(":");
  return { host, port: Number(port), path: "/", secure: Number(port) === 443, config: { iceServers: [] } };
}

/**
 * Statuses: "unpaired", "connecting", "connected", "reconnecting", "ended".
 * `onEnded(reason)` gets "disconnected", "replaced" or "unavailable".
 */
export class Connection {
  constructor({ onStatus, onMessage, onEnded }) {
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.onEnded = onEnded;
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
    const peer = new Peer(crypto.randomUUID(), peerOptions(this.pairing.server));
    this.peer = peer;
    peer.on("open", () => {
      if (peer !== this.peer) return;
      // Binary, so PeerJS splits large messages; its JSON mode drops anything over ~16 KB.
      const conn = peer.connect(this.pairing.peer, { serialization: "binary", reliable: true });
      this.conn = conn;
      conn.on("open", () => {
        if (conn !== this.conn) return;
        this.attempt = 0;
        this.setStatus("connected");
        this.send({ type: "hello", clientId: clientId() });
      });
      conn.on("data", m => {
        if (conn !== this.conn || !m || m.v !== 1) return;
        if (m.type === "goodbye") this.end(m.reason === "replaced" ? "replaced" : "disconnected");
        else this.onMessage(m);
      });
      conn.on("close", () => { if (conn === this.conn) this.scheduleRetry(); });
      conn.on("error", () => { if (conn === this.conn) this.scheduleRetry(); });
    });
    peer.on("error", err => {
      if (peer !== this.peer) return;
      if (err?.type === "peer-unavailable") this.end("unavailable");
      else this.scheduleRetry();
    });
    peer.on("disconnected", () => { if (peer === this.peer && this.status !== "connected") this.scheduleRetry(); });
  }

  scheduleRetry() {
    if (this.status === "ended" || this.timer) return;
    this.conn = null;
    this.setStatus("reconnecting");
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt += 1;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  retryNow() {
    clearTimeout(this.timer);
    this.connect();
  }

  /** Detach before destroying: PeerJS fires "disconnected" and "close" from destroy(). */
  dropPeer() {
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

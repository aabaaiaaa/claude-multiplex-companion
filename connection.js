// The page's side of the connection to the desktop app (see PROTOCOL.md).

import { negotiatedFingerprints, proof, sameProof } from "./auth.js";

export const PAIRING_KEY = "cmx-companion-pairing";
export const CLIENT_KEY = "cmx-companion-client";

/** How long a direct connection may take to open before it's retried. */
const CONNECT_TIMEOUT_MS = 20000;
/** "The app isn't there" this many times in a row ends the pairing; fewer may be the server. */
const UNAVAILABLE_LIMIT = 3;

/** ICE states after which WebRTC soon drops its candidate pairs from the stats. */
const ICE_GAVE_UP = ["disconnected", "failed"];
/** ICE states with a route in use, and those after which there's none. */
const ICE_CONNECTED = ["connected", "completed"];
const ROUTE_GONE = ["disconnected", "failed", "closed"];

/** The pair of candidates in use, by kind, from WebRTC's stats; null when none is picked yet.
 *  Chrome and Safari name the pair on the transport, Firefox marks it selected. */
export async function readRoute(pc) {
  const stats = await pc.getStats();
  const byId = new Map();
  let selectedId, selected, nominated;
  stats.forEach(s => {
    if (s.id) byId.set(s.id, s);
    if (s.type === "transport" && s.selectedCandidatePairId) selectedId = s.selectedCandidatePairId;
    if (s.type === "candidate-pair" && s.selected) selected = s;
    if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") nominated ??= s;
  });
  const chosen = (selectedId && byId.get(selectedId)) || selected || nominated;
  const local = chosen?.localCandidateId && byId.get(chosen.localCandidateId);
  const remote = chosen?.remoteCandidateId && byId.get(chosen.remoteCandidateId);
  if (!local || !remote) return null;
  return {
    relayed: local.candidateType === "relay" || remote.candidateType === "relay",
    local: `${local.candidateType ?? "?"}/${local.protocol ?? "?"}`,
    remote: `${remote.candidateType ?? "?"}/${remote.protocol ?? "?"}`,
  };
}

/** "relayed" when either end goes through a TURN relay, else "direct". */
export const routeKind = route => (route.relayed ? "relayed" : "direct");

/** Wait this long before each retry; the last value repeats. */
const RETRY_MS = [1000, 2000, 5000, 10000];

/** How long a disconnect waits for the app's goodbye before letting go anyway. */
const LEAVE_WAIT_MS = 1500;

/** How long to wait for the app's challenge once connected. An app that sends none predates the
 *  pairing check, so is too old for this page. */
const CHALLENGE_WAIT_MS = 8000;

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

/**
 * The pairing from the link's `#peer=…&k=…&server=…` (`code`: the QR code's secret), else the one
 * this page remembers (`deviceKey`: the key the app gave it). One with neither can't pass the
 * pairing check, so it counts as none.
 */
export function readPairing(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const peer = params.get("peer");
  if (peer) return params.get("k") ? { peer, server: params.get("server"), code: params.get("k") } : null;
  const saved = store(() => JSON.parse(localStorage.getItem(PAIRING_KEY) ?? "null"));
  if (saved && typeof saved.peer === "string" && typeof saved.deviceKey === "string") return saved;
  store(() => localStorage.removeItem(PAIRING_KEY));
  return null;
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
 * `onEnded(reason)` gets "left" (disconnected from this page), "outdated" (the app is too old for
 * this page), "refused" (the app turned down the pairing check, as for an expired code),
 * "unverified" (whatever answered couldn't prove it's the app paired with), "disconnected",
 * "replaced" or "unavailable".
 * `onTrouble()` runs when a direct connection didn't open in time.
 */
export class Connection {
  constructor({ onStatus, onMessage, onEnded, onTrouble = () => {}, onLog = () => {}, onRoute = () => {} }) {
    this.onStatus = onStatus;
    this.log = onLog;
    this.onRoute = onRoute;
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
    // The code stays out of the address bar and the history; it's kept only until it's used.
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    if (!this.pairing) {
      this.setStatus("unpaired");
      return;
    }
    this.connect();
  }

  /** Answers the app's challenge with the code or the device key, bound to this connection. */
  async answerChallenge(conn, nonce) {
    // Marked at once, so a second challenge on this connection is ignored.
    conn.challenge = { nonce };
    const kind = this.pairing.code ? "pair" : "device";
    const secret = this.pairing.code ?? this.pairing.deviceKey;
    const fps = await this.fingerprints(conn);
    if (conn !== this.conn) return;
    if (!fps) {
      this.log("Pairing check: no certificate fingerprints to check against");
      this.end("unverified");
      return;
    }
    conn.challenge = { nonce, secret, fps };
    this.send({ type: "auth", kind, proof: await proof(secret, "phone", nonce, fps.app, fps.phone) });
    this.log(`Pairing check: answered with ${kind === "pair" ? "the code" : "this phone's key"}`);
  }

  /** The app's proof back: right, and the page trusts what follows; wrong, and it stops. */
  async checkApp(conn, m) {
    const c = conn.challenge;
    if (!c?.fps) return;
    const expected = await proof(c.secret, "app", c.nonce, c.fps.app, c.fps.phone);
    if (conn !== this.conn) return;
    if (!sameProof(expected, m.proof)) {
      this.log("Pairing check failed: the other end isn't the app this phone paired with");
      this.end("unverified");
      return;
    }
    if (typeof m.deviceKey === "string") {
      // The code is spent: from now on this phone proves itself with its own key.
      this.pairing = { peer: this.pairing.peer, server: this.pairing.server, deviceKey: m.deviceKey };
      store(() => localStorage.setItem(PAIRING_KEY, JSON.stringify(this.pairing)));
    }
    conn.authed = true;
    clearTimeout(this.challengeTimer);
    this.log("Pairing check: passed");
    this.unavailable = 0;
    this.attempt = 0;
    this.setStatus("connected");
    this.send({ type: "hello", clientId: clientId() });
  }

  /** This connection's two certificate fingerprints, from the DTLS link itself: from this
   *  phone's side, the app's is the remote one. */
  async fingerprints(conn) {
    const f = await negotiatedFingerprints(conn.peerConnection);
    return f ? { app: f.remote, phone: f.local } : null;
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
      // A new connection's route is unknown until it's up.
      this.onRoute(null);
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
        // Connected only once the pairing check passes, both ways.
        clearTimeout(this.challengeTimer);
        this.challengeTimer = setTimeout(() => {
          if (conn !== this.conn || conn.challenge) return;
          this.log(`No pairing check from the app after ${CHALLENGE_WAIT_MS / 1000}s`);
          this.end("outdated");
        }, CHALLENGE_WAIT_MS);
      });
      conn.on("data", m => {
        if (conn !== this.conn || !m || m.v !== 1) return;
        if (m.type === "goodbye" && m.reason === "refused") {
          this.log("Pairing check: refused by the app");
          this.end("refused");
          return;
        }
        if (!conn.authed) {
          if (m.type === "challenge" && typeof m.nonce === "string" && !conn.challenge) {
            this.answerChallenge(conn, m.nonce).catch(() => this.end("unverified"));
          } else if (m.type === "authed" && typeof m.proof === "string") {
            this.checkApp(conn, m).catch(() => this.end("unverified"));
          }
          return;
        }
        if (m.type === "goodbye") this.end(this.leaving || (m.reason === "replaced" ? "replaced" : "disconnected"));
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
    /** The route last logged, so only a change is logged again. */
    let shown = null;
    let followed = false;
    const checkRoute = () => {
      // The transport exists only once the connection is set up, so it's followed from here.
      const ice = pc.sctp?.transport?.iceTransport;
      if (ice && !followed) {
        followed = true;
        ice.addEventListener("selectedcandidatepairchange", checkRoute);
      }
      readRoute(pc).then(route => {
        if (!route || !ICE_CONNECTED.includes(pc.iceConnectionState)) return;
        const key = `${route.local} ${route.remote}`;
        if (key === shown) return;
        shown = key;
        this.log(`Route: ${routeKind(route)} (this phone ${route.local} ↔ the computer ${route.remote})`);
        if (conn === this.conn) this.onRoute(routeKind(route));
      }).catch(() => {});
    };
    pc.addEventListener("icegatheringstatechange", () => this.log(`ICE gathering: ${pc.iceGatheringState}`));
    // Not before: Chrome reuses a stats report for a moment, and one read before the secure link
    // is up has no certificates, which would fail the pairing check that reads them next.
    pc.addEventListener("connectionstatechange", () => { if (pc.connectionState === "connected") checkRoute(); });
    pc.addEventListener("iceconnectionstatechange", () => {
      this.log(`ICE connection state: ${pc.iceConnectionState}`);
      if (ROUTE_GONE.includes(pc.iceConnectionState)) {
        shown = null;
        if (conn === this.conn) this.onRoute(null);
      }
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
    if (this.status === "ended" || this.leaving || this.timer) return;
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

  /** Ends the pairing from this page: the app stops waiting for it, and this page forgets it.
   *  `reason` is what `onEnded` gets: "left", or "outdated" when the app is too old for this page. */
  disconnect(reason = "left") {
    if (this.status === "ended" || this.leaving) return;
    this.leaving = reason;
    if (!this.send({ type: "disconnect" })) {
      this.end(reason);
      return;
    }
    // Let the message go before the connection does; the app's goodbye ends it sooner.
    setTimeout(() => this.end(reason), LEAVE_WAIT_MS);
  }

  end(reason) {
    if (this.status === "ended") return;
    clearTimeout(this.challengeTimer);
    clearTimeout(this.timer);
    this.timer = null;
    store(() => localStorage.removeItem(PAIRING_KEY));
    this.dropPeer();
    this.setStatus("ended");
    this.onEnded(reason);
  }
}

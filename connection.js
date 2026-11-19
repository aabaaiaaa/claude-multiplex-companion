// The page's side of the connection to the desktop app (see PROTOCOL.md).

import { negotiatedFingerprints, proof, sameProof } from "./auth.js";
import { checkScreenLock, createScreenLock, uvChallenge } from "./screen-lock.js";

/** What this page shows beyond the base protocol, told to the app in `hello` so it sends only
 *  what the page can show (PROTOCOL.md). */
export const PAGE_FEATURES = Object.freeze(["planCards"]);

export const PAIRING_KEY = "cmx-companion-pairing";
export const CLIENT_KEY = "cmx-companion-client";

/** How long a direct connection may take to open before it's retried. */
const CONNECT_TIMEOUT_MS = 20000;
/** "The app isn't there" this many times in a row ends the pairing; fewer may be the server. */
const UNAVAILABLE_LIMIT = 3;

/** ICE states after which WebRTC soon drops its candidate pairs from the stats. */
const ICE_GAVE_UP = ["disconnected", "failed"];
/** How long ICE may stay "disconnected" before the connection counts as lost. */
const DISCONNECTED_GRACE_MS = 5000;
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

/** How long to wait for the app's challenge once connected before connecting again. */
const CHALLENGE_WAIT_MS = 8000;

function store(get) {
  try { return get(); } catch { return null; }
}

/** A pairing server this page will use: an https:// URL, or http:// on this machine only, as the
 *  tests run one there. Anything else, null. */
export function usableServer(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return url.protocol === "https:" || (url.protocol === "http:" && local) ? url.href : null;
}

/** The STUN servers the link names; only `stun:` and `stuns:` ones, as the app sends no others. */
const stunServers = list => (Array.isArray(list) ? list : []).filter(s => typeof s === "string" && /^stuns?:/i.test(s));

/**
 * The pairing from the link's `#peer=…&server=…&stun=…&k=…` (`code`: the QR code's secret), else
 * the one this page remembers (`deviceKey`: the key the app gave it). The page has no servers of
 * its own: one without a usable pairing server, or with neither secret, counts as none.
 */
export function readPairing(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const peer = params.get("peer");
  if (peer) {
    const server = usableServer(params.get("server"));
    const code = params.get("k");
    return server && code ? { peer, server, stun: stunServers(params.getAll("stun")), code } : null;
  }
  const saved = store(() => JSON.parse(localStorage.getItem(PAIRING_KEY) ?? "null"));
  const server = saved && usableServer(saved.server);
  if (server && typeof saved.peer === "string" && typeof saved.deviceKey === "string") {
    const credentialId = typeof saved.credentialId === "string" ? { credentialId: saved.credentialId } : {};
    return { peer: saved.peer, server, stun: stunServers(saved.stun), deviceKey: saved.deviceKey, ...credentialId };
  }
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

/** A candidate line's kind, protocol and address, kept in memory to judge the network; never logged. */
export function parseCandidateLine(line) {
  const parts = line.replace(/^a=/, "").split(" ");
  const typ = parts.indexOf("typ");
  return { type: (typ >= 0 && parts[typ + 1]) || "?", protocol: (parts[2] ?? "?").toLowerCase(), address: parts[4] ?? "", port: parts[5] ?? "" };
}

/**
 * Whether one side's network gives it a new public port for each server it reaches: more distinct
 * public (srflx) UDP addresses than local (host) UDP ones, as a network that keeps one mapping
 * shows the same public address to every STUN server. That defeats a direct route. null when it
 * can't tell: fewer than two STUN servers, or no host or srflx candidate yet.
 */
export function mappingVaries(candidates, stunServers) {
  if (stunServers < 2) return null;
  const udp = candidates.filter(c => c.protocol === "udp");
  const hosts = udp.filter(c => c.type === "host").length;
  const mapped = new Set(udp.filter(c => c.type === "srflx").map(c => `${c.address}:${c.port}`)).size;
  return hosts && mapped ? mapped > hosts : null;
}

/** Which side's network stops a direct route, from each side's candidates: "computer", "phone",
 *  "both", or null when neither shows it. */
export function networkCause(local, remote, stunServers) {
  const phone = mappingVaries(local, stunServers) === true;
  const computer = mappingVaries(remote, stunServers) === true;
  return phone && computer ? "both" : computer ? "computer" : phone ? "phone" : null;
}

/** Where PeerJS reaches the pairing server, and the STUN servers WebRTC uses, both from the link. */
export function peerOptions(server, stun) {
  const url = new URL(server);
  const secure = url.protocol === "https:";
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 443 : 80,
    path: url.pathname || "/",
    secure,
    config: { iceServers: stun.map(urls => ({ urls })) },
  };
}

/**
 * Statuses: "unpaired", "connecting", "connected", "reconnecting", "ended", "locked" (the app
 * asks for the phone's screen lock before it reconnects; `unlock()` answers) and "enrolling" (the
 * app needs the screen lock set up before it lets this page in; `enrolScreenLock()` answers) and
 * "confirming" (the app waits for the person at the computer to confirm this phone, by the code
 * in `confirmCode`, which both show).
 * `onEnded(reason)` gets "left" (disconnected from this page), "outdated" (the app is too old for
 * this page), "refused" (the app turned down the pairing check, as for an expired code),
 * "lockRefused" (it turned down a connection that had to pass or set up the screen lock),
 * "notConfirmed" (the person at the computer said this isn't their phone, or didn't answer),
 * "unverified" (whatever answered couldn't prove it's the app paired with), "disconnected",
 * "replaced" or "unavailable".
 * `onTrouble(cause)` runs when a direct connection didn't open in time; `cause` names the network
 * that stops one ("computer", "phone" or "both"), or is null when neither shows it.
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

  /** Answers the app's challenge with the code or the device key, bound to this connection. When
   *  the app asks for the screen lock on a reconnect, it waits for `unlock()` instead. `enrolUV`:
   *  once the app has proved itself, the page sets the screen lock up before anything else. */
  async answerChallenge(conn, nonce, requireUV, enrolUV, confirm) {
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
    const uv = requireUV && kind === "device";
    conn.challenge = { nonce, secret, fps, uv, enrol: enrolUV && !uv, confirm };
    if (uv) {
      // The phone's prompt needs a tap on Safari, so the page asks for one rather than prompting.
      this.log("Screen lock: the app asks for it before this phone reconnects");
      this.setStatus("locked");
      return;
    }
    await this.sendAuth(conn, kind);
  }

  async sendAuth(conn, kind, webauthn) {
    const c = conn.challenge;
    c.sent = true;
    const p = await proof(c.secret, "phone", c.nonce, c.fps.app, c.fps.phone);
    if (conn !== this.conn) return;
    this.send({ type: "auth", kind, proof: p, ...(webauthn ? { webauthn } : {}) });
    this.log(`Pairing check: answered with ${kind === "pair" ? "the code" : webauthn ? "this phone's key and screen lock" : "this phone's key"}`);
  }

  /** Asks the phone for its screen lock, from a tap on Unlock, and answers the app's challenge
   *  with it. Throws, leaving Unlock to tap again, if the person cancels or the phone can't. */
  async unlock() {
    const conn = this.conn;
    const c = conn?.challenge;
    if (!c?.uv || c.sent || this.status !== "locked") return;
    if (!this.pairing.credentialId) {
      // The app has this phone's screen lock but the page lost its credential: it can only fail.
      this.log("Screen lock: this page has no credential for it");
      await this.sendAuth(conn, "device");
      return;
    }
    const webauthn = await checkScreenLock(this.pairing.credentialId, await uvChallenge(c.nonce, c.fps.app, c.fps.phone));
    if (conn !== this.conn || c.sent) return;
    this.setStatus("connecting");
    await this.sendAuth(conn, "device", webauthn);
  }

  /** Sets up the phone's screen lock, from a tap, when the app needs it before it lets this page
   *  in. Throws, leaving the button to tap again, if the person cancels, the phone can't, or the
   *  app turns the credential down. */
  async enrolScreenLock() {
    const conn = this.conn;
    if (!conn?.enrolling || conn.enrolWait || this.status !== "enrolling") return;
    const made = await createScreenLock();
    if (conn !== this.conn || !conn.enrolling) return;
    const answer = new Promise((resolve, reject) => { conn.enrolWait = { resolve, reject, credentialId: made.credentialId }; });
    this.send({ type: "enrol", ...made });
    await answer;
  }

  /** The app's answer to `enrol`: taken, and this page is let in; or not, to try again. */
  enrolled(conn, m) {
    const wait = conn.enrolWait;
    if (!wait) return;
    conn.enrolWait = null;
    // "not asked": the app turned its setting off meanwhile, and lets this page in without.
    if (m.ok === true || m.reason === "not asked") {
      conn.enrolling = false;
      if (m.ok === true) {
        this.saveScreenLock(wait.credentialId);
        this.log("Screen lock: set up; reconnecting now asks for it");
      }
      this.letIn(conn);
      wait.resolve();
      return;
    }
    this.log(`Screen lock: the app didn't take it (${m.reason ?? "no reason"})`);
    wait.reject(new Error("refused"));
  }

  /** Keeps the credential the app took, with the pairing, for the next reconnect. */
  saveScreenLock(credentialId) {
    if (!this.pairing?.deviceKey) return;
    this.pairing = { ...this.pairing, credentialId };
    store(() => localStorage.setItem(PAIRING_KEY, JSON.stringify(this.pairing)));
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
      this.pairing = { peer: this.pairing.peer, server: this.pairing.server, stun: this.pairing.stun, deviceKey: m.deviceKey };
      store(() => localStorage.setItem(PAIRING_KEY, JSON.stringify(this.pairing)));
    }
    clearTimeout(this.challengeTimer);
    this.log("Pairing check: passed");
    this.unavailable = 0;
    this.attempt = 0;
    if (c.enrol) {
      // The phone's prompt needs a tap on Safari, so the page asks for one rather than prompting.
      conn.enrolling = true;
      this.log("Screen lock: the app needs it set up before it shows anything");
      this.setStatus("enrolling");
      return;
    }
    this.letIn(conn);
  }

  /** The code the app and the computer show while this phone waits to be confirmed. */
  get confirmCode() {
    return this.conn?.confirming ? this.conn.confirmCode ?? null : null;
  }

  letIn(conn) {
    // A new pairing waits for the person at the computer to confirm it's this phone.
    if (conn.challenge?.confirm && !conn.confirmed) {
      conn.confirming = true;
      this.log("Pairing: waiting for the computer to confirm this phone");
      this.setStatus("confirming");
      return;
    }
    conn.confirming = false;
    conn.authed = true;
    this.setStatus("connected");
    this.send({ type: "hello", clientId: clientId(), features: PAGE_FEATURES });
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
    const options = peerOptions(this.pairing.server, this.pairing.stun);
    this.log(`Connecting via the pairing server, ${options.config.iceServers.length} STUN servers`);
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
        this.onTrouble(this.networkCause(conn));
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
          this.scheduleRetry();
        }, CHALLENGE_WAIT_MS);
      });
      conn.on("data", m => {
        if (conn !== this.conn || !m || m.v !== 1) return;
        if (m.type === "goodbye" && m.reason === "refused") {
          this.log(conn.confirming ? "Pairing: not confirmed at the computer" : "Pairing check: refused by the app");
          this.end(conn.confirming ? "notConfirmed" : conn.challenge?.uv || conn.challenge?.enrol ? "lockRefused" : "refused");
          return;
        }
        // Kept whenever it comes, as it can arrive while the app's proof is still being checked.
        if (m.type === "confirmCode" && typeof m.code === "string" && /^\d{6}$/.test(m.code)) {
          conn.confirmCode = m.code;
          if (conn.confirming) this.setStatus("confirming");
          return;
        }
        if (m.type === "pairingConfirmed") {
          conn.confirmed = true;
          if (conn.confirming) {
            this.log("Pairing: confirmed at the computer");
            this.letIn(conn);
          }
          return;
        }
        if (conn.confirming) {
          if (m.type === "goodbye") this.end(this.leaving || "disconnected");
          return;
        }
        if (conn.enrolling) {
          if (m.type === "enrolled") this.enrolled(conn, m);
          return;
        }
        if (!conn.authed) {
          if (m.type === "challenge" && typeof m.nonce === "string" && !conn.challenge) {
            this.answerChallenge(conn, m.nonce, m.requireUV === true, m.enrolUV === true, m.confirmPairing === true).catch(() => this.end("unverified"));
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
    conn.candidates = { local: [], remote: [] };
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
    let stuck = null;
    pc.addEventListener("iceconnectionstatechange", () => {
      this.log(`ICE connection state: ${pc.iceConnectionState}`);
      clearTimeout(stuck);
      // Browsers may sit in "disconnected" for good, and PeerJS closes only on "failed", so the
      // page would stay "Connected" on a dead link. Past a blip, connect afresh instead.
      if (pc.iceConnectionState === "disconnected") {
        stuck = setTimeout(() => {
          if (conn !== this.conn || pc.iceConnectionState !== "disconnected") return;
          this.log(`No way back to the computer after ${DISCONNECTED_GRACE_MS / 1000}s`);
          this.scheduleRetry();
        }, DISCONNECTED_GRACE_MS);
      }
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
      if (line) {
        this.log(`remote candidate received: ${describeCandidateLine(line)}`);
        conn.candidates.remote.push(parseCandidateLine(line));
      }
      try {
        await add(candidate);
      } catch (err) {
        this.log(`remote candidate rejected: ${err?.name ?? "error"}`);
        throw err;
      }
    };
    pc.addEventListener("icecandidate", e => {
      const c = e.candidate;
      if (!c) return;
      this.log(`local candidate: ${c.type ?? "?"} ${c.protocol ?? ""}${c.address?.endsWith(".local") ? " (mDNS name)" : ""}`);
      conn.candidates.local.push({ type: c.type ?? "?", protocol: (c.protocol ?? "?").toLowerCase(), address: c.address ?? "", port: String(c.port ?? "") });
    });
  }

  /** Which side's network stops a direct route on this connection, by the candidates seen so far. */
  networkCause(conn) {
    if (!conn.candidates) return null;
    return networkCause(conn.candidates.local, conn.candidates.remote, this.pairing?.stun?.length ?? 0);
  }

  /** The candidates each side offered and how each pair fared, from WebRTC's own stats, then which
   *  network, if either, stops a direct route. Once ICE has given up the stats may have lost the
   *  computer's candidates and the pairs, so the candidates as they arrived stand in. Not polled
   *  while ICE checks: Chrome can hand that report, without certificates, to the pairing check. */
  async reportCandidates(conn) {
    const pc = conn.peerConnection;
    if (!pc) return;
    const now = { local: [], remote: [], pairs: [] };
    try {
      (await pc.getStats()).forEach(s => {
        if (s.type === "local-candidate") now.local.push(`${s.candidateType}/${s.protocol}`);
        if (s.type === "remote-candidate") now.remote.push(`${s.candidateType}/${s.protocol}`);
        if (s.type === "candidate-pair") now.pairs.push(`${s.state}${s.nominated ? " (nominated)" : ""}`);
      });
    } catch (e) {
      this.log(`Couldn't read WebRTC stats: ${e}`);
    }
    const arrived = conn.candidates ?? { local: [], remote: [] };
    const kinds = list => list.map(c => `${c.type}/${c.protocol}`);
    const either = (stats, seen) => (stats.length ? stats : seen).join(", ") || "none";
    const gaveUp = ICE_GAVE_UP.includes(pc.iceConnectionState);
    this.log(`This phone offered: ${either(now.local, kinds(arrived.local))}`);
    this.log(`The computer offered: ${either(now.remote, kinds(arrived.remote))}`);
    this.log(`Candidate pairs: ${now.pairs.join(", ") || (gaveUp ? "none left once the connection gave up" : "none")}`);
    const cause = this.networkCause(conn);
    const varies = "network gives it a new public port for each server it reaches, so a direct route is unlikely";
    if (cause === "computer" || cause === "both") this.log(`The computer's ${varies}`);
    if (cause === "phone" || cause === "both") this.log(`This phone's ${varies}`);
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

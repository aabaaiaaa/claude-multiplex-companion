// Proving, over the data channel, that each end holds the pairing's secret (see PROTOCOL.md).
//
// The PeerJS server introduces the two ends and relays the certificate fingerprints WebRTC's
// encryption rests on, so on its own it could pose as either end. Each end therefore proves it
// holds a secret the server never sees (the QR link's `#` part, then a key the app hands this
// page), bound to this connection's two fingerprints and a fresh nonce.
//
// The desktop app keeps the same code; the shared fixture's test vector keeps the two in step.

const LABEL = { phone: "cmx-companion phone v1", app: "cmx-companion app v1" };

export function toBase64Url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The certificate fingerprints of the DTLS link actually in use, from WebRTC's stats rather than
 * the descriptions: a description can list fingerprints the link doesn't use, and the other end's
 * came through the signalling server. Null when the stats don't say.
 */
export async function negotiatedFingerprints(pc) {
  if (!pc) return null;
  const byId = new Map();
  const transports = [];
  (await pc.getStats()).forEach(s => {
    if (typeof s.id === "string") byId.set(s.id, s);
    if (s.type === "transport") transports.push(s);
  });
  const fingerprint = id => {
    const cert = typeof id === "string" ? byId.get(id) : undefined;
    const alg = cert?.fingerprintAlgorithm;
    const fp = cert?.fingerprint;
    return typeof alg === "string" && typeof fp === "string" && /^[0-9A-Fa-f:]+$/.test(fp)
      ? `${alg.toLowerCase()} ${fp.toUpperCase()}`
      : null;
  };
  // One DTLS transport carries the data channel; more than one with certificates is unexpected.
  const linked = transports.filter(t => t.localCertificateId && t.remoteCertificateId);
  if (linked.length !== 1) return null;
  const local = fingerprint(linked[0].localCertificateId);
  const remote = fingerprint(linked[0].remoteCertificateId);
  return local && remote ? { local, remote } : null;
}

/** What `role` ("phone" or "app") sends to prove it holds `secret` on this connection. */
export async function proof(secret, role, nonce, appFp, phoneFp) {
  const raw = fromBase64Url(secret);
  if (!raw) throw new Error("not a secret");
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const message = new TextEncoder().encode([LABEL[role], nonce, appFp, phoneFp].join("\n"));
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, message)));
}

/** Equal strings, compared without stopping at the first difference. */
export function sameProof(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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

/** "sha-256 AB:CD:…" from a description's first `a=fingerprint:` line, or null without one. */
export function fingerprintOf(sdp) {
  const m = /^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/m.exec(sdp ?? "");
  return m ? `${m[1].toLowerCase()} ${m[2].toUpperCase()}` : null;
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

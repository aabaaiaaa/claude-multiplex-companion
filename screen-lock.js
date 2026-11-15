// The phone's screen lock, asked for by the app before a reconnect (see PROTOCOL.md → *Screen lock*).
//
// A page can't read the phone's PIN or pattern, but a WebAuthn credential that needs user
// verification makes the phone show its own lock-screen check (PIN, pattern, fingerprint or face)
// each time it's used. The page only relays what the phone signs; the app checks the signature
// against the key registered here. The app keeps the same `uvChallenge`; the shared fixture's
// `uvVector` keeps the two in step.

import { fromBase64Url, toBase64Url } from "./auth.js";

const LABEL = "cmx-companion uv v1";
/** ES256 (ECDSA P-256 with SHA-256), the only kind the app takes. */
const ES256 = -7;
/** How long the phone's prompt may stay up; the app waits 60 s for the answer. */
const PROMPT_MS = 55_000;

/** The WebAuthn challenge for this connection: tied to the app's nonce and both certificate
 *  fingerprints, so what the phone signs fits only this link, as the pairing proof does. */
export async function uvChallenge(nonce, appFp, phoneFp) {
  const message = new TextEncoder().encode([LABEL, nonce, appFp, phoneFp].join("\n"));
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", message)));
}

/** Whether this phone has a screen lock the page can ask for. */
export async function screenLockAvailable() {
  try {
    return typeof PublicKeyCredential !== "undefined"
      && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

const b64 = buffer => toBase64Url(new Uint8Array(buffer));

/** Makes this phone's credential, behind its screen lock, and returns what `enrol` sends. Needs a
 *  tap on Safari. Throws if the person cancels or the phone can't. */
export async function createScreenLock() {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: "claude-multiplex companion" },
      // Not a person's account: a fresh id per pairing, named only for the phone's passkey list.
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "claude-multiplex phone", displayName: "claude-multiplex phone" },
      // The app checks the key and flags, not this challenge: the enrolment rides the checked link.
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "discouraged", requireResidentKey: false, userVerification: "required" },
      attestation: "none",
      timeout: PROMPT_MS,
    },
  });
  const r = cred?.response;
  const publicKey = r?.getPublicKey?.();
  if (!publicKey) throw new Error("no usable key");
  return {
    credentialId: b64(cred.rawId),
    publicKey: b64(publicKey),
    alg: r.getPublicKeyAlgorithm(),
    authenticatorData: b64(r.getAuthenticatorData()),
    clientDataJSON: b64(r.clientDataJSON),
  };
}

/** Asks the phone for its screen lock and returns what `auth.webauthn` carries. Needs a tap on
 *  Safari. Throws if the person cancels or the phone can't. */
export async function checkScreenLock(credentialId, challenge) {
  const id = fromBase64Url(credentialId);
  const bytes = fromBase64Url(challenge);
  if (!id || !bytes) throw new Error("no credential");
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: bytes,
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id, transports: ["internal"] }],
      userVerification: "required",
      timeout: PROMPT_MS,
    },
  });
  const r = cred?.response;
  if (!r?.signature) throw new Error("no answer");
  return {
    credentialId: b64(cred.rawId),
    authenticatorData: b64(r.authenticatorData),
    clientDataJSON: b64(r.clientDataJSON),
    signature: b64(r.signature),
  };
}

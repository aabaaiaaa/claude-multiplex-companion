// The page's side of the screen lock check: the offer to set it up while connected, and the
// Unlock screen a reconnect waits on (see PROTOCOL.md → *Screen lock*).

import { appFeatures } from "./desktop-features.js";
import { createScreenLock, screenLockAvailable } from "./screen-lock.js";

const $ = sel => document.querySelector(sel);

const OFFER = "claude-multiplex asks for this phone's screen lock before it reconnects. Set it up to use your PIN, pattern, fingerprint or face.";
const NO_LOCK = "claude-multiplex asks for this phone's screen lock before it reconnects, but this phone has none this page can use. Until it does, this phone reconnects with its key alone.";

/** `connection`: the Connection. `toast(text)` and `log(text)` say what happened. Returns what
 *  app.js passes on: each status, each `welcome` or `features` list, and each `enrolled`. */
export function setupScreenLock({ connection, toast, log }) {
  /** The app names "userVerification" on this connection. */
  let asked = false;
  /** Nothing more to set up on this connection. */
  let settled = false;
  /** The phone's prompt is up. */
  let busy = false;
  /** The credential sent in `enrol`, until the app answers. */
  let pending = null;
  let available = null;
  screenLockAvailable().then(a => { available = a; render(); });

  function render() {
    const show = connection.status === "connected" && asked && !settled && !connection.passedScreenLock;
    $(".lock-setup").hidden = !show;
    if (!show) return;
    $(".lock-setup-text").textContent = available === false ? NO_LOCK : OFFER;
    $(".lock-setup-button").hidden = available === false;
    $(".lock-setup-button").disabled = busy || pending !== null;
  }

  $(".lock-setup-button").addEventListener("click", async () => {
    busy = true;
    render();
    try {
      const enrolment = await createScreenLock();
      if (connection.send({ type: "enrol", ...enrolment })) pending = enrolment.credentialId;
    } catch (err) {
      log(`Screen lock: not set up (${err?.name ?? "error"})`);
      toast("Screen lock not set up");
    } finally {
      busy = false;
      render();
    }
  });

  $(".unlock").addEventListener("click", async () => {
    const button = $(".unlock");
    button.disabled = true;
    $(".locked-note").textContent = "";
    try {
      await connection.unlock();
    } catch (err) {
      log(`Screen lock: not unlocked (${err?.name ?? "error"})`);
      $(".locked-note").textContent = "Not unlocked. Tap Unlock to try again.";
    } finally {
      button.disabled = connection.status !== "locked";
    }
  });

  return {
    status(status) {
      if (status === "locked") {
        $(".unlock").disabled = false;
        $(".locked-note").textContent = "";
      }
      if (status !== "connected") {
        asked = false;
        settled = false;
        pending = null;
      }
      render();
    },
    features(features) {
      asked = appFeatures(features).userVerification;
      render();
    },
    enrolled(m) {
      if (m.ok && pending) {
        connection.saveScreenLock(pending);
        settled = true;
        log("Screen lock: set up; reconnecting now asks for it");
        toast("Screen lock set up: reconnecting now asks for it");
      } else if (!m.ok) {
        log(`Screen lock: the app didn't take it (${m.reason ?? "no reason"})`);
        // Already set up, or no longer asked for: nothing to offer. Anything else may work again.
        if (m.reason === "already set up" || m.reason === "not asked") settled = true;
        else toast("The app couldn't use this phone's screen lock");
      }
      pending = null;
      render();
    },
  };
}

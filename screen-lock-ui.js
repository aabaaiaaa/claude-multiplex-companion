// The page's side of the screen lock check: the screen that sets it up before the app lets this
// page in, and the Unlock screen a reconnect waits on (see PROTOCOL.md → *Screen lock*).

import { screenLockAvailable } from "./screen-lock.js";

const $ = sel => document.querySelector(sel);

/** `connection`: the Connection. `log(text)` says what happened. Returns what app.js passes on:
 *  each status. */
export function setupScreenLock({ connection, log }) {
  let available = null;
  screenLockAvailable().then(a => { available = a; render(); });

  function render() {
    // A phone without one can't make the credential, so there's nothing to tap.
    $(".enrol-no-lock").hidden = available !== false;
    $(".enrol-button").hidden = available === false;
  }

  /** Runs `act` from a tap on `button`; `failed(err)` says in `note` why it didn't go through. */
  function onTap(button, note, act, failed) {
    $(button).addEventListener("click", async () => {
      $(button).disabled = true;
      $(note).textContent = "";
      try {
        await act();
      } catch (err) {
        log(`Screen lock: didn't go through (${err?.name ?? "error"})`);
        $(note).textContent = failed(err);
      } finally {
        $(button).disabled = false;
      }
    });
  }

  onTap(".enrol-button", ".enrol-note", () => connection.enrolScreenLock(), err =>
    err instanceof DOMException
      ? "Not set up. Tap Set up screen lock to try again."
      : "The app couldn't use this phone's screen lock. Tap Set up screen lock to try again.");
  onTap(".unlock", ".locked-note", () => connection.unlock(), () => "Not unlocked. Tap Unlock to try again.");

  return {
    status(status) {
      // Each new ask starts clean.
      if (status === "locked") {
        $(".unlock").disabled = false;
        $(".locked-note").textContent = "";
      }
      if (status === "enrolling") {
        $(".enrol-button").disabled = false;
        $(".enrol-note").textContent = "";
      }
      render();
    },
  };
}

// The oldest desktop app this page works with. One page serves every app, so a change that needs
// something new from the app raises this; an older app is then asked to update rather than
// half-working.
export const MIN_DESKTOP_VERSION = "0.26.0";

/** [major, minor, patch] from "1.2.3" (anything after is ignored), or null if it isn't one. */
function parse(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "").trim());
  return m ? m.slice(1, 4).map(Number) : null;
}

/** Whether `version` is too old for this page: older than the minimum, or missing or unreadable. */
export function desktopTooOld(version, min = MIN_DESKTOP_VERSION) {
  const have = parse(version);
  const need = parse(min);
  if (!have || !need) return true;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] < need[i];
  }
  return false;
}

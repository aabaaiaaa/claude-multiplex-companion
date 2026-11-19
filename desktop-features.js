// What this page does with an app beyond what MIN_DESKTOP_VERSION guarantees. One page serves
// every app version and deploys on its own, so a change that needs newer app behaviour is turned
// on only for an app that names it in `welcome`'s `features`. An older app keeps working, without
// it, and without being asked to update. PROTOCOL.md lists each name and the app that first sends it.
export const FEATURES = Object.freeze({
  /** The app sends images Claude's text names, while its image sharing setting is on. */
  images: "images",
  /** A full path written without backticks also counts as an image reference. Only with images. */
  plainPaths: "plainPaths",
  /** A running session whose last turn failed with a certificate error has `certError` on its
   *  row, and `restartSession` starts its claude again. */
  certRestart: "certRestart",
});

/** For each name in FEATURES, whether the app's `features` list holds it. Anything else in the
 *  list is ignored: it's for a newer page. */
export function appFeatures(features) {
  const list = Array.isArray(features) ? features : [];
  const has = name => list.includes(name);
  const images = has(FEATURES.images);
  return { images, plainPaths: images && has(FEATURES.plainPaths), certRestart: has(FEATURES.certRestart) };
}

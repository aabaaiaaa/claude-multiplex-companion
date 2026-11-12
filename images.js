// Opening an image Claude names: asks the app for it, takes it in pieces, and shows it in the viewer.

import { closeViewer, onViewerClose, openViewer, viewerError, viewerProgress, viewerShow } from "./viewer.js";

const LOAD_FAILED = "Couldn't load the image.";

/** What the page gives this module: `send(m)` (false when not connected), `promptBlock()` (why
 *  the open session can't take a prompt now, or "") and `submitPrompt(text)`. */
let page = { send: () => false, promptBlock: () => "", submitPrompt: () => false };

/** The request in flight: { id, sessionId, turn, ref, mime, size, parts, got, bytes }, `parts` set
 *  once the app's `image` reply says how many pieces; null when none is. */
let current = null;
/** The error shown with an ask button, kept so the button follows the session's state. */
let asking = null;

export function setupImages(deps) {
  page = deps;
}

/** The last part of a path, after the last `\` or `/`. */
export const lastPart = ref => ref.slice(Math.max(ref.lastIndexOf("\\"), ref.lastIndexOf("/")) + 1) || ref;

/** A drive-letter (`C:\`, `C:/`) or rooted (`\`, `/`) path. */
const isFullPath = ref => /^[A-Za-z]:[\\/]/.test(ref) || /^[\\/]/.test(ref);

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `img-${[...bytes].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Stops the one in flight; the app sends nothing more for it, and anything late is ignored. */
function cancelCurrent() {
  if (!current) return;
  page.send({ type: "cancelImage", id: current.id });
  current = null;
}

/** Shows the loading error with a button that asks again. */
function failed(request) {
  current = null;
  asking = null;
  viewerError(LOAD_FAILED, { label: "Try again", onPress: () => requestImage(request) });
}

/** Asks the app for the image `ref` named in turn `turn`, and opens the viewer for it. */
export function requestImage({ sessionId, turn, ref }) {
  cancelCurrent();
  asking = null;
  const request = { sessionId, turn, ref };
  const id = newId();
  current = { id, ...request, parts: null };
  openViewer(lastPart(ref));
  if (!page.send({ type: "openImage", id, sessionId, turn, ref })) failed(request);
}

function showAsk() {
  const reason = page.promptBlock();
  const ask = asking;
  viewerError(ask.text, {
    label: "Ask Claude for the full path",
    disabledReason: reason || undefined,
    onPress() {
      asking = null;
      closeViewer();
      page.submitPrompt(`What's the full path of \`${ask.ref}\`? Reply with just the full path, in backticks.`);
    },
  });
}

function showError(ref, error) {
  if (error !== "not-found" && error !== "ambiguous") {
    viewerError(LOAD_FAILED);
    return;
  }
  if (isFullPath(ref)) {
    viewerError(`\`${ref}\` isn't there any more.`);
    return;
  }
  asking = { ref, text: error === "ambiguous" ? `Found more than one \`${ref}\`.` : `Couldn't find \`${ref}\`.` };
  showAsk();
}

/** A piece's bytes, as PeerJS hands them over: an ArrayBuffer or a typed array. */
function pieceBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** Takes an `image`, `imagePiece` or `imageDone` message; one for another request is ignored. */
export function takeImageMessage(m) {
  if (!current || m.id !== current.id) return;
  const request = { sessionId: current.sessionId, turn: current.turn, ref: current.ref };
  if (m.type === "image") {
    if (current.parts) return;
    if (m.error) {
      current = null;
      showError(request.ref, m.error);
      return;
    }
    if (!Number.isInteger(m.pieces) || m.pieces < 0) { failed(request); return; }
    current.mime = typeof m.mime === "string" ? m.mime : "";
    current.size = Number.isFinite(m.size) && m.size > 0 ? m.size : 0;
    current.parts = new Array(m.pieces);
    current.got = 0;
    current.bytes = 0;
    viewerProgress(0);
  } else if (m.type === "imagePiece") {
    if (!current.parts || !Number.isInteger(m.index) || m.index < 0 || m.index >= current.parts.length) return;
    const bytes = pieceBytes(m.data);
    if (!bytes || current.parts[m.index]) return;
    current.parts[m.index] = bytes;
    current.got += 1;
    current.bytes += bytes.byteLength;
    viewerProgress(current.size ? current.bytes / current.size : current.got / current.parts.length);
  } else if (m.type === "imageDone") {
    if (!current.parts || current.got !== current.parts.length) { failed(request); return; }
    const blob = new Blob(current.parts, { type: current.mime });
    current = null;
    viewerShow(blob);
  }
}

/** The connection's status: one that isn't connected loses the image on its way. */
export function imagesStatus(status) {
  if (status === "connected" || !current) return;
  failed({ sessionId: current.sessionId, turn: current.turn, ref: current.ref });
}

/** The composer changed: an ask button shown follows whether the session can take a prompt. */
export function imagesComposerChanged() {
  if (asking) showAsk();
}

onViewerClose(() => {
  asking = null;
  cancelCurrent();
});

// A full-screen image viewer over the chat: the image fitted, with pinch and double-tap zoom and
// drag to pan. The phone's back button closes it; the chat behind never scrolls or zooms.

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/** A double tap zooms to this, about the tap. */
const TAP_SCALE = 2.5;
/** Two taps this close in time and place are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
/** A touch that moves further than this is a drag, not a tap. */
const TAP_SLOP_PX = 10;

const dialog = document.querySelector(".image-viewer");
const stage = dialog.querySelector(".viewer-stage");
const img = stage.querySelector("img");
const status = dialog.querySelector(".viewer-status");
const actions = dialog.querySelector(".viewer-actions");

let url = null;
let closeListeners = [];
/** Whether the history entry the viewer pushed is still there for back to pop. */
let ownEntry = false;
/** Steps back the viewer has asked for that haven't landed yet. */
let pendingBacks = 0;
let savedScroll = null;

// The image's transform: a stage point p is drawn at t + p * scale.
let scale = 1, tx = 0, ty = 0;
const pointers = new Map();
let gesture = null;
let lastTap = null;

function applyTransform() {
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
}

function resetZoom() {
  scale = 1; tx = 0; ty = 0;
  gesture = null;
  lastTap = null;
  pointers.clear();
  applyTransform();
}

/** Keeps the drawn picture in view: centred along an axis it doesn't fill, else covering the stage. */
function clamp() {
  const w = stage.clientWidth, h = stage.clientHeight;
  const nw = img.naturalWidth || w, nh = img.naturalHeight || h;
  const fit = Math.min(w / nw, h / nh);
  const axis = (t, size, drawn) => {
    const start = (size - drawn) / 2;
    if (drawn * scale <= size) return (size - drawn * scale) / 2 - start * scale;
    return Math.min(-start * scale, Math.max(size - (start + drawn) * scale, t));
  };
  tx = axis(tx, w, nw * fit);
  ty = axis(ty, h, nh * fit);
}

/** Zooms to `next` keeping the stage point `cx`,`cy` where it is. */
function zoomAbout(next, cx, cy) {
  next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  tx = cx - (cx - tx) * next / scale;
  ty = cy - (cy - ty) * next / scale;
  scale = next;
  clamp();
  applyTransform();
}

function local(e) {
  const r = stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** Starts a pinch or a drag from the fingers down now. */
function beginGesture() {
  const pts = [...pointers.values()];
  if (pts.length >= 2) {
    const [a, b] = pts;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    gesture = {
      kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale,
      // The image point under the fingers' midpoint, which follows them.
      px: (mid.x - tx) / scale, py: (mid.y - ty) / scale,
    };
  } else if (pts.length === 1) {
    gesture = { kind: "drag", x: pts[0].x, y: pts[0].y, tx, ty, tap: false };
  } else {
    gesture = null;
  }
}

stage.addEventListener("pointerdown", e => {
  if (img.hidden) return;
  e.preventDefault();
  try { stage.setPointerCapture(e.pointerId); } catch { /* a synthetic or already-gone pointer */ }
  pointers.set(e.pointerId, local(e));
  beginGesture();
  // Only a lone finger can be a tap.
  gesture.tap = pointers.size === 1;
});

stage.addEventListener("pointermove", e => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  e.preventDefault();
  pointers.set(e.pointerId, local(e));
  const pts = [...pointers.values()];
  if (gesture.kind === "pinch" && pts.length >= 2) {
    const [a, b] = pts;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, gesture.scale * Math.hypot(a.x - b.x, a.y - b.y) / gesture.dist));
    tx = mid.x - gesture.px * scale;
    ty = mid.y - gesture.py * scale;
    clamp();
    applyTransform();
  } else if (gesture.kind === "drag") {
    const p = pts[0];
    if (Math.hypot(p.x - gesture.x, p.y - gesture.y) > TAP_SLOP_PX) gesture.tap = false;
    if (scale > 1) {
      tx = gesture.tx + p.x - gesture.x;
      ty = gesture.ty + p.y - gesture.y;
      clamp();
      applyTransform();
    }
  }
});

function pointerEnd(e, cancelled) {
  if (!pointers.has(e.pointerId)) return;
  const p = local(e);
  pointers.delete(e.pointerId);
  const wasTap = !cancelled && gesture && gesture.kind === "drag" && gesture.tap && pointers.size === 0
    && Math.hypot(p.x - gesture.x, p.y - gesture.y) <= TAP_SLOP_PX;
  if (pointers.size > 0) {
    beginGesture();
    gesture.tap = false;
    return;
  }
  gesture = null;
  if (!wasTap) { lastTap = null; return; }
  const now = Date.now();
  if (lastTap && now - lastTap.at <= DOUBLE_TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) <= DOUBLE_TAP_PX) {
    lastTap = null;
    if (scale > 1) zoomAbout(1, p.x, p.y);
    else zoomAbout(TAP_SCALE, p.x, p.y);
  } else {
    lastTap = { at: now, x: p.x, y: p.y };
  }
}
stage.addEventListener("pointerup", e => pointerEnd(e, false));
stage.addEventListener("pointercancel", e => pointerEnd(e, true));
// Safari's own pinch gesture, which would zoom the page.
dialog.addEventListener("gesturestart", e => e.preventDefault());

function setStatus(text) {
  status.textContent = text;
  status.hidden = false;
}

function clearImage() {
  if (url) URL.revokeObjectURL(url);
  url = null;
  img.removeAttribute("src");
  img.hidden = true;
  resetZoom();
}

/** Opens the viewer for the image called `title`, showing that it's loading. */
export function openViewer(title) {
  dialog.querySelector(".viewer-title").textContent = title;
  clearImage();
  actions.replaceChildren();
  actions.hidden = true;
  setStatus("Loading…");
  if (!dialog.open) {
    savedScroll = { x: window.scrollX, y: window.scrollY, overflow: document.documentElement.style.overflow };
    document.documentElement.style.overflow = "hidden";
    dialog.showModal();
  }
  // A step back still on its way would pop a new entry, so push once it has landed.
  if (!ownEntry && pendingBacks === 0) {
    history.pushState({ viewer: true }, "");
    ownEntry = true;
  }
}

/** Shows how much of the image has arrived, `fraction` from 0 to 1. */
export function viewerProgress(fraction) {
  if (!dialog.open) return;
  setStatus(`Loading… ${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`);
}

/** Shows the image, fitted to the screen; `onError` runs if the bytes don't decode as one. */
export function viewerShow(blob, onError) {
  if (!dialog.open) return;
  clearImage();
  const shown = url = URL.createObjectURL(blob);
  // Only this image's failure counts, not one replaced or cleared since.
  img.onerror = () => { if (url === shown && dialog.open) onError?.(); };
  img.src = url;
  img.hidden = false;
  status.hidden = true;
  actions.hidden = true;
}

/** Shows `text` in place of the image, with an optional button; one with a `disabledReason` can't be pressed and says why. */
export function viewerError(text, action) {
  if (!dialog.open) return;
  clearImage();
  setStatus(text);
  actions.replaceChildren();
  actions.hidden = !action;
  if (!action) return;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = action.label;
  if (action.disabledReason) {
    button.disabled = true;
    const reason = document.createElement("p");
    reason.className = "viewer-reason";
    reason.textContent = action.disabledReason;
    actions.append(button, reason);
  } else {
    button.addEventListener("click", () => action.onPress());
    actions.append(button);
  }
}

/** Calls `cb` each time the viewer closes; returns a function that stops that. */
export function onViewerClose(cb) {
  closeListeners.push(cb);
  return () => { closeListeners = closeListeners.filter(l => l !== cb); };
}

function hide() {
  if (!dialog.open) return;
  dialog.close();
  clearImage();
  if (savedScroll) {
    document.documentElement.style.overflow = savedScroll.overflow;
    window.scrollTo(savedScroll.x, savedScroll.y);
    savedScroll = null;
  }
  for (const cb of [...closeListeners]) cb();
}

/** Closes the viewer, taking away the history entry it added so back isn't spent on it. */
export function closeViewer() {
  hide();
  if (ownEntry) {
    ownEntry = false;
    pendingBacks++;
    history.back();
  }
}

window.addEventListener("popstate", () => {
  if (pendingBacks > 0) {
    pendingBacks--;
    // Opened again while the step back was on its way.
    if (pendingBacks === 0 && dialog.open && !ownEntry) {
      history.pushState({ viewer: true }, "");
      ownEntry = true;
    }
    return;
  }
  if (!ownEntry) return;
  ownEntry = false;
  hide();
});

dialog.querySelector(".viewer-close").addEventListener("click", closeViewer);
// Escape on a keyboard.
dialog.addEventListener("cancel", e => { e.preventDefault(); closeViewer(); });

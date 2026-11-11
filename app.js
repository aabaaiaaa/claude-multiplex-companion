import { Connection } from "./connection.js";
import { desktopTooOld, MIN_DESKTOP_VERSION } from "./desktop-version.js";
import { formatText } from "./format.js";
import { BUILD_INFO } from "./version.js";

const $ = sel => document.querySelector(sel);

const STATUS_TEXT = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  ended: "Not connected",
  unpaired: "Not paired",
};

const ENDED_TEXT = {
  replaced: "This page was replaced: this phone connected to the app again, from another tab or browser. To use this one instead, scan a new code in claude-multiplex.",
  refused: "The app turned this code down: it may have expired, or been used already. Each code works once, for under a minute. Scan a new one in claude-multiplex.",
  unverified: "Whatever answered couldn't prove it's the app this phone paired with, so this page stopped. Scan a new code in claude-multiplex.",
  disconnected: "Pairing ended in the app. To connect again, scan the code in claude-multiplex.",
  unavailable: "Pairing ended: the app isn't reachable, or it was closed. To connect again, scan the code in claude-multiplex.",
};

const state = {
  sessions: [],
  openId: null,
  cards: new Map(),
  answered: new Set(),
  status: "connecting",
  /** Prompts sent but not yet in the transcript, per session: { text, after, sentAt }, where
   *  `after` is the newest turn number shown when it was sent. */
  ghosts: new Map(),
  /** The open session's live window from the app: its latest turns, rolling forward. */
  entries: [],
  /** Turns before the live window, loaded by scrolling up; dropped again once you're back at the
   *  end and the window moves on, so the chat doesn't keep growing. */
  earlier: [],
  /** Whether there are turns before the first one shown, and whether a page of them is on its way. */
  moreEarlier: false,
  loadingEarlier: false,
  /** The turn number the page on its way was asked to end before. */
  requestedBefore: null,
  /** When Claude's last reply came, what it was, and when you last typed or sent. */
  lastResponseAt: null,
  responseKey: null,
  lastActiveAt: 0,
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function showScreen(name) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = !s.classList.contains(`screen-${name}`);
  const inChat = name === "chat";
  $(".back").hidden = !inChat;
  $(".composer").hidden = !inChat;
  if (!inChat) $(".title").textContent = "Sessions";
  renderJumps();
}

let toastTimer = null;
function toast(text) {
  const t = $(".toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

const openRow = () => state.sessions.find(s => s.id === state.openId);

// ---- Session list -----------------------------------------------------------

function renderList() {
  const list = $(".session-list");
  list.replaceChildren();
  for (const s of state.sessions) {
    const li = el("li");
    li.dataset.id = s.id;
    li.dataset.pending = s.pending ? "1" : "0";
    li.dataset.live = s.live ? "1" : "0";
    const name = el("span", "name", s.name);
    const badges = el("span", "badges");
    if (s.pending) badges.append(el("span", "badge badge-pending", "needs you"));
    badges.append(el("span", "badge", s.state.replace(/_/g, " ")));
    li.append(name, badges);
    li.addEventListener("click", () => openSession(s.id));
    list.append(li);
  }
  $(".empty").hidden = state.sessions.length > 0;
}

// ---- Chat --------------------------------------------------------------------

function openSession(id) {
  state.openId = id;
  state.entries = [];
  state.earlier = [];
  state.moreEarlier = false;
  state.loadingEarlier = false;
  state.lastResponseAt = null;
  state.responseKey = null;
  // Opening a session isn't typing: an earlier reply's age shows as soon as the conversation arrives.
  state.lastActiveAt = 0;
  renderSince();
  $(".title").textContent = openRow()?.name ?? "Session";
  $(".chat").replaceChildren(el("p", "loading", "Loading…"));
  showScreen("chat");
  renderComposer();
  fitInput();
  connection.send({ type: "openSession", sessionId: id });
}

function closeSession() {
  state.openId = null;
  connection.send({ type: "closeSession" });
  showScreen("list");
}

const promptKey = text => text.replace(/\s+/g, " ").trim();
/** Whether a transcript prompt is this sent text: the same, or holding the start of a long one,
 *  as a paste can be stored with more around it. */
function isPrompt(prompt, text) {
  const a = promptKey(prompt);
  const b = promptKey(text);
  return a === b || (b.length >= 20 && a.includes(b.slice(0, 80)));
}
/** The turns as given, each with its turn number (an older app sends none: then its position). */
const numbered = entries => entries.map((t, i) => (Number.isInteger(t.index) ? t : { ...t, index: i }));
const newestIndex = entries => entries.reduce((n, t) => Math.max(n, t.index), -1);

/** A ghost goes once a turn newer than any shown when it was sent holds its prompt, or once a
 *  ghost sent after it has gone: prompts reach the transcript in the order sent. */
function settleGhosts(sessionId, entries) {
  const ghosts = state.ghosts.get(sessionId);
  if (!ghosts) return;
  const used = new Set();
  const landed = ghosts.map(g => {
    const turn = entries.find(t => t.index > g.after && !used.has(t.index) && t.prompt && isPrompt(t.prompt, g.text));
    if (!turn) return false;
    used.add(turn.index);
    return true;
  });
  const last = landed.lastIndexOf(true);
  const left = ghosts.slice(last + 1);
  if (left.length) state.ghosts.set(sessionId, left);
  else state.ghosts.delete(sessionId);
}

const nearEnd = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;

/** Draws the earlier turns, then the live window, then pending prompts. `keepPlace`: turns were
 *  added above, so the view stays on what you were reading rather than jumping. */
function renderChat({ keepPlace = false } = {}) {
  const entries = [...state.earlier, ...state.entries];
  const chat = $(".chat");
  const nearBottom = !keepPlace && nearEnd();
  const heightBefore = document.documentElement.scrollHeight;
  chat.replaceChildren();
  if (state.moreEarlier || state.loadingEarlier) {
    const top = el("button", "earlier", state.loadingEarlier ? "Loading earlier turns…" : "Show earlier turns");
    top.type = "button";
    top.disabled = state.loadingEarlier;
    top.addEventListener("click", loadEarlier);
    chat.append(top);
  }
  const ghosts = state.ghosts.get(state.openId) ?? [];
  if (entries.length === 0 && ghosts.length === 0) chat.append(el("p", "loading", "Nothing in this conversation yet."));
  for (const turn of entries) {
    if (turn.prompt) chat.append(el("div", "you", turn.prompt));
    for (const item of turn.items) {
      if (item.kind === "text") {
        const text = el("div", "claude");
        text.append(...formatText(item.text));
        chat.append(text);
      }
      else if (item.kind === "tools") {
        const details = el("details", "tools");
        const n = item.labels.length;
        details.append(el("summary", "", `${n} tool call${n === 1 ? "" : "s"}`));
        const ul = el("ul");
        for (const label of item.labels) ul.append(el("li", "", label));
        details.append(ul);
        chat.append(details);
      }
    }
  }
  for (const g of ghosts) {
    const note = el("span", "ghost-note");
    note.dataset.sentAt = String(g.sentAt);
    chat.append(el("div", "you ghost", g.text), note);
  }
  renderGhostNotes();
  if (keepPlace) window.scrollBy(0, document.documentElement.scrollHeight - heightBefore);
  else if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
  renderJumps();
}

/** A new live window. Back at the end, the earlier turns go and the chat rolls on; scrolled up
 *  reading, they stay, and turns the window has moved past join them, so nothing you were
 *  reading vanishes from the middle. */
function takeLiveWindow(entries, hasEarlier) {
  const live = numbered(entries);
  const firstLive = live[0]?.index ?? Infinity;
  if (nearEnd() || !state.entries.length) {
    state.earlier = [];
    state.moreEarlier = !!hasEarlier;
    state.loadingEarlier = false;
  } else {
    const passed = state.entries.filter(t => t.index < firstLive && !state.earlier.some(e => e.index === t.index));
    if (passed.length && !state.earlier.length) state.moreEarlier = state.moreEarlier || !!hasEarlier;
    state.earlier = [...state.earlier, ...passed].filter(t => t.index < firstLive);
    if (!state.earlier.length) state.moreEarlier = !!hasEarlier;
  }
  state.entries = live;
}

/** Asks for the page of turns before the first one shown. */
function loadEarlier() {
  if (!state.openId || !state.moreEarlier || state.loadingEarlier) return;
  const first = state.earlier[0] ?? state.entries[0];
  if (!first) return;
  if (!connection.send({ type: "loadEarlier", sessionId: state.openId, before: first.index })) {
    toast(NOT_CONNECTED);
    return;
  }
  state.loadingEarlier = true;
  state.requestedBefore = first.index;
  renderChat({ keepPlace: true });
}

/** A page of earlier turns: added above, keeping your place. */
function takeEarlier(m) {
  if (m.sessionId !== state.openId || m.before !== state.requestedBefore) return;
  const page = numbered(m.entries ?? []);
  const shown = new Set([...state.earlier, ...state.entries].map(t => t.index));
  state.earlier = [...page.filter(t => !shown.has(t.index)), ...state.earlier];
  state.moreEarlier = !!m.hasEarlier && page.length > 0;
  state.loadingEarlier = false;
  renderChat({ keepPlace: true });
}

// Scrolling to the top fetches the turns before it.
window.addEventListener("scroll", () => {
  if (window.scrollY < 80 && state.openId && !$(".screen-chat").hidden) loadEarlier();
}, { passive: true });

// ---- Jumping to Claude's last response, and to the end ---------------------------

/** Within this of the bottom counts as at the end. */
const AT_END_PX = 24;

const lastReply = () => [...document.querySelectorAll(".chat .claude")].at(-1) ?? null;
const atEnd = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - AT_END_PX;

/** ↑ once you're below the start of Claude's last response; ↓ until you're at the end. */
function renderJumps() {
  const inChat = !!state.openId && !$(".screen-chat").hidden;
  const reply = inChat ? lastReply() : null;
  const headerBottom = $(".top").getBoundingClientRect().bottom;
  $(".jump-reply").hidden = !reply || reply.getBoundingClientRect().top >= headerBottom;
  $(".jump-end").hidden = !inChat || atEnd();
}

$(".jump-reply").addEventListener("click", () => {
  const reply = lastReply();
  if (!reply) return;
  const top = reply.getBoundingClientRect().top + window.scrollY - $(".top").offsetHeight - 8;
  window.scrollTo({ top, behavior: "smooth" });
});
$(".jump-end").addEventListener("click", () => {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
});
window.addEventListener("scroll", renderJumps, { passive: true });
window.addEventListener("resize", renderJumps);

// ---- Composer: the prompt card and the prompt box ---------------------------

const NOT_CONNECTED = "Not connected. Try again once it reconnects.";

function answer(card, choice) {
  if (!connection.send({ type: "answer", sessionId: state.openId, cardId: card.id, choice })) {
    toast(NOT_CONNECTED);
    return;
  }
  state.answered.add(card.id);
  for (const b of $(".card").querySelectorAll("button, input")) b.disabled = true;
}

/** A question the app asks itself before acting for this phone, such as the over-budget
 *  reminder before it starts a session: the first option goes ahead, the last doesn't. */
function confirmCard(card) {
  const box = el("div");
  box.append(el("p", "card-title", card.title), el("p", "card-body", card.body));
  const row = el("div", "choices");
  card.options.forEach((o, index) => {
    const b = el("button", index === card.options.length - 1 ? "choice choice-no" : "choice", o.label);
    b.type = "button";
    b.addEventListener("click", () => answer(card, { kind: "option", index }));
    row.append(b);
  });
  box.append(row);
  return box;
}

function permissionCard(card) {
  const box = el("div");
  box.append(el("p", "card-title", `Allow ${card.toolName}?`), el("pre", "summary", card.summary));
  const row = el("div", "choices");
  card.options.forEach((o, index) => {
    const b = el("button", index === card.options.length - 1 ? "choice choice-no" : "choice", o.label);
    b.type = "button";
    b.addEventListener("click", () => answer(card, { kind: "option", index }));
    row.append(b);
  });
  box.append(row);
  return box;
}

function optionLabel(o) {
  const text = el("span", "option-text");
  text.append(el("span", "option-label", o.label));
  if (o.description) text.append(el("span", "option-description", o.description));
  return text;
}

function singleQuestion(card, q) {
  const box = el("div");
  if (q.header) box.append(el("p", "card-header", q.header));
  box.append(el("p", "card-title", q.question));
  q.options.forEach((o, index) => {
    const b = el("button", "option");
    b.type = "button";
    b.append(optionLabel(o));
    b.addEventListener("click", () => answer(card, { kind: "option", index }));
    box.append(b);
  });
  const other = el("form", "other");
  const input = el("input", "other-input");
  input.placeholder = "Or type your own answer";
  const send = el("button", "other-send", "Send");
  send.type = "submit";
  other.append(input, send);
  other.addEventListener("submit", e => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) answer(card, { kind: "text", text });
  });
  box.append(other);
  return box;
}

function choiceQuestions(card) {
  const form = el("form");
  const multi = card.questions.length === 1;
  card.questions.forEach((q, n) => {
    const set = el("fieldset");
    if (q.header) set.append(el("legend", "card-header", q.header));
    set.append(el("p", "card-title", q.question));
    q.options.forEach((o, index) => {
      const label = el("label", "pick");
      const input = el("input");
      input.type = multi ? "checkbox" : "radio";
      input.name = `q${n}`;
      input.value = String(index);
      label.append(input, optionLabel(o));
      set.append(label);
    });
    form.append(set);
  });
  const submit = el("button", "submit", "Submit");
  submit.type = "submit";
  const ready = () => multi || card.questions.every((_, n) => form.querySelector(`input[name="q${n}"]:checked`));
  submit.disabled = !ready();
  form.addEventListener("change", () => { submit.disabled = !ready(); });
  form.addEventListener("submit", e => {
    e.preventDefault();
    const indices = multi
      ? [...form.querySelectorAll('input[name="q0"]:checked')].map(i => Number(i.value))
      : card.questions.map((_, n) => Number(form.querySelector(`input[name="q${n}"]:checked`).value));
    if (indices.length) answer(card, { kind: "options", indices });
  });
  form.append(submit);
  return form;
}

function renderCard(card) {
  const box = $(".card");
  box.replaceChildren();
  box.hidden = !card;
  if (!card) return;
  if (card.kind === "permission") box.append(permissionCard(card));
  else if (card.kind === "confirm") box.append(confirmCard(card));
  else if (card.questions.length === 1 && !card.questions[0].multiSelect) box.append(singleQuestion(card, card.questions[0]));
  else box.append(choiceQuestions(card));
  if (state.answered.has(card.id)) for (const b of box.querySelectorAll("button, input")) b.disabled = true;
}

function renderComposer() {
  const row = openRow();
  const card = state.cards.get(state.openId) ?? null;
  renderCard(card);
  const reason = card
    ? "Answer the prompt above first."
    : !row?.live
      ? (row?.canResume ? "This session isn't running. Start it to carry on." : "This session isn't running in the app.")
      : !row.canType
        ? "Answer the prompt in the app first."
        : "";
  const canResume = !card && !row?.live && !!row?.canResume;
  $(".resume").hidden = !canResume;
  $(".resume").disabled = state.resuming === state.openId;
  $(".resume").textContent = state.resuming === state.openId ? "Starting…" : "Start this session";
  const input = $(".prompt-input");
  input.disabled = !!reason;
  $(".send").disabled = !!reason;
  $(".prompt-reason").textContent = reason;
  $(".prompt-reason").hidden = !reason;
}

$(".prompt-form").addEventListener("submit", e => {
  e.preventDefault();
  const input = $(".prompt-input");
  const text = input.value.trim();
  if (!text || !state.openId) return;
  if (!connection.send({ type: "sendPrompt", sessionId: state.openId, text })) {
    toast(NOT_CONNECTED);
    return;
  }
  input.value = "";
  fitInput();
  noteActivity();
  const ghosts = state.ghosts.get(state.openId) ?? [];
  ghosts.push({ text, after: newestIndex(state.entries), sentAt: Date.now() });
  state.ghosts.set(state.openId, ghosts);
  renderChat();
});

$(".back").addEventListener("click", closeSession);

/** The box grows with what's typed, up to its CSS max-height, then scrolls. */
function fitInput() {
  const input = $(".prompt-input");
  // Hidden, it has no height to measure: leave it to its rows until it shows.
  if (!input.offsetParent) {
    input.style.height = "";
    return;
  }
  input.style.height = "auto";
  const border = input.offsetHeight - input.clientHeight;
  input.style.height = `${input.scrollHeight + border}px`;
  renderJumps();
}

$(".prompt-input").addEventListener("input", () => {
  fitInput();
  noteActivity();
});

// ---- How long since Claude's last reply ---------------------------------------

/** Shown once neither a reply nor your typing has happened for this long. */
const QUIET_MS = 10_000;

function ago(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 1) return "just now";
  if (s === 1) return "1 second ago";
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? "1 minute ago" : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  return h === 1 ? "over an hour ago" : `over ${h} hours ago`;
}

function renderSince() {
  const since = $(".since");
  const now = Date.now();
  const show = !!state.openId && state.lastResponseAt !== null
    && now - state.lastActiveAt >= QUIET_MS && now - state.lastResponseAt >= QUIET_MS;
  since.hidden = !show;
  if (show) since.textContent = `Last response from Claude ${ago(now - state.lastResponseAt)}`;
}

function noteActivity() {
  state.lastActiveAt = Date.now();
  renderSince();
}

/** Claude's latest reply, to tell a new one from a refresh, or from the window moving on. */
const replyKey = entries => {
  const turn = entries.at(-1);
  return turn ? `${turn.index}:${turn.items.length}:${JSON.stringify(turn.items.at(-1) ?? null)}` : "";
};

/** A conversation for the open session: a changed reply restarts the clock. */
function noteConversation(entries, mtimeMs) {
  const key = replyKey(entries);
  if (key === state.responseKey) return;
  const now = Date.now();
  const first = state.responseKey === null;
  state.responseKey = key;
  // The first one is what was there already: dated by the transcript's last write.
  state.lastResponseAt = first && typeof mtimeMs === "number" ? Math.min(now, mtimeMs) : now;
  if (!first) state.lastActiveAt = now;
  renderSince();
}

/** Each pending prompt's note counts up from when it was sent. */
function renderGhostNotes() {
  const now = Date.now();
  for (const note of document.querySelectorAll(".ghost-note")) {
    note.textContent = `Sent ${ago(now - Number(note.dataset.sentAt))}, waiting for Claude`;
  }
}

setInterval(() => {
  renderSince();
  renderGhostNotes();
}, 1000);

// ---- Text size -----------------------------------------------------------------

const SIZE_KEY = "cmx-companion-text-size";
const SIZES = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3];

function setTextSize(size, save = true) {
  state.textSize = size;
  document.documentElement.style.fontSize = `${16 * size}px`;
  $(".size-value").textContent = `${Math.round(size * 100)}%`;
  $(".size-down").disabled = size <= SIZES[0];
  $(".size-up").disabled = size >= SIZES.at(-1);
  if (save) try { localStorage.setItem(SIZE_KEY, String(size)); } catch { /* private mode */ }
  fitInput();
}

const stepSize = by => {
  const i = SIZES.indexOf(state.textSize);
  setTextSize(SIZES[Math.max(0, Math.min(SIZES.length - 1, (i < 0 ? SIZES.indexOf(1) : i) + by))]);
};
$(".size-down").addEventListener("click", () => stepSize(-1));
$(".size-up").addEventListener("click", () => stepSize(1));

$(".resume").addEventListener("click", () => {
  if (!connection.send({ type: "resumeSession", sessionId: state.openId })) {
    toast(NOT_CONNECTED);
    return;
  }
  state.resuming = state.openId;
  renderComposer();
});

// ---- Keep screen on ----------------------------------------------------------

const WAKE_KEY = "cmx-companion-keep-awake";
let wakeLock = null;

/** Holds the screen on while the page shows; the browser lets go whenever it's hidden. */
async function applyWakeLock() {
  if (!state.keepAwake) {
    const lock = wakeLock;
    wakeLock = null;
    await lock?.release().catch(() => {});
    return;
  }
  if (wakeLock || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    setKeepAwake(false);
    toast("This browser won't keep the screen on");
  }
}

function setKeepAwake(on) {
  state.keepAwake = on;
  try { localStorage.setItem(WAKE_KEY, on ? "1" : "0"); } catch { /* private mode */ }
  $(".menu-wake").setAttribute("aria-checked", String(on));
  applyWakeLock();
}

$(".menu-wake").hidden = !("wakeLock" in navigator);
$(".menu-wake").addEventListener("click", () => {
  setMenu(false);
  setKeepAwake(!state.keepAwake);
});
document.addEventListener("visibilitychange", () => { applyWakeLock(); });

// ---- Buzz when a session needs you -------------------------------------------------

const BUZZ_KEY = "cmx-companion-buzz";
const BUZZ_PATTERN = [200, 100, 200];
/** One buzz for several sessions needing you at once. */
const BUZZ_GAP_MS = 2000;

/** Waiting on you: Claude asking (a card, or Attention), or done with its turn. */
const needsYou = s => Boolean(s.pending) || s.state === "attention" || s.state === "waiting";
/** The sessions that needed you at the last list; null until the first, which never buzzes. */
let needing = null;
let lastBuzz = 0;

/** Buzzes when a session starts needing you, not for one that already did. Browsers only let a
 *  page vibrate while it's on screen, and iPhones not at all. */
function noteNeeds(sessions) {
  const now = new Set(sessions.filter(needsYou).map(s => s.id));
  const fresh = needing !== null && [...now].some(id => !needing.has(id));
  needing = now;
  if (fresh) buzz();
}

function buzz() {
  if (!state.buzz || !("vibrate" in navigator) || document.visibilityState !== "visible") return;
  const t = Date.now();
  if (t - lastBuzz < BUZZ_GAP_MS) return;
  lastBuzz = t;
  try { navigator.vibrate(BUZZ_PATTERN); } catch { /* not allowed yet */ }
}

function setBuzz(on, save = true) {
  state.buzz = on;
  if (save) try { localStorage.setItem(BUZZ_KEY, on ? "1" : "0"); } catch { /* private mode */ }
  $(".menu-buzz").setAttribute("aria-checked", String(on));
}

$(".menu-buzz").hidden = !("vibrate" in navigator);
$(".menu-buzz").addEventListener("click", () => {
  setMenu(false);
  setBuzz(!state.buzz);
});

/** An error just after sending is the app refusing that prompt: take its ghost back off. */
function dropRefusedGhost() {
  const ghosts = state.ghosts.get(state.openId);
  const last = ghosts?.at(-1);
  if (!last || Date.now() - last.sentAt > 5000) return;
  ghosts.pop();
  if (!ghosts.length) state.ghosts.delete(state.openId);
  $(".prompt-input").value ||= last.text;
  fitInput();
  renderChat();
}

// ---- Today's spend ---------------------------------------------------------------

/** "42% of $12.40 today": today's spend against today's budget share, or nothing without one. */
function renderUsage(u) {
  const box = $(".usage");
  const ok = u && Number.isFinite(u.percent) && Number.isFinite(u.dailyUsd);
  box.hidden = !ok;
  if (!ok) return;
  box.textContent = `${Math.round(u.percent)}% of $${u.dailyUsd.toFixed(2)} today`;
  box.dataset.level = ["warn", "alert"].includes(u.level) ? u.level : "ok";
  box.title = "Today's spend, as a share of today's budget";
}

// ---- Messages from the app --------------------------------------------------

function onMessage(m) {
  switch (m.type) {
    case "sessions":
      state.sessions = Array.isArray(m.sessions) ? m.sessions : [];
      noteNeeds(state.sessions);
      if (state.resuming && state.sessions.find(s => s.id === state.resuming)?.live) state.resuming = null;
      renderList();
      if (state.openId) {
        const row = openRow();
        if (row) $(".title").textContent = row.name;
        renderComposer();
      }
      break;
    case "conversation":
      if (!Array.isArray(m.entries)) break;
      settleGhosts(m.sessionId, numbered(m.entries));
      if (m.sessionId !== state.openId) break;
      noteConversation(numbered(m.entries), m.mtimeMs);
      takeLiveWindow(m.entries, m.hasEarlier);
      renderChat();
      break;
    case "earlier":
      takeEarlier(m);
      break;
    case "prompt":
      if (m.card) state.cards.set(m.sessionId, m.card);
      else state.cards.delete(m.sessionId);
      if (m.sessionId === state.openId) renderComposer();
      break;
    case "welcome":
      if (desktopTooOld(m.appVersion)) {
        const has = typeof m.appVersion === "string" && m.appVersion ? `version ${m.appVersion}` : "an older version";
        $(".outdated-text").textContent = `This page needs claude-multiplex ${MIN_DESKTOP_VERSION} or later, and the app on your computer is ${has}. Update the app, then pair again from its phone button (📱).`;
        connection.disconnect("outdated");
      }
      break;
    case "usage":
      renderUsage(m.usage);
      break;
    case "error":
      dropRefusedGhost();
      state.resuming = null;
      toast(String(m.message ?? "Something went wrong"));
      if (state.openId) renderComposer();
      break;
  }
}

// ---- Connection details ----------------------------------------------------

const LOG_LIMIT = 300;
const logLines = [];
const started = Date.now();

function logLine(text) {
  const t = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
  logLines.push(`${t}s  ${text}`);
  if (logLines.length > LOG_LIMIT) logLines.shift();
  $(".diagnostics-log").textContent = logLines.join("\n");
}

function renderMenu() {
  $(".menu-sessions").hidden = state.status !== "connected";
  $(".menu-disconnect").hidden = state.status === "ended" || state.status === "unpaired";
}

function setMenu(open) {
  $(".menu").hidden = !open;
  $(".menu-button").setAttribute("aria-expanded", String(open));
}

$(".menu-button").addEventListener("click", e => {
  e.stopPropagation();
  setMenu($(".menu").hidden);
});
document.addEventListener("click", e => {
  if (!$(".menu").hidden && !e.target.closest(".menu")) setMenu(false);
});
$(".menu-sessions").addEventListener("click", () => {
  setMenu(false);
  if (state.openId) closeSession();
  else showScreen("list");
});
/** The log, over the page, scrolled to its newest line. */
function showDetails() {
  setMenu(false);
  $(".diagnostics").showModal();
  const log = $(".diagnostics-log");
  log.scrollTop = log.scrollHeight;
}

$(".menu-details").addEventListener("click", showDetails);
$(".trouble-details").addEventListener("click", showDetails);
$(".diagnostics-close").addEventListener("click", () => $(".diagnostics").close());
// A tap on the backdrop lands on the dialog itself, outside its content.
$(".diagnostics").addEventListener("click", e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

$(".menu-disconnect").addEventListener("click", () => {
  setMenu(false);
  connection.disconnect();
});

/** How long the disconnected page stays before it closes itself. */
const CLOSE_AFTER_S = 5;

/** Counts down, then closes the page; a browser that won't let it says so instead. */
function closeSoon() {
  const note = $(".left-closing");
  let left = CLOSE_AFTER_S;
  const tick = () => {
    if (left > 0) {
      note.textContent = `This page will close in ${left} second${left === 1 ? "" : "s"}.`;
      left -= 1;
      setTimeout(tick, 1000);
      return;
    }
    window.close();
    // Still here: the browser keeps pages it didn't open from a script.
    setTimeout(() => { note.textContent = "You can close this page now."; }, 500);
  };
  tick();
}

$(".diagnostics-copy").addEventListener("click", () => {
  const text = [navigator.userAgent, ...logLines].join("\n");
  navigator.clipboard?.writeText(text).then(() => toast("Copied"), () => toast("Couldn't copy; select the text instead"));
});

const connection = new Connection({
  onLog: logLine,
  onStatus(status) {
    const s = $(".status");
    s.textContent = STATUS_TEXT[status];
    s.dataset.status = status;
    state.status = status;
    renderMenu();
    if (status === "unpaired") showScreen("unpaired");
    if (status === "connected" || status === "ended") $(".trouble").hidden = true;
    if (status === "connected") {
      if (state.openId) connection.send({ type: "openSession", sessionId: state.openId });
      else showScreen("list");
    }
  },
  onMessage,
  onTrouble() { $(".trouble").hidden = false; },
  onEnded(reason) {
    state.openId = null;
    renderSince();
    renderUsage(null);
    if (reason === "left") {
      showScreen("left");
      closeSoon();
      return;
    }
    if (reason === "outdated") {
      // No welcome, so no version to name: the app predates the pairing check.
      if (!$(".outdated-text").textContent) {
        $(".outdated-text").textContent = `This page needs claude-multiplex ${MIN_DESKTOP_VERSION} or later, and the app on your computer is an older version. Update the app, then pair again from its phone button (📱).`;
      }
      showScreen("outdated");
      return;
    }
    $(".ended-text").textContent = ENDED_TEXT[reason] ?? ENDED_TEXT.disconnected;
    showScreen("ended");
  },
});

let savedWake = null;
try { savedWake = localStorage.getItem(WAKE_KEY); } catch { /* private mode */ }
if (savedWake === "1" && "wakeLock" in navigator) setKeepAwake(true);

let savedBuzz = null;
try { savedBuzz = localStorage.getItem(BUZZ_KEY); } catch { /* private mode */ }
setBuzz(savedBuzz !== "0", false);

let savedSize = null;
try { savedSize = Number(localStorage.getItem(SIZE_KEY)); } catch { /* private mode */ }
setTextSize(SIZES.includes(savedSize) ? savedSize : 1, false);

// ---- A newer version of this page -------------------------------------------------

/** How often to look for a newer deploy while the page is open. */
const UPDATE_CHECK_MS = 5 * 60_000;
/** Everything the page loads from its own site, fetched afresh before reloading. */
const PAGE_FILES = ["index.html", "app.js", "auth.js", "connection.js", "desktop-version.js", "format.js", "style.css", "version.js"];

/** The deployed version, read past the browser's cache; null if it can't be read. */
async function deployedVersion() {
  try {
    const res = await fetch("version.js", { cache: "no-store" });
    if (!res.ok) return null;
    return /version:\s*['"]([^'"]+)['"]/.exec(await res.text())?.[1] ?? null;
  } catch {
    return null;
  }
}

async function checkForUpdate() {
  const latest = await deployedVersion();
  const newer = !!latest && latest !== BUILD_INFO.version;
  $(".menu-update").hidden = !newer;
  if (newer) $(".menu-button").dataset.update = "1";
  else delete $(".menu-button").dataset.update;
}

$(".menu-update").addEventListener("click", async () => {
  setMenu(false);
  $(".menu-update").disabled = true;
  // GitHub Pages lets browsers keep files for a while: refresh them, or the reload is the old page.
  await Promise.all(PAGE_FILES.map(f => fetch(f, { cache: "reload" }).catch(() => {})));
  location.reload();
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
setInterval(checkForUpdate, UPDATE_CHECK_MS);
checkForUpdate();

$(".version").textContent = [BUILD_INFO.version, BUILD_INFO.date, `for claude-multiplex ${MIN_DESKTOP_VERSION}+`].filter(Boolean).join(" · ");
connection.start();

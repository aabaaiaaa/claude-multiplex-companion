import { Connection } from "./connection.js";
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
  replaced: "Pairing ended: another device paired with the app. To connect this phone again, scan the code in claude-multiplex.",
  disconnected: "Pairing ended in the app. To connect again, scan the code in claude-multiplex.",
  unavailable: "Pairing ended: the app isn't reachable, or it was closed. To connect again, scan the code in claude-multiplex.",
};

const state = {
  sessions: [],
  openId: null,
  cards: new Map(),
  answered: new Set(),
  status: "connecting",
  showDetails: false,
  /** Prompts sent but not yet in the transcript, per session: { text, seen, sentAt }. */
  ghosts: new Map(),
  /** The open session's last conversation, so ghosts can be redrawn without a new one. */
  entries: [],
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
  $(".title").textContent = openRow()?.name ?? "Session";
  $(".chat").replaceChildren(el("p", "loading", "Loading…"));
  showScreen("chat");
  renderComposer();
  connection.send({ type: "openSession", sessionId: id });
}

function closeSession() {
  state.openId = null;
  connection.send({ type: "closeSession" });
  showScreen("list");
}

const promptKey = text => text.replace(/\s+/g, " ").trim();
const promptCount = (entries, text) => entries.filter(t => t.prompt && promptKey(t.prompt) === promptKey(text)).length;

/** A ghost goes once the transcript holds one more copy of its prompt than when it was sent. */
function settleGhosts(sessionId, entries) {
  const ghosts = state.ghosts.get(sessionId);
  if (!ghosts) return;
  const used = new Map();
  const left = ghosts.filter(g => {
    const key = promptKey(g.text);
    const taken = used.get(key) ?? 0;
    if (promptCount(entries, g.text) - g.seen > taken) {
      used.set(key, taken + 1);
      return false;
    }
    return true;
  });
  if (left.length) state.ghosts.set(sessionId, left);
  else state.ghosts.delete(sessionId);
}

function renderChat(entries) {
  state.entries = entries;
  const chat = $(".chat");
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  chat.replaceChildren();
  const ghosts = state.ghosts.get(state.openId) ?? [];
  if (entries.length === 0 && ghosts.length === 0) chat.append(el("p", "loading", "Nothing in this conversation yet."));
  for (const turn of entries) {
    if (turn.prompt) chat.append(el("div", "you", turn.prompt));
    for (const item of turn.items) {
      if (item.kind === "text") chat.append(el("div", "claude", item.text));
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
  for (const g of ghosts) chat.append(el("div", "you ghost", g.text), el("span", "ghost-note", "Sent, waiting for Claude"));
  if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
}

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
  const ghosts = state.ghosts.get(state.openId) ?? [];
  const seen = promptCount(state.entries, text) + ghosts.filter(g => promptKey(g.text) === promptKey(text)).length;
  ghosts.push({ text, seen, sentAt: Date.now() });
  state.ghosts.set(state.openId, ghosts);
  renderChat(state.entries);
});

$(".back").addEventListener("click", closeSession);

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

/** An error just after sending is the app refusing that prompt: take its ghost back off. */
function dropRefusedGhost() {
  const ghosts = state.ghosts.get(state.openId);
  const last = ghosts?.at(-1);
  if (!last || Date.now() - last.sentAt > 5000) return;
  ghosts.pop();
  if (!ghosts.length) state.ghosts.delete(state.openId);
  $(".prompt-input").value ||= last.text;
  renderChat(state.entries);
}

// ---- Messages from the app --------------------------------------------------

function onMessage(m) {
  switch (m.type) {
    case "sessions":
      state.sessions = Array.isArray(m.sessions) ? m.sessions : [];
      if (state.resuming && state.sessions.find(s => s.id === state.resuming)?.live) state.resuming = null;
      renderList();
      if (state.openId) {
        const row = openRow();
        if (row) $(".title").textContent = row.name;
        renderComposer();
      }
      break;
    case "conversation":
      if (Array.isArray(m.entries)) settleGhosts(m.sessionId, m.entries);
      if (m.sessionId === state.openId && Array.isArray(m.entries)) renderChat(m.entries);
      break;
    case "prompt":
      if (m.card) state.cards.set(m.sessionId, m.card);
      else state.cards.delete(m.sessionId);
      if (m.sessionId === state.openId) renderComposer();
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

/** Shown until connected; after that only from the menu. */
function renderDiagnostics() {
  $(".diagnostics").hidden = state.status === "connected" && !state.showDetails;
  $(".menu-details").textContent = state.showDetails ? "Hide connection details" : "Connection details";
  $(".menu-sessions").hidden = state.status !== "connected";
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
$(".menu-details").addEventListener("click", () => {
  setMenu(false);
  state.showDetails = !state.showDetails;
  renderDiagnostics();
  if (state.showDetails) {
    $(".diagnostics").open = true;
    $(".diagnostics").scrollIntoView({ block: "start" });
  }
});

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
    renderDiagnostics();
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
    $(".ended-text").textContent = ENDED_TEXT[reason] ?? ENDED_TEXT.disconnected;
    state.openId = null;
    showScreen("ended");
  },
});

let savedWake = null;
try { savedWake = localStorage.getItem(WAKE_KEY); } catch { /* private mode */ }
if (savedWake === "1" && "wakeLock" in navigator) setKeepAwake(true);

$(".version").textContent = BUILD_INFO.date ? `${BUILD_INFO.version} · ${BUILD_INFO.date}` : BUILD_INFO.version;
connection.start();

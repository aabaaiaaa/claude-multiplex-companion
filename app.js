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

function renderChat(entries) {
  const chat = $(".chat");
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  chat.replaceChildren();
  if (entries.length === 0) chat.append(el("p", "loading", "Nothing in this conversation yet."));
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
  if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
}

// ---- Composer: the prompt card and the prompt box ---------------------------

function answer(card, choice) {
  state.answered.add(card.id);
  connection.send({ type: "answer", sessionId: state.openId, cardId: card.id, choice });
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
      ? "This session isn't running in the app."
      : !row.canType
        ? "Answer the prompt in the app first."
        : "";
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
  connection.send({ type: "sendPrompt", sessionId: state.openId, text });
  input.value = "";
});

$(".back").addEventListener("click", closeSession);

// ---- Messages from the app --------------------------------------------------

function onMessage(m) {
  switch (m.type) {
    case "sessions":
      state.sessions = Array.isArray(m.sessions) ? m.sessions : [];
      renderList();
      if (state.openId) {
        const row = openRow();
        if (row) $(".title").textContent = row.name;
        renderComposer();
      }
      break;
    case "conversation":
      if (m.sessionId === state.openId && Array.isArray(m.entries)) renderChat(m.entries);
      break;
    case "prompt":
      if (m.card) state.cards.set(m.sessionId, m.card);
      else state.cards.delete(m.sessionId);
      if (m.sessionId === state.openId) renderComposer();
      break;
    case "error":
      toast(String(m.message ?? "Something went wrong"));
      if (state.openId) renderComposer();
      break;
  }
}

const connection = new Connection({
  onStatus(status) {
    const s = $(".status");
    s.textContent = STATUS_TEXT[status];
    s.dataset.status = status;
    if (status === "unpaired") showScreen("unpaired");
    if (status === "connected") {
      if (state.openId) connection.send({ type: "openSession", sessionId: state.openId });
      else showScreen("list");
    }
  },
  onMessage,
  onEnded(reason) {
    $(".ended-text").textContent = ENDED_TEXT[reason] ?? ENDED_TEXT.disconnected;
    state.openId = null;
    showScreen("ended");
  },
});

$(".version").textContent = BUILD_INFO.date ? `${BUILD_INFO.version} · ${BUILD_INFO.date}` : BUILD_INFO.version;
connection.start();

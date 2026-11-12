// Claude's Markdown, the little of it the chat shows: ```blocks```, `code` and **bold**.
// Built as DOM nodes, never HTML, so nothing in a transcript can add markup to the page.

const FENCE = /```[^\n`]*\n([\s\S]*?)\n?```/g;
const CODE = /`([^`\n]+)`/g;
const BOLD = /\*\*(\S(?:[^*]*?\S)?)\*\*/g;

/** `text` split by `re`: plain runs go through `plain`, matches through `match`. */
function split(text, re, match, plain) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push(...plain(text.slice(at, m.index)));
    out.push(match(m[1]));
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(...plain(text.slice(at)));
  return out;
}

function element(tag, text, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.textContent = text;
  return e;
}

const code = text => split(text, CODE, t => element("code", t), t => [document.createTextNode(t)]);

/** Bold and code, where bold can hold code (`**the `x` file**`) but code never holds bold. */
function inline(text) {
  // Bold is found with each code span blanked out, so a `*` inside code is never a marker and
  // every match starts and ends outside code.
  const masked = text.replace(CODE, m => `\`${"x".repeat(m.length - 2)}\``);
  const out = [];
  let at = 0;
  for (const m of masked.matchAll(BOLD)) {
    if (m.index > at) out.push(...code(text.slice(at, m.index)));
    const strong = document.createElement("strong");
    strong.append(...code(text.slice(m.index + 2, m.index + m[0].length - 2)));
    out.push(strong);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(...code(text.slice(at)));
  return out;
}

/** The nodes that show `text` with its formatting applied. */
export function formatText(text) {
  return split(text, FENCE, t => {
    const pre = document.createElement("pre");
    pre.className = "code-block";
    pre.append(element("code", t));
    return pre;
  }, inline);
}

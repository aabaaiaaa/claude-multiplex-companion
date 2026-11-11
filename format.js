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

const bold = text => split(text, BOLD, t => element("strong", t), t => [document.createTextNode(t)]);
const inline = text => split(text, CODE, t => element("code", t), bold);

/** The nodes that show `text` with its formatting applied. */
export function formatText(text) {
  return split(text, FENCE, t => {
    const pre = document.createElement("pre");
    pre.className = "code-block";
    pre.append(element("code", t));
    return pre;
  }, inline);
}

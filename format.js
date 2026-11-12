// Claude's Markdown, the little of it the chat shows: ```blocks```, tables, `code` and **bold**.
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

/** A table's divider line, such as `|---|:---:|`, with a cell for each column. */
const DIVIDER = /^\s*\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;

/** A table line's cells: split on `|` not escaped as `\|`, without the outer pipes. Read by
 *  hand rather than with a lookbehind, which older iPhones can't parse at all. */
function cells(line) {
  const out = [];
  let cell = "";
  const s = line.trim();
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (s[i] === "|") {
      out.push(cell);
      cell = "";
    } else {
      cell += s[i];
    }
  }
  out.push(cell);
  // The pipes at either end open and close the row; they don't make empty cells.
  if (s.startsWith("|")) out.shift();
  if (s.endsWith("|") && !s.endsWith("\\|") && out.length > 0) out.pop();
  return out.map(c => c.trim());
}

/** A column's alignment from its divider cell: `:--` left, `--:` right, `:-:` centre. */
function alignment(divider) {
  const left = divider.startsWith(":");
  const right = divider.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : "";
}

/** A Markdown table: a header line, a divider, then its rows. Scrolls sideways on its own when
 *  wider than the screen, so the page never does. */
function table(lines) {
  const head = cells(lines[0]);
  const aligns = cells(lines[1]).map(alignment);
  const t = document.createElement("table");
  const row = (texts, tag) => {
    const tr = document.createElement("tr");
    head.forEach((_, i) => {
      const cell = document.createElement(tag);
      if (aligns[i]) cell.style.textAlign = aligns[i];
      cell.append(...inline(texts[i] ?? ""));
      tr.append(cell);
    });
    return tr;
  };
  const thead = document.createElement("thead");
  thead.append(row(head, "th"));
  const tbody = document.createElement("tbody");
  for (const line of lines.slice(2)) tbody.append(row(cells(line), "td"));
  t.append(thead, tbody);
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.append(t);
  return wrap;
}

/** Text outside code blocks: tables as tables, everything else as lines of bold and code. */
function blocks(text) {
  const lines = text.split("\n");
  const out = [];
  let plain = [];
  const flush = () => {
    if (plain.length) out.push(...inline(plain.join("\n")));
    plain = [];
  };
  for (let i = 0; i < lines.length; i++) {
    // A header line with pipes, then a divider with as many columns.
    if (lines[i].includes("|") && i + 1 < lines.length && DIVIDER.test(lines[i + 1])
      && cells(lines[i + 1]).length === cells(lines[i]).length) {
      let end = i + 2;
      while (end < lines.length && lines[end].includes("|") && lines[end].trim()) end++;
      // The line break before the table belongs to the table, not the text above it.
      if (plain.length && plain.at(-1) === "") plain.pop();
      flush();
      out.push(table(lines.slice(i, end)));
      i = end - 1;
      // Nor the one after it.
      if (lines[end] === "") i = end;
      continue;
    }
    plain.push(lines[i]);
  }
  flush();
  return out;
}

/** The nodes that show `text` with its formatting applied. */
export function formatText(text) {
  return split(text, FENCE, t => {
    const pre = document.createElement("pre");
    pre.className = "code-block";
    pre.append(element("code", t));
    return pre;
  }, blocks);
}

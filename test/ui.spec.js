import { test, expect } from "@playwright/test";
import { deskId, deskReceived, openDesk, openPhone, routePeerjs } from "./helpers.js";

test.beforeEach(async ({ context }) => { await routePeerjs(context); });

const LIVE = [
  { id: "session-1", name: "parser-work", state: "idle", live: true, canType: true, pending: false, canResume: false },
  { id: "session-2", name: "docs", state: "resumable", live: false, canType: false, pending: false, canResume: true },
];

async function paired(context, sessions) {
  const id = deskId();
  const desk = await openDesk(context, id);
  if (sessions) await desk.evaluate(s => { window.desk.sessions = s; }, sessions);
  const phone = await openPhone(context, id);
  await expect(phone.locator(".status")).toHaveText("Connected");
  await expect(phone.locator(".session-list li")).not.toHaveCount(0);
  return { desk, phone };
}

const lastOfType = async (desk, type) => (await deskReceived(desk)).filter(m => m.type === type).at(-1);

async function openFirst(phone, desk) {
  await phone.locator(".session-list li", { hasText: "parser-work" }).click();
  await expect(phone.locator(".screen-chat")).toBeVisible();
  await expect.poll(() => lastOfType(desk, "openSession")).toMatchObject({ sessionId: "session-1" });
}

const sendCard = (desk, card) => desk.evaluate(c => window.desk.send({ type: "prompt", sessionId: "session-1", card: c }), card);

test("lists the sessions with their state, and marks one waiting on you", async ({ context }) => {
  const { phone } = await paired(context);
  const rows = phone.locator(".session-list li");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("parser-work");
  await expect(rows.nth(0)).toContainText("waiting");
  await expect(rows.nth(0)).toHaveAttribute("data-pending", "1");
  await expect(rows.nth(1)).toContainText("docs");
  await expect(rows.nth(1)).toHaveAttribute("data-pending", "0");
});

test("shows a session's chat with each run of tool calls collapsed", async ({ context }) => {
  const { desk, phone } = await paired(context);
  await openFirst(phone, desk);
  await expect(phone.locator(".title")).toHaveText("parser-work");
  await expect(phone.locator(".chat .you").first()).toHaveText("Add a test for the parser");
  await expect(phone.locator(".chat .claude").first()).toHaveText("I'll look at the parser first.");
  const tools = phone.locator(".chat details.tools");
  await expect(tools.locator("summary")).toHaveText("2 tool calls");
  await expect(tools.locator("li").first()).toBeHidden();
  await tools.locator("summary").click();
  await expect(tools.locator("li")).toHaveText(["Read parser.ts", "Grep \"parse\""]);
});

test("goes back to the list and closes the session", async ({ context }) => {
  const { desk, phone } = await paired(context);
  await openFirst(phone, desk);
  await phone.locator(".back").click();
  await expect(phone.locator(".screen-list")).toBeVisible();
  await expect.poll(() => lastOfType(desk, "closeSession")).toBeDefined();
});

test("sends a typed prompt to the session", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  await phone.locator(".prompt-input").fill("Add a test for the parser");
  await phone.locator(".send").click();
  await expect.poll(() => lastOfType(desk, "sendPrompt")).toMatchObject({ sessionId: "session-1", text: "Add a test for the parser" });
  await expect(phone.locator(".prompt-input")).toHaveValue("");
});

test("can't send a prompt to a session that isn't running", async ({ context }) => {
  const { phone } = await paired(context, LIVE);
  await phone.locator(".session-list li", { hasText: "docs" }).click();
  await expect(phone.locator(".prompt-input")).toBeDisabled();
  await expect(phone.locator(".prompt-reason")).toContainText("isn't running");
});

test("answers a permission prompt, with the prompt box off until it's answered", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  await sendCard(desk, { id: "card-1", kind: "permission", toolName: "Bash", summary: "npm test",
    options: [{ label: "Yes" }, { label: "Yes, and don't ask again" }, { label: "No" }] });
  const card = phone.locator(".card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Bash");
  await expect(card.locator(".summary")).toHaveText("npm test");
  await expect(phone.locator(".prompt-input")).toBeDisabled();
  await expect(card.locator("button")).toHaveText(["Yes", "Yes, and don't ask again", "No"]);
  await card.locator("button", { hasText: "Yes, and don't ask again" }).click();
  await expect.poll(() => lastOfType(desk, "answer")).toMatchObject({ sessionId: "session-1", cardId: "card-1", choice: { kind: "option", index: 1 } });
  await sendCard(desk, null);
  await expect(card).toBeHidden();
  await expect(phone.locator(".prompt-input")).toBeEnabled();
});

const question = (multiSelect, extra = {}) => ({
  header: "Name", question: "Which name should the helper use?", multiSelect,
  options: [{ label: "parseLine", description: "Matches the other helpers" }, { label: "readLine" }, { label: "lineOf" }], ...extra,
});

test("answers a single-choice question with one tap, or with your own words", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  await sendCard(desk, { id: "card-2", kind: "question", questions: [question(false)] });
  const card = phone.locator(".card");
  await expect(card).toContainText("Which name should the helper use?");
  await expect(card).toContainText("Matches the other helpers");
  await card.locator("button.option", { hasText: "readLine" }).click();
  await expect.poll(() => lastOfType(desk, "answer")).toMatchObject({ cardId: "card-2", choice: { kind: "option", index: 1 } });

  await sendCard(desk, { id: "card-3", kind: "question", questions: [question(false)] });
  await card.locator(".other-input").fill("Call it parseRow");
  await card.locator(".other-send").click();
  await expect.poll(() => lastOfType(desk, "answer")).toMatchObject({ cardId: "card-3", choice: { kind: "text", text: "Call it parseRow" } });
});

test("answers a multi-select question with the ticked options", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  await sendCard(desk, { id: "card-4", kind: "question", questions: [question(true)] });
  const card = phone.locator(".card");
  await card.getByLabel("parseLine").check();
  await card.getByLabel("lineOf").check();
  await card.locator(".submit").click();
  await expect.poll(() => lastOfType(desk, "answer")).toMatchObject({ cardId: "card-4", choice: { kind: "options", indices: [0, 2] } });
});

test("answers several questions at once, one choice each", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  await sendCard(desk, { id: "card-5", kind: "question", questions: [
    question(false),
    { header: "Tests", question: "Add tests too?", multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] },
  ] });
  const card = phone.locator(".card");
  await expect(card.locator(".submit")).toBeDisabled();
  await card.locator("fieldset").nth(0).getByLabel("lineOf").check();
  await card.locator("fieldset").nth(1).getByLabel("No").check();
  await card.locator(".submit").click();
  await expect.poll(() => lastOfType(desk, "answer")).toMatchObject({ cardId: "card-5", choice: { kind: "options", indices: [2, 1] } });
});

test("keeps a prompt and an answer that couldn't be sent while reconnecting", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  await sendCard(desk, { id: "card-7", kind: "permission", toolName: "Bash", summary: "ls", options: [{ label: "Yes" }, { label: "No" }] });
  await expect(phone.locator(".card")).toBeVisible();
  await desk.evaluate(() => { window.desk.refuse = true; window.desk.closeConnection(); });
  await expect(phone.locator(".status")).toHaveText("Reconnecting…");
  await phone.locator(".card button", { hasText: "Yes" }).click();
  await expect(phone.locator(".toast")).toContainText("Not connected");
  await expect(phone.locator(".card button", { hasText: "Yes" })).toBeEnabled();
});

test("shows an error from the app", async ({ context }) => {
  const { desk, phone } = await paired(context);
  await desk.evaluate(() => window.desk.send({ type: "error", message: "That prompt was already answered" }));
  await expect(phone.locator(".toast")).toHaveText("That prompt was already answered");
});

test("fits a phone screen without sideways scrolling", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  await sendCard(desk, { id: "card-6", kind: "permission", toolName: "Bash", summary: "x".repeat(400), options: [{ label: "Yes" }, { label: "No" }] });
  await expect(phone.locator(".card")).toBeVisible();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

const conversation = (desk, prompts) => desk.evaluate(p => window.desk.send({ type: "conversation", sessionId: "session-1", mtimeMs: Date.now(),
  entries: p.map(prompt => ({ kind: "turn", prompt, items: [{ kind: "text", text: "Done." }] })) }), prompts);

test("shows a sent prompt as pending until the transcript has it", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  await conversation(desk, ["Run the tests"]);
  await expect(phone.locator(".chat .you:not(.ghost)")).toHaveCount(1);
  await phone.locator(".prompt-input").fill("Run the tests");
  await phone.locator(".send").click();
  const ghost = phone.locator(".chat .you.ghost");
  await expect(ghost).toHaveText("Run the tests");
  await expect(phone.locator(".ghost-note")).toHaveText(/^Sent (just now|\d+ seconds? ago), waiting for Claude$/);
  // A refresh without the new prompt keeps it pending, even though the same words are there from before.
  await conversation(desk, ["Run the tests"]);
  await expect(ghost).toHaveCount(1);
  await conversation(desk, ["Run the tests", "Run the tests"]);
  await expect(ghost).toHaveCount(0);
  await expect(phone.locator(".chat .you")).toHaveText(["Run the tests", "Run the tests"]);
});

test("takes a refused prompt off the chat and puts it back in the box", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  await phone.locator(".prompt-input").fill("Add a test");
  await phone.locator(".send").click();
  await expect(phone.locator(".chat .you.ghost")).toHaveText("Add a test");
  await desk.evaluate(() => window.desk.send({ type: "error", message: "That session can't take a prompt right now" }));
  await expect(phone.locator(".chat .you.ghost")).toHaveCount(0);
  await expect(phone.locator(".prompt-input")).toHaveValue("Add a test");
});

test("keeps the header and the prompt box on screen while the chat scrolls, with the version under the box", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  await conversation(desk, Array.from({ length: 40 }, (_, n) => `Prompt number ${n}`));
  await expect(phone.locator(".chat .you")).toHaveCount(40);
  await phone.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  const viewport = phone.viewportSize();
  const header = await phone.locator(".top").boundingBox();
  const footer = await phone.locator(".bottom").boundingBox();
  expect(header.y).toBe(0);
  expect(Math.round(footer.y + footer.height)).toBe(viewport.height);
  const box = await phone.locator(".prompt-form").boundingBox();
  const version = await phone.locator(".bottom .version").boundingBox();
  expect(version.y).toBeGreaterThan(box.y + box.height - 1);
});

test("goes back to the sessions from the menu", async ({ context }) => {
  const { desk, phone } = await paired(context);
  await openFirst(phone, desk);
  await phone.locator(".menu-button").click();
  await expect(phone.locator(".menu")).toBeVisible();
  await phone.locator(".menu-sessions").click();
  await expect(phone.locator(".menu")).toBeHidden();
  await expect(phone.locator(".screen-list")).toBeVisible();
  await expect.poll(() => lastOfType(desk, "closeSession")).toBeDefined();
});

test("closes the menu on a tap elsewhere", async ({ context }) => {
  const { phone } = await paired(context);
  await phone.locator(".menu-button").click();
  await expect(phone.locator(".menu")).toBeVisible();
  await phone.locator("main").click({ position: { x: 5, y: 5 } });
  await expect(phone.locator(".menu")).toBeHidden();
});

test("starts a session that isn't running, then lets you type into it", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await phone.locator(".session-list li", { hasText: "docs" }).click();
  const start = phone.locator(".resume");
  await expect(start).toHaveText("Start this session");
  await expect(phone.locator(".prompt-input")).toBeDisabled();
  await start.click();
  await expect.poll(() => lastOfType(desk, "resumeSession")).toMatchObject({ sessionId: "session-2" });
  await expect(start).toHaveText("Starting…");
  await expect(start).toBeDisabled();
  await desk.evaluate(rows => window.desk.send({ type: "sessions", sessions: rows }),
    [LIVE[0], { ...LIVE[1], state: "idle", live: true, canType: true, canResume: false }]);
  await expect(start).toBeHidden();
  await expect(phone.locator(".prompt-input")).toBeEnabled();
});

test("keeps the screen on from the menu, and remembers it", async ({ context }) => {
  await context.addInitScript(() => {
    window.wakeCalls = [];
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: {
      request: async type => {
        window.wakeCalls.push(type);
        const lock = new EventTarget();
        lock.release = async () => { window.wakeCalls.push("release"); lock.dispatchEvent(new Event("release")); };
        return lock;
      },
    } });
  });
  const { phone } = await paired(context);
  const toggle = phone.locator(".menu-wake");
  await phone.locator(".menu-button").click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect.poll(() => phone.evaluate(() => window.wakeCalls)).toEqual(["screen"]);
  await phone.reload();
  await expect.poll(() => phone.evaluate(() => window.wakeCalls)).toEqual(["screen"]);
  await phone.locator(".menu-button").click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect.poll(() => phone.evaluate(() => window.wakeCalls)).toEqual(["screen", "release"]);
});

test("disconnects from the menu, forgets the pairing, and closes itself", async ({ context }) => {
  await context.addInitScript(() => { window.close = () => { window.closeCalls = (window.closeCalls ?? 0) + 1; }; });
  const { desk, phone } = await paired(context);
  await phone.locator(".menu-button").click();
  await phone.locator(".menu-disconnect").click();
  await expect.poll(() => lastOfType(desk, "disconnect")).toBeDefined();
  await expect(phone.locator(".screen-left")).toBeVisible();
  await expect(phone.locator(".screen-left")).toContainText("scan the code");
  await expect(phone.locator(".left-closing")).toContainText(/close in \d seconds?/);
  await expect.poll(() => phone.evaluate(() => window.closeCalls), { timeout: 8000 }).toBe(1);
  await expect(phone.locator(".left-closing")).toHaveText("You can close this page now.");
  // Opened again without the code's link, it asks for a scan rather than looking for the app.
  await phone.goto("/index.html");
  await expect(phone.locator(".screen-unpaired")).toBeVisible();
});

test("shows Claude's bold, code and code blocks, and nothing else as markup", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  await desk.evaluate(text => window.desk.send({ type: "conversation", sessionId: "session-1", mtimeMs: Date.now(),
    entries: [{ kind: "turn", prompt: "Check it", items: [{ kind: "text", text }] }] }),
  "Run **npm test** then `git status`, not <b>this</b>.\n```sh\nnpm ci\nnpm test\n```\nDone.");
  const reply = phone.locator(".chat .claude").first();
  await expect(reply.locator("strong")).toHaveText("npm test");
  await expect(reply.locator(":scope > code")).toHaveText("git status");
  await expect(reply.locator("pre.code-block")).toHaveText("npm ci\nnpm test");
  await expect(reply).toContainText("not <b>this</b>.");
  await expect(reply.locator("b")).toHaveCount(0);
});

test("makes the text smaller or larger from the menu, and remembers it", async ({ context }) => {
  const { phone } = await paired(context);
  const fontSize = () => phone.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  await phone.locator(".menu-button").click();
  await phone.locator(".size-down").click();
  await phone.locator(".size-down").click();
  await expect(phone.locator(".menu")).toBeVisible();
  await expect(phone.locator(".size-value")).toHaveText("80%");
  expect(await fontSize()).toBe("12.8px");
  await phone.reload();
  await expect(phone.locator(".status")).toHaveText("Connected");
  expect(await fontSize()).toBe("12.8px");
  await phone.locator(".menu-button").click();
  for (let i = 0; i < 6; i++) await phone.locator(".size-down").click({ force: true });
  await expect(phone.locator(".size-value")).toHaveText("50%");
  await expect(phone.locator(".size-down")).toBeDisabled();
});

test("grows the prompt box as you type, up to a limit", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  const input = phone.locator(".prompt-input");
  const height = async () => (await input.boundingBox()).height;
  const start = await height();
  await input.fill(Array.from({ length: 6 }, (_, n) => `line ${n}`).join("\n"));
  const grown = await height();
  expect(grown).toBeGreaterThan(start * 1.5);
  await input.fill(Array.from({ length: 80 }, (_, n) => `line ${n}`).join("\n"));
  expect(await height()).toBeLessThanOrEqual(phone.viewportSize().height * 0.4 + 1);
  await phone.locator(".send").click();
  await expect.poll(height).toBeLessThan(start + 1);
});

test("says how long since Claude's last reply once things go quiet", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  await desk.evaluate(s => { window.desk.sessions = s; }, LIVE);
  const phone = await context.newPage();
  await phone.clock.install();
  await phone.goto(`/index.html#peer=${id}&server=localhost:9123`);
  await expect(phone.locator(".status")).toHaveText("Connected");
  await openFirst(phone, desk);
  const since = phone.locator(".since");
  const reply = text => desk.evaluate(t => window.desk.send({ type: "conversation", sessionId: "session-1", mtimeMs: Date.now(),
    entries: [{ kind: "turn", prompt: "Go", items: [{ kind: "text", text: t }] }] }), text);
  await reply("First.");
  await expect(phone.locator(".chat .claude")).toHaveText("First.");
  await expect(since).toBeHidden();
  await phone.clock.fastForward(11_000);
  await expect(since).toBeVisible();
  await expect(since).toContainText("Last response from Claude");
  await expect(since).toContainText("seconds ago");
  // Typing hides it, until 10 seconds pass without any.
  await phone.locator(".prompt-input").pressSequentially("Next");
  await expect(since).toBeHidden();
  await phone.clock.fastForward(5_000);
  await expect(since).toBeHidden();
  await phone.clock.fastForward(6_000);
  await expect(since).toBeVisible();
  // Sending hides it, and so does a new reply.
  await phone.locator(".send").click();
  await expect(since).toBeHidden();
  await phone.clock.fastForward(11_000);
  await expect(since).toBeVisible();
  await reply("Second.");
  await expect(since).toBeHidden();
});

test("clears a pending prompt stored differently, and any sent before one that's arrived", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  await conversation(desk, []);
  const long = "Can you make the box taller?\nIt should show more than three lines of text at once.";
  for (const text of [long, "First short one", "Second short one"]) {
    await phone.locator(".prompt-input").fill(text);
    await phone.locator(".send").click();
  }
  const ghost = phone.locator(".chat .you.ghost");
  await expect(ghost).toHaveCount(3);
  // The paste comes back with more around it: it still counts as arrived.
  await conversation(desk, [`[Pasted text]\n${long}\n[end]`]);
  await expect(ghost).toHaveCount(2);
  // The second never shows as sent, but the third does: both have arrived.
  await conversation(desk, [long, "First short one, as typed in the app", "Second short one"]);
  await expect(ghost).toHaveCount(0);
});

test("counts up how long ago a pending prompt was sent", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  await desk.evaluate(s => { window.desk.sessions = s; }, LIVE);
  const phone = await context.newPage();
  await phone.clock.install();
  await phone.goto(`/index.html#peer=${id}&server=localhost:9123`);
  await expect(phone.locator(".status")).toHaveText("Connected");
  await openFirst(phone, desk);
  await phone.locator(".prompt-input").fill("Run the tests");
  await phone.locator(".send").click();
  const note = phone.locator(".ghost-note");
  await expect(note).toHaveText("Sent just now, waiting for Claude");
  await phone.clock.fastForward(12_000);
  await expect(note).toHaveText(/^Sent 1[23] seconds ago, waiting for Claude$/);
  await phone.clock.fastForward(60_000);
  await expect(note).toHaveText("Sent 1 minute ago, waiting for Claude");
});

test("shows today's spend against today's budget in the middle of the top bar", async ({ context }) => {
  const { desk, phone } = await paired(context);
  const usage = phone.locator(".top .usage");
  await expect(usage).toBeHidden();
  await desk.evaluate(() => window.desk.send({ type: "usage", usage: { percent: 42, dailyUsd: 12.4, level: "ok" } }));
  await expect(usage).toHaveText("42% of $12.40 today");
  const bar = await phone.locator(".top").boundingBox();
  const box = await usage.boundingBox();
  expect(Math.abs(box.x + box.width / 2 - (bar.x + bar.width / 2))).toBeLessThan(4);
  await desk.evaluate(() => window.desk.send({ type: "usage", usage: { percent: 120, dailyUsd: 12.4, level: "alert" } }));
  await expect(usage).toHaveText("120% of $12.40 today");
  await expect(usage).toHaveAttribute("data-level", "alert");
  // No budget set in the app: nothing to show.
  await desk.evaluate(() => window.desk.send({ type: "usage", usage: null }));
  await expect(usage).toBeHidden();
});

test("offers a newer version from the menu, and loads it", async ({ context }) => {
  const { phone } = await paired(context);
  await phone.locator(".menu-button").click();
  await expect(phone.locator(".menu-update")).toBeHidden();
  await phone.locator(".menu-button").click();
  // A deploy lands: the next check, here on coming back to the page, sees it.
  const deployed = "abc1234";
  await phone.route(/\/version\.js/, route => route.fulfill({
    contentType: "application/javascript",
    body: `export const BUILD_INFO = { version: '${deployed}', date: '2026-11-11 10:00:00' };`,
  }));
  await phone.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(phone.locator(".menu-button")).toHaveAttribute("data-update", "1");
  await phone.locator(".menu-button").click();
  const update = phone.locator(".menu-update");
  await expect(update).toHaveText("New version available: tap to update");
  const reloaded = phone.waitForEvent("load");
  await update.click();
  await reloaded;
  // The new page is that version, and reconnects on its own.
  await expect(phone.locator(".version")).toContainText("abc1234");
  await expect(phone.locator(".status")).toHaveText("Connected");
  await expect(phone.locator(".menu-button")).not.toHaveAttribute("data-update", "1");
});

test("jumps up to Claude's last response, and down to the end", async ({ context }) => {
  const { desk, phone } = await paired(context, LIVE);
  await openFirst(phone, desk);
  const long = Array.from({ length: 80 }, (_, n) => `Line ${n} of the last response.`).join("\n");
  await desk.evaluate(last => window.desk.send({ type: "conversation", sessionId: "session-1", mtimeMs: Date.now(),
    entries: [
      ...Array.from({ length: 20 }, (_, n) => ({ kind: "turn", prompt: `Prompt ${n}`, items: [{ kind: "text", text: "Done." }] })),
      { kind: "turn", prompt: "Explain it", items: [{ kind: "text", text: last }] },
    ] }), long);
  const up = phone.locator(".jump-reply");
  const down = phone.locator(".jump-end");
  const replyTop = () => phone.locator(".chat .claude").last().evaluate(e => e.getBoundingClientRect().top);
  const headerBottom = () => phone.locator(".top").evaluate(e => e.getBoundingClientRect().bottom);

  // Up at the top, above the last response: only the way down shows.
  await phone.evaluate(() => window.scrollTo(0, 0));
  await expect(down).toBeVisible();
  await expect(up).toBeHidden();
  await down.click();
  await expect(down).toBeHidden();
  // At the end, the start of that long response is off the top: the way up shows.
  await expect(up).toBeVisible();
  const footer = await phone.locator(".bottom").boundingBox();
  const box = await up.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(footer.y);
  expect(box.x).toBeGreaterThan(phone.viewportSize().width / 2);
  await up.click();
  await expect.poll(async () => Math.abs((await replyTop()) - (await headerBottom()))).toBeLessThan(20);
  await expect(up).toBeHidden();
  await expect(down).toBeVisible();
});

import { test, expect } from "@playwright/test";
import { deskId, deskReceived, openDesk, openPhone, routePeerjs } from "./helpers.js";

test.beforeEach(async ({ context }) => { await routePeerjs(context); });

const LIVE = [
  { id: "session-1", name: "parser-work", state: "idle", live: true, canType: true, pending: false },
  { id: "session-2", name: "docs", state: "resumable", live: false, canType: false, pending: false },
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

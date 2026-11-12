import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { deskId, openDesk, openPhone, routePeerjs } from "./helpers.js";

test.beforeEach(async ({ context }) => { await routePeerjs(context); });

const fixture = JSON.parse(readFileSync("test/fixtures/image_refs.json", "utf8"));

const SESSIONS = [{
  id: "session-1", name: "parser-work", state: "idle", live: true, canType: true, pending: false,
  canResume: false, detail: "", status: "idle", awaiting: false, group: "Idle", groupKey: "idle",
}];

/** Pairs a phone with a desk whose welcome carries `features`, and opens the session. */
async function open(context, features) {
  const id = deskId();
  const desk = await openDesk(context, id);
  await desk.evaluate(([s, f]) => { window.desk.sessions = s; window.desk.features = f; }, [SESSIONS, features]);
  const phone = await openPhone(context, id);
  await expect(phone.locator(".status")).toHaveText("Connected");
  await phone.locator(".session-list li", { hasText: "parser-work" }).click();
  await expect(phone.locator(".screen-chat")).toBeVisible();
  return { desk, phone };
}

const WIN = "C:\\a b\\before.PNG";
const TEXT = `Look at \`shots/after.png\` and [the before shot](<${WIN}>), not \`notes.txt\`.`;

const show = (desk, prompt, text) => desk.evaluate(([p, t]) => window.desk.send({
  type: "conversation", sessionId: "session-1", mtimeMs: Date.now(),
  entries: [{ kind: "turn", index: 7, prompt: p, items: [{ kind: "text", text: t }] }],
}), [prompt, text]);

test("formatText finds the same references as the app, for every fixture case", async ({ page }) => {
  await page.goto("/index.html");
  const found = await page.evaluate(async cases => {
    const { formatText } = await import("/format.js");
    return cases.map(c => {
      const box = document.createElement("div");
      box.append(...formatText(c.text, { images: true }));
      return [...box.querySelectorAll("button.image-ref")].map(b => b.dataset.ref);
    });
  }, fixture.cases);
  fixture.cases.forEach((c, i) => expect(found[i], c.text).toEqual(c.refs));
});

test("formatText leaves the text exactly as it was without images", async ({ page }) => {
  await page.goto("/index.html");
  const html = await page.evaluate(async text => {
    const { formatText } = await import("/format.js");
    const html = images => {
      const box = document.createElement("div");
      box.append(...formatText(text, images));
      return box.innerHTML;
    };
    return { plain: html(), off: html({ images: false }), on: html({ images: true }) };
  }, TEXT);
  expect(html.plain).toBe(html.off);
  expect(html.off).not.toContain("<button");
  expect(html.off).toContain(`[the before shot](&lt;${WIN}&gt;)`);
  expect(html.on).toContain("<button");
});

test("shows references as buttons, marked with their turn, when the app allows images", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  await show(desk, "Show me `typed.png` and [this](x.png)", TEXT);
  const reply = phone.locator(".chat .claude");
  await expect(reply).toHaveAttribute("data-turn", "7");
  const refs = reply.locator("button.image-ref");
  await expect(refs).toHaveCount(2);
  await expect(refs.nth(0)).toHaveAttribute("data-ref", "shots/after.png");
  await expect(refs.nth(0).locator("code")).toHaveText("shots/after.png");
  await expect(refs.nth(1)).toHaveAttribute("data-ref", WIN);
  await expect(refs.nth(1)).toHaveText("the before shot");
  await expect(reply.locator("code", { hasText: "notes.txt" })).toHaveCount(1);
  // What the person typed gets none.
  await expect(phone.locator(".chat .you")).toHaveText("Show me `typed.png` and [this](x.png)");
  await expect(phone.locator(".chat .you button")).toHaveCount(0);
});

test("shows no buttons when the app doesn't allow images", async ({ context }) => {
  const { desk, phone } = await open(context, []);
  await show(desk, "Check", TEXT);
  const reply = phone.locator(".chat .claude");
  await expect(reply).toHaveAttribute("data-turn", "7");
  await expect(reply.locator("code")).toHaveCount(2);
  await expect(phone.locator(".image-ref")).toHaveCount(0);
});

test("a features message adds or removes the buttons in the open chat", async ({ context }) => {
  const { desk, phone } = await open(context, []);
  await show(desk, "Check", TEXT);
  await expect(phone.locator(".chat .claude")).toBeVisible();
  await expect(phone.locator(".image-ref")).toHaveCount(0);
  await desk.evaluate(() => window.desk.send({ type: "features", features: ["images"] }));
  await expect(phone.locator(".image-ref")).toHaveCount(2);
  await desk.evaluate(() => window.desk.send({ type: "features", features: [] }));
  await expect(phone.locator(".image-ref")).toHaveCount(0);
  await expect(phone.locator(".chat .claude code")).toHaveCount(2);
});

test("a fenced block never gets a button", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  await show(desk, "Check", "Here:\n```\n`inside.png` [a](b.png)\n```\nand `outside.png`");
  const reply = phone.locator(".chat .claude");
  await expect(reply.locator("button.image-ref")).toHaveText("outside.png");
  await expect(reply.locator(".code-block")).toHaveText("`inside.png` [a](b.png)");
});

import { test, expect } from "@playwright/test";
import { deskId, deskReceived, openDesk, openPhone, routePeerjs } from "./helpers.js";

test.beforeEach(async ({ context }) => { await routePeerjs(context); });

test("connects to the desktop and says hello", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  const phone = await openPhone(context, id);
  await expect(phone.locator(".status")).toHaveText("Connected");
  await expect.poll(async () => (await deskReceived(desk)).map(m => m.type)).toContain("hello");
  const hello = (await deskReceived(desk)).find(m => m.type === "hello");
  expect(hello).toMatchObject({ v: 1, type: "hello" });
  expect(typeof hello.clientId).toBe("string");
});

test("reconnects on its own after the connection drops", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  const phone = await openPhone(context, id);
  await expect(phone.locator(".status")).toHaveText("Connected");
  await desk.evaluate(() => window.desk.closeConnection());
  await expect.poll(() => desk.evaluate(() => window.desk.connections), { timeout: 30_000 }).toBe(2);
  await expect(phone.locator(".status")).toHaveText("Connected");
  const hellos = (await deskReceived(desk)).filter(m => m.type === "hello");
  expect(hellos).toHaveLength(2);
  expect(hellos[1].clientId).toBe(hellos[0].clientId);
  // And then it stays connected, rather than tearing its new connection down again.
  await phone.waitForTimeout(8000);
  expect(await desk.evaluate(() => window.desk.connections)).toBe(2);
  await expect(phone.locator(".status")).toHaveText("Connected");
});

test("receives a conversation far bigger than one data-channel message", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  const phone = await openPhone(context, id);
  await expect(phone.locator(".status")).toHaveText("Connected");
  await phone.locator(".session-list li").first().click();
  const long = "Sample text. ".repeat(4000);
  await desk.evaluate(text => window.desk.send({ type: "conversation", sessionId: "session-1", mtimeMs: 2,
    entries: [{ kind: "turn", prompt: "Tell me a lot", items: [{ kind: "text", text }] }] }), long);
  await expect(phone.locator(".chat .you")).toHaveText("Tell me a lot");
  expect(await phone.locator(".chat .claude").textContent()).toBe(long);
});

test("remembers the pairing when the page is reopened without the link", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  const phone = await openPhone(context, id);
  await expect(phone.locator(".status")).toHaveText("Connected");
  await phone.goto("/index.html");
  await expect(phone.locator(".status")).toHaveText("Connected");
  await expect.poll(() => desk.evaluate(() => window.desk.connections)).toBe(2);
});

test("ends the pairing when another device replaces it, and stops retrying", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  const phone = await openPhone(context, id);
  await expect(phone.locator(".status")).toHaveText("Connected");
  await desk.evaluate(() => window.desk.send({ type: "goodbye", reason: "replaced" }));
  await expect(phone.locator(".screen-ended")).toBeVisible();
  await expect(phone.locator(".ended-text")).toContainText("another device");
  await phone.waitForTimeout(3000);
  expect(await desk.evaluate(() => window.desk.connections)).toBe(1);
  await phone.goto("/index.html");
  await expect(phone.locator(".screen-unpaired")).toBeVisible();
});

test("ends the pairing when the app has gone", async ({ context }) => {
  const phone = await openPhone(context, deskId());
  await expect(phone.locator(".screen-ended")).toBeVisible({ timeout: 20_000 });
  await expect(phone.locator(".ended-text")).toContainText("scan the code");
});

test("logs each connection step under Connection details, ready to copy", async ({ context }) => {
  const id = deskId();
  await openDesk(context, id);
  const phone = await openPhone(context, id);
  await expect(phone.locator(".status")).toHaveText("Connected");
  await phone.locator(".diagnostics summary").click();
  const log = phone.locator(".diagnostics-log");
  await expect(log).toContainText("Pairing server: connected");
  await expect(log).toContainText("Direct connection: open");
  await expect(log).toContainText("ICE connection state: connected");
  await expect(log).toContainText("local candidate: host");
  await expect(log).toContainText("remote candidate received: host");
  await expect(phone.locator(".diagnostics-copy")).toBeVisible();
});

test("asks for a scan when it was never paired", async ({ page }) => {
  await page.goto("/index.html");
  await expect(page.locator(".screen-unpaired")).toBeVisible();
});

test("suggests mobile data or another Wi-Fi when the connection stalls, and hides it once connected", async ({ context }) => {
  const id = deskId();
  const stalled = await openDesk(context, id, { stall: true });
  const phone = await openPhone(context, id);
  await expect(phone.locator(".trouble")).toBeHidden();
  await expect(phone.locator(".trouble")).toBeVisible({ timeout: 30_000 });
  await expect(phone.locator(".trouble")).toContainText("mobile data");
  await expect(phone.locator(".trouble")).toContainText("different Wi-Fi");
  // The app comes back reachable: the phone's retry connects and the hint goes.
  await stalled.evaluate(() => window.desk.destroy());
  await stalled.close();
  await openDesk(context, id);
  await expect(phone.locator(".status")).toHaveText("Connected", { timeout: 30_000 });
  await expect(phone.locator(".trouble")).toBeHidden();
});

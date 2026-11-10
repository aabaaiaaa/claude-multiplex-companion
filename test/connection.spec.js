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

test("asks for a scan when it was never paired", async ({ page }) => {
  await page.goto("/index.html");
  await expect(page.locator(".screen-unpaired")).toBeVisible();
});

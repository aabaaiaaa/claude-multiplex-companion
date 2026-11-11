import { test, expect } from "@playwright/test";
import { deskId, deskReceived, openDesk, openPhone, routePeerjs, TEST_CODE } from "./helpers.js";

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

test("keeps only the key the app gave it once paired, never the code", async ({ context }) => {
  const id = deskId();
  await openDesk(context, id);
  const phone = await openPhone(context, id);
  await expect(phone.locator(".status")).toHaveText("Connected");
  expect(new URL(phone.url()).hash, "the code is out of the address bar").toBe("");
  const saved = await phone.evaluate(() => JSON.parse(localStorage.getItem("cmx-companion-pairing")));
  expect(saved.deviceKey).toMatch(/^[\w-]{43}$/);
  expect(saved.code).toBeUndefined();
  expect(JSON.stringify(saved)).not.toContain(TEST_CODE);
});

test("a code the app turns down ends with a request to scan a new one", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  const phone = await openPhone(context, id, "B".repeat(43));
  await expect(phone.locator(".screen-ended")).toBeVisible();
  await expect(phone.locator(".ended-text")).toContainText("turned this code down");
  await expect(phone.locator(".ended-text")).toContainText("Scan a new one");
  expect((await deskReceived(desk)).some(m => m.type === "hello"), "nothing is sent past the check").toBe(false);
});

test("stops, sending nothing, when the other end can't prove it's the app", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  await desk.evaluate(() => { window.desk.badProof = true; });
  const phone = await openPhone(context, id);
  await expect(phone.locator(".screen-ended")).toBeVisible();
  await expect(phone.locator(".ended-text")).toContainText("couldn't prove");
  expect((await deskReceived(desk)).map(m => m.type)).toEqual(["auth"]);
});

test("asks for an update when the app sends no pairing check", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  await desk.evaluate(() => { window.desk.noAuth = true; });
  const phone = await openPhone(context, id);
  await expect(phone.locator(".screen-outdated")).toBeVisible({ timeout: 15_000 });
  await expect(phone.locator(".outdated-text")).toContainText("an older version");
});

test("proves itself as the desktop app does, by the shared test vector", async ({ page }) => {
  await page.goto("/index.html");
  const result = await page.evaluate(async () => {
    const v = (await (await fetch("/test/fixtures/messages.json")).json()).authVector;
    const { proof } = await import("/auth.js");
    return { v, phone: await proof(v.secret, "phone", v.nonce, v.appFp, v.phoneFp), app: await proof(v.secret, "app", v.nonce, v.appFp, v.phoneFp) };
  });
  expect(result.phone).toBe(result.v.phoneProof);
  expect(result.app).toBe(result.v.appProof);
});

test("ends the pairing when this phone connects again elsewhere, and stops retrying", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  const phone = await openPhone(context, id);
  await expect(phone.locator(".status")).toHaveText("Connected");
  await desk.evaluate(() => window.desk.send({ type: "goodbye", reason: "replaced" }));
  await expect(phone.locator(".screen-ended")).toBeVisible();
  await expect(phone.locator(".ended-text")).toContainText("connected to the app again");
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

test("logs each connection step in Connection details, opened over the page from the menu", async ({ context }) => {
  const id = deskId();
  await openDesk(context, id);
  const phone = await openPhone(context, id);
  await expect(phone.locator(".status")).toHaveText("Connected");
  await expect(phone.locator(".diagnostics")).toBeHidden();
  await phone.locator(".menu-button").click();
  await phone.locator(".menu-details").click();
  await expect(phone.locator(".diagnostics")).toBeVisible();
  expect(await phone.locator(".diagnostics").evaluate(d => d.matches(":modal"))).toBe(true);
  const log = phone.locator(".diagnostics-log");
  await expect(log).toContainText("Pairing server: connected");
  await expect(log).toContainText("Direct connection: open");
  await expect(log).toContainText("ICE connection state: connected");
  await expect(log).toContainText("local candidate: host");
  await expect(log).toContainText("remote candidate received: host");
  await expect(phone.locator(".diagnostics-copy")).toBeVisible();
  await phone.locator(".diagnostics-close").click();
  await expect(phone.locator(".diagnostics")).toBeHidden();
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
  // The hint opens the details, to see where it's stuck.
  await phone.locator(".trouble-details").click();
  await expect(phone.locator(".diagnostics-log")).toContainText("No direct connection");
  await phone.locator(".diagnostics-close").click();
  // The app comes back reachable: the phone's retry connects and the hint goes.
  await stalled.evaluate(() => window.desk.destroy());
  await stalled.close();
  await openDesk(context, id);
  await expect(phone.locator(".status")).toHaveText("Connected", { timeout: 30_000 });
  await expect(phone.locator(".trouble")).toBeHidden();
});

for (const [appVersion, says] of [["0.24.3", "version 0.24.3"], [null, "an older version"]]) {
  test(`asks for an update and ends the pairing when the app is too old (${appVersion ?? "no version"})`, async ({ context }) => {
    const id = deskId();
    const desk = await openDesk(context, id);
    await desk.evaluate(v => { window.desk.appVersion = v; }, appVersion);
    const phone = await openPhone(context, id);
    await expect(phone.locator(".screen-outdated")).toBeVisible();
    const text = phone.locator(".outdated-text");
    await expect(text).toContainText("needs claude-multiplex 0.25.0 or later");
    await expect(text).toContainText(says);
    await expect(text).toContainText("Update the app");
    await expect.poll(async () => (await deskReceived(desk)).some(m => m.type === "disconnect")).toBe(true);
    await expect(phone.locator(".screen-list")).toBeHidden();
    // Forgotten, so the page waits for a new scan rather than trying the old app again.
    await phone.goto("/index.html");
    await expect(phone.locator(".screen-unpaired")).toBeVisible();
  });
}

test("works with an app at or past the minimum version", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  await desk.evaluate(() => { window.desk.appVersion = "0.31.2"; });
  const phone = await openPhone(context, id);
  await expect(phone.locator(".screen-list")).toBeVisible();
  await expect(phone.locator(".screen-outdated")).toBeHidden();
  await expect(phone.locator(".version")).toContainText("for claude-multiplex 0.25.0+");
});

test("compares versions part by part", async ({ page }) => {
  await page.goto("/index.html");
  const tooOld = (v, min) => page.evaluate(async ([v, min]) => (await import("/desktop-version.js")).desktopTooOld(v, min), [v, min]);
  expect(await tooOld("0.25.0", "0.25.0")).toBe(false);
  expect(await tooOld("0.25.1", "0.25.0")).toBe(false);
  expect(await tooOld("0.30.0", "0.25.0")).toBe(false);
  expect(await tooOld("1.0.0", "0.25.0")).toBe(false);
  expect(await tooOld("v0.25.0", "0.25.0")).toBe(false);
  expect(await tooOld("0.25.0-rc.1", "0.25.0")).toBe(false);
  expect(await tooOld("0.24.9", "0.25.0")).toBe(true);
  expect(await tooOld("0.9.0", "0.25.0")).toBe(true);
  expect(await tooOld("", "0.25.0")).toBe(true);
  expect(await tooOld(undefined, "0.25.0")).toBe(true);
  expect(await tooOld("dev", "0.25.0")).toBe(true);
});

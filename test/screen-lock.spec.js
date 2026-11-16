import { test, expect } from "@playwright/test";
import { deskId, deskReceived, openDesk, phoneLink, routePeerjs, watchCsp, cspViolations } from "./helpers.js";

test.beforeEach(async ({ context }) => {
  await routePeerjs(context);
  await watchCsp(context);
});
// The page runs under its Content Security Policy throughout, with nothing it needs refused.
test.afterEach(async ({ context }) => { expect(await cspViolations(context)).toEqual([]); });

/** The phone's screen lock, as Chromium's virtual authenticator: a platform one that checks the
 *  user. `verified(false)` makes it fail that check, as a cancelled or wrong PIN does. */
async function screenLock(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return {
    verified: isUserVerified => cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified }),
    count: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length,
  };
}

/** A desk whose screen lock setting is on, and a phone with a screen lock that has scanned its
 *  code: the app has let it past the key check, and waits for it to set the lock up. */
async function pairWithLock(context) {
  const id = deskId();
  const desk = await openDesk(context, id);
  await desk.evaluate(() => { window.desk.requireUV = true; });
  const phone = await context.newPage();
  const lock = await screenLock(phone);
  await phone.goto(phoneLink(id));
  await expect(phone.locator(".screen-enrol")).toBeVisible();
  return { desk, phone, lock };
}

const savedPairing = phone => phone.evaluate(() => JSON.parse(localStorage.getItem("cmx-companion-pairing")));
/** How each of the app's screen lock checks went: null for passed, else why not. */
const challenges = desk => desk.evaluate(() => window.desk.uvChecks);
const sentTypes = async desk => (await deskReceived(desk)).map(m => m.type);

async function setUp(desk, phone) {
  await phone.locator(".enrol-button").click();
  await expect(phone.locator(".status")).toHaveText("Connected");
  await expect(phone.locator(".screen-list")).toBeVisible();
  expect(await desk.evaluate(() => !!window.desk.uvCred)).toBe(true);
}

test("makes the screen-lock challenge as the desktop app does, by the shared test vector", async ({ page }) => {
  await page.goto("/index.html");
  const result = await page.evaluate(async () => {
    const v = (await (await fetch("/test/fixtures/messages.json")).json()).uvVector;
    const { uvChallenge } = await import("/screen-lock.js");
    return { v, challenge: await uvChallenge(v.nonce, v.appFp, v.phoneFp) };
  });
  expect(result.challenge).toBe(result.v.challenge);
});

test("sets the screen lock up as it pairs, before the app shows anything, then needs it to reconnect", async ({ context }) => {
  const { desk, phone, lock } = await pairWithLock(context);
  // Past the key check, but nothing from the app yet, and no way on without the screen lock.
  await expect(phone.locator(".status")).toHaveText("Locked");
  await expect(phone.locator(".screen-list")).toBeHidden();
  await phone.waitForTimeout(300);
  expect(await sentTypes(desk), "no hello before the screen lock").toEqual(["auth"]);
  expect(await desk.evaluate(() => window.desk.connections)).toBe(0);

  await setUp(desk, phone);
  expect(await sentTypes(desk)).toEqual(["auth", "enrol", "hello"]);
  expect(await lock.count()).toBe(1);
  const saved = await savedPairing(phone);
  expect(saved.credentialId).toMatch(/^[\w-]+$/);

  // The connection drops: the reconnect waits on Unlock, and the app is sent nothing until then.
  await desk.evaluate(() => window.desk.closeConnection());
  await expect(phone.locator(".screen-locked")).toBeVisible({ timeout: 30_000 });
  await expect(phone.locator(".status")).toHaveText("Locked");
  const auths = async () => (await deskReceived(desk)).filter(m => m.type === "auth");
  expect(await auths()).toHaveLength(1);
  await phone.locator(".unlock").click();
  await expect(phone.locator(".status")).toHaveText("Connected");
  await expect(phone.locator(".screen-list")).toBeVisible();
  const second = (await auths())[1];
  expect(second).toMatchObject({ kind: "device", webauthn: { credentialId: saved.credentialId } });
  expect(await challenges(desk)).toEqual([null]);
  await phone.locator(".menu-button").click();
  await phone.locator(".menu-details").click();
  await expect(phone.locator(".diagnostics-log")).toContainText("answered with this phone's key and screen lock");
});

test("asks for the lock again after the page is reopened, and keeps the session that was open", async ({ context }) => {
  const { desk, phone } = await pairWithLock(context);
  await setUp(desk, phone);
  await phone.locator(".session-list li").first().click();
  await expect(phone.locator(".screen-chat")).toBeVisible();
  await phone.goto("/index.html");
  await expect(phone.locator(".screen-locked")).toBeVisible();
  await phone.locator(".unlock").click();
  await expect(phone.locator(".status")).toHaveText("Connected");
  await expect.poll(() => desk.evaluate(() => window.desk.connections)).toBe(2);
});

test("stays on the setup while the screen lock isn't passed, sending nothing, and goes on once it is", async ({ context }) => {
  const { desk, phone, lock } = await pairWithLock(context);
  await lock.verified(false);
  await phone.locator(".enrol-button").click();
  await expect(phone.locator(".enrol-note")).toHaveText("Not set up. Tap Set up screen lock to try again.");
  await expect(phone.locator(".enrol-button")).toBeEnabled();
  expect(await sentTypes(desk)).toEqual(["auth"]);
  await lock.verified(true);
  await setUp(desk, phone);
});

test("stays on the setup when the app can't use what the phone made, and goes on once it can", async ({ context }) => {
  const { desk, phone } = await pairWithLock(context);
  // As a phone that skipped its lock: the app wants it checked.
  await phone.evaluate(() => {
    const real = navigator.credentials.create.bind(navigator.credentials);
    navigator.credentials.create = async options => {
      navigator.credentials.create = real;
      const cred = await real(options);
      const r = cred.response;
      const data = new Uint8Array(r.getAuthenticatorData());
      data[32] &= ~0x04;
      r.getAuthenticatorData = () => data.buffer;
      return cred;
    };
  });
  await phone.locator(".enrol-button").click();
  await expect(phone.locator(".enrol-note")).toContainText("The app couldn't use this phone's screen lock");
  await expect(phone.locator(".screen-enrol")).toBeVisible();
  await expect(phone.locator(".enrol-button")).toBeEnabled();
  expect((await savedPairing(phone)).credentialId).toBeUndefined();
  expect(await sentTypes(desk)).toEqual(["auth", "enrol"]);
  await setUp(desk, phone);
});

test("stays on Unlock while the screen lock isn't passed, sending nothing, and connects once it is", async ({ context }) => {
  const { desk, phone, lock } = await pairWithLock(context);
  await setUp(desk, phone);
  await desk.evaluate(() => window.desk.closeConnection());
  await expect(phone.locator(".screen-locked")).toBeVisible({ timeout: 30_000 });
  await lock.verified(false);
  await phone.locator(".unlock").click();
  await expect(phone.locator(".locked-note")).toHaveText("Not unlocked. Tap Unlock to try again.");
  await expect(phone.locator(".unlock")).toBeEnabled();
  expect((await deskReceived(desk)).filter(m => m.type === "auth")).toHaveLength(1);
  await lock.verified(true);
  await phone.locator(".unlock").click();
  await expect(phone.locator(".status")).toHaveText("Connected");
  expect(await challenges(desk)).toEqual([null]);
});

test("ends the pairing, asking for a new one, when the app turns the screen lock down", async ({ context }) => {
  const { desk, phone } = await pairWithLock(context);
  await setUp(desk, phone);
  // The app holds another key, so this phone's signature can't check out.
  await desk.evaluate(async () => {
    const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    window.desk.uvCred.key = other.publicKey;
    window.desk.closeConnection();
  });
  await expect(phone.locator(".screen-locked")).toBeVisible({ timeout: 30_000 });
  await phone.locator(".unlock").click();
  await expect(phone.locator(".screen-ended")).toBeVisible();
  await expect(phone.locator(".ended-text")).toContainText("its screen lock couldn't be checked");
  expect(await challenges(desk)).toEqual(["bad signature"]);
  expect(await phone.evaluate(() => localStorage.getItem("cmx-companion-pairing"))).toBeNull();
});

test("answers with its key alone, as before, for an app that doesn't ask for the screen lock", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  const phone = await context.newPage();
  await screenLock(phone);
  await phone.goto(phoneLink(id));
  await expect(phone.locator(".status")).toHaveText("Connected");
  await expect(phone.locator(".screen-enrol")).toBeHidden();
  await desk.evaluate(() => window.desk.closeConnection());
  await expect.poll(() => desk.evaluate(() => window.desk.connections), { timeout: 30_000 }).toBe(2);
  await expect(phone.locator(".status")).toHaveText("Connected");
  const sent = await deskReceived(desk);
  expect(sent.some(m => m.type === "enrol")).toBe(false);
  expect(sent.filter(m => m.type === "auth").map(m => m.webauthn)).toEqual([undefined, undefined]);
  expect((await savedPairing(phone)).credentialId).toBeUndefined();
});

test("sets the screen lock up on its next reconnect once the app turns the setting on", async ({ context }) => {
  const id = deskId();
  const desk = await openDesk(context, id);
  const phone = await context.newPage();
  await screenLock(phone);
  await phone.goto(phoneLink(id));
  await expect(phone.locator(".status")).toHaveText("Connected");
  // As the app does on turning the setting on: it closes a phone that didn't pass the lock.
  await desk.evaluate(() => { window.desk.requireUV = true; window.desk.closeConnection(); });
  await expect(phone.locator(".screen-enrol")).toBeVisible({ timeout: 30_000 });
  await expect(phone.locator(".screen-list")).toBeHidden();
  await setUp(desk, phone);
});

test("says so when this phone has no screen lock the page can use", async ({ context }) => {
  await context.addInitScript(() => {
    if (window.PublicKeyCredential) PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => false;
  });
  const id = deskId();
  const desk = await openDesk(context, id);
  await desk.evaluate(() => { window.desk.requireUV = true; });
  const phone = await context.newPage();
  await phone.goto(phoneLink(id));
  await expect(phone.locator(".screen-enrol")).toBeVisible();
  await expect(phone.locator(".enrol-no-lock")).toBeVisible();
  await expect(phone.locator(".enrol-button")).toBeHidden();
  expect(await sentTypes(desk)).toEqual(["auth"]);
});

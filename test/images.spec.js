import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { deskId, deskReceived, openDesk, openPhone, routePeerjs } from "./helpers.js";

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
      return {
        refs: [...box.querySelectorAll("button.image-ref")].map(b => b.dataset.ref),
        drawnAsCode: [...box.querySelectorAll("pre")].map(p => p.textContent).join(" "),
      };
    });
  }, fixture.cases);
  // A reference the app finds inside something the page draws as a code block (an indented fence)
  // can't be a button there, so it's the one thing allowed to be missing.
  fixture.cases.forEach((c, i) => {
    const expected = c.refs.filter(r => !found[i].drawnAsCode.includes(r));
    expect(found[i].refs, c.text).toEqual(expected);
  });
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

/**
 * Opens the viewer on a generated `w`×`h` PNG and waits for it to load; returns the stage's box.
 * The PNG is made in the page, so no file on disk is needed.
 */
async function viewImage(page, w = 400, h = 200) {
  await page.evaluate(async ([w, h]) => {
    const viewer = await import("/viewer.js");
    window.viewer = viewer;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext("2d");
    g.fillStyle = "#3a6"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#a36"; g.fillRect(0, 0, w / 2, h / 2);
    const blob = await new Promise(done => canvas.toBlob(done, "image/png"));
    viewer.openViewer("shot.png");
    viewer.viewerShow(blob);
  }, [w, h]);
  await expect(page.locator(".image-viewer .viewer-stage img")).toBeVisible();
  await page.waitForFunction(() => {
    const img = document.querySelector(".image-viewer img");
    return img.complete && img.naturalWidth > 0;
  });
  return page.locator(".viewer-stage").boundingBox();
}

/** The image's scale and translation, read back from its CSS transform. */
const transform = page => page.evaluate(() => {
  const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector(".image-viewer img")).transform);
  return { scale: m.a, x: m.e, y: m.f };
});

/** Dispatches a pointer event on the stage, as a touch at viewport point `x`,`y`. */
const pointer = (page, type, id, x, y) => page.evaluate(([type, id, x, y]) => {
  document.querySelector(".viewer-stage").dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true,
  }));
}, [type, id, x, y]);

async function tap(page, x, y) {
  await pointer(page, "pointerdown", 1, x, y);
  await pointer(page, "pointerup", 1, x, y);
}

/** Two fingers start `from` px either side of the stage's centre and spread to `to` px. */
async function pinch(page, box, from, to) {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await pointer(page, "pointerdown", 1, cx - from, cy);
  await pointer(page, "pointerdown", 2, cx + from, cy);
  for (let step = 1; step <= 4; step++) {
    const d = from + (to - from) * step / 4;
    await pointer(page, "pointermove", 1, cx - d, cy);
    await pointer(page, "pointermove", 2, cx + d, cy);
  }
  await pointer(page, "pointerup", 1, cx - to, cy);
  await pointer(page, "pointerup", 2, cx + to, cy);
}

/** The drawn picture's box on screen: the part of the fitted `<img>` the image itself fills. */
const picture = page => page.evaluate(() => {
  const img = document.querySelector(".image-viewer img");
  const box = img.getBoundingClientRect();
  const fit = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
  const w = img.naturalWidth * fit, h = img.naturalHeight * fit;
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h };
});

test("the viewer shows an image fitted inside the screen", async ({ page }) => {
  await page.goto("/index.html");
  await viewImage(page, 1600, 800);
  await expect(page.locator(".image-viewer .viewer-title")).toHaveText("shot.png");
  await expect(page.locator(".image-viewer .viewer-status")).toBeHidden();
  expect((await transform(page)).scale).toBe(1);
  const pic = await picture(page);
  const [vw, vh] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  expect(pic.left).toBeGreaterThanOrEqual(-0.5);
  expect(pic.top).toBeGreaterThanOrEqual(-0.5);
  expect(pic.left + pic.width).toBeLessThanOrEqual(vw + 0.5);
  expect(pic.top + pic.height).toBeLessThanOrEqual(vh + 0.5);
  // Fitted, so a wide image fills the width of a portrait screen.
  expect(pic.width).toBeCloseTo(vw, 0);
});

test("the viewer shows its loading progress, and an error with an action", async ({ page }) => {
  await page.goto("/index.html");
  await page.evaluate(async () => {
    window.viewer = await import("/viewer.js");
    window.viewer.openViewer("big.png");
  });
  const status = page.locator(".image-viewer .viewer-status");
  await expect(status).toHaveText("Loading…");
  await page.evaluate(() => window.viewer.viewerProgress(0.426));
  await expect(status).toHaveText("Loading… 43%");
  await page.evaluate(() => window.viewer.viewerError("The image is too big.", {
    label: "Open on the computer", disabledReason: "The computer is locked.", onPress() { window.pressed = true; },
  }));
  await expect(status).toHaveText("The image is too big.");
  const actions = page.locator(".image-viewer .viewer-actions");
  const action = actions.locator("button");
  await expect(action).toHaveText("Open on the computer");
  await expect(action).toBeDisabled();
  await expect(actions).toContainText("The computer is locked.");
  await page.evaluate(() => window.viewer.viewerError("Try again?", { label: "Retry", onPress() { window.pressed = true; } }));
  await expect(action).toBeEnabled();
  await expect(actions).not.toContainText("locked");
  await action.click();
  expect(await page.evaluate(() => window.pressed)).toBe(true);
  await page.evaluate(() => window.viewer.viewerError("Gone."));
  await expect(status).toHaveText("Gone.");
  await expect(actions.locator("button")).toHaveCount(0);
});

test("a double tap zooms to 2.5× at the tap, and another fits again", async ({ page }) => {
  await page.goto("/index.html");
  const box = await viewImage(page);
  const x = box.x + box.width * 0.75, y = box.y + box.height / 2;
  const before = await picture(page);
  // Where the tap lands within the picture, as a fraction of it.
  const fx = (x - before.left) / before.width;
  await tap(page, x, y);
  await tap(page, x, y);
  expect((await transform(page)).scale).toBeCloseTo(2.5, 5);
  const after = await picture(page);
  expect((x - after.left) / after.width).toBeCloseTo(fx, 2);
  await tap(page, x, y);
  await tap(page, x, y);
  expect(await transform(page)).toEqual({ scale: 1, x: 0, y: 0 });
});

test("two taps far apart, or too slow, aren't a double tap", async ({ page }) => {
  await page.goto("/index.html");
  const box = await viewImage(page);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await tap(page, cx - 100, cy);
  await tap(page, cx + 100, cy);
  expect((await transform(page)).scale).toBe(1);
  await page.waitForTimeout(350);
  await tap(page, cx + 100, cy);
  expect((await transform(page)).scale).toBe(1);
});

test("a pinch scales with the fingers, never past 8× or below fitted", async ({ page }) => {
  await page.goto("/index.html");
  const box = await viewImage(page);
  await pinch(page, box, 50, 100);
  expect((await transform(page)).scale).toBeCloseTo(2, 5);
  await pinch(page, box, 50, 2000);
  expect((await transform(page)).scale).toBe(8);
  await pinch(page, box, 150, 5);
  expect((await transform(page)).scale).toBe(1);
});

test("a drag at 2.5× moves the image but stops at its edge", async ({ page }) => {
  await page.goto("/index.html");
  const box = await viewImage(page);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await tap(page, cx, cy);
  await tap(page, cx, cy);
  const zoomed = await picture(page);
  await pointer(page, "pointerdown", 1, cx, cy);
  await pointer(page, "pointermove", 1, cx + 40, cy);
  await pointer(page, "pointerup", 1, cx + 40, cy);
  expect((await picture(page)).left).toBeCloseTo(zoomed.left + 40, 0);
  // Far to the right: the picture's left edge stops at the stage's left edge.
  await pointer(page, "pointerdown", 1, cx, cy);
  await pointer(page, "pointermove", 1, cx + 3000, cy + 3000);
  await pointer(page, "pointerup", 1, cx + 3000, cy + 3000);
  let pic = await picture(page);
  expect(pic.left).toBeCloseTo(box.x, 0);
  // Shorter than the stage at this zoom, it stays centred top to bottom.
  expect(pic.top + pic.height / 2).toBeCloseTo(box.y + box.height / 2, 0);
  // Far to the left: its right edge stops at the stage's right edge.
  await pointer(page, "pointerdown", 1, cx, cy);
  await pointer(page, "pointermove", 1, cx - 3000, cy);
  await pointer(page, "pointerup", 1, cx - 3000, cy);
  pic = await picture(page);
  expect(pic.left + pic.width).toBeCloseTo(box.x + box.width, 0);
});

/** A chat long enough to scroll, scrolled part way down; returns the phone. */
async function scrolledChat(context) {
  const { desk, phone } = await open(context, ["images"]);
  await show(desk, "Check", Array.from({ length: 120 }, (_, i) => `Line ${i} of the reply, see \`shot${i}.png\`.`).join("\n\n"));
  await expect(phone.locator(".chat .claude")).toBeVisible();
  await phone.evaluate(() => window.scrollTo(0, 600));
  await phone.waitForFunction(() => window.scrollY === 600);
  return phone;
}

test("zooming and dragging in the viewer never scroll or zoom the chat behind", async ({ context }) => {
  const phone = await scrolledChat(context);
  const box = await viewImage(phone);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  expect(await phone.evaluate(() => document.documentElement.style.overflow)).toBe("hidden");
  await pinch(phone, box, 50, 150);
  await pointer(phone, "pointerdown", 1, cx, cy);
  await pointer(phone, "pointermove", 1, cx - 200, cy - 400);
  await pointer(phone, "pointerup", 1, cx - 200, cy - 400);
  expect(await phone.evaluate(() => [window.scrollY, window.visualViewport.scale])).toEqual([600, 1]);
  await phone.locator(".viewer-close").click();
  await expect(phone.locator(".image-viewer")).toBeHidden();
  expect(await phone.evaluate(() => document.documentElement.style.overflow)).toBe("");
  expect(await phone.evaluate(() => [window.scrollY, window.visualViewport.scale])).toEqual([600, 1]);
});

test("✕ closes the viewer, frees the image and takes its back step away", async ({ context }) => {
  const phone = await scrolledChat(context);
  const startLength = await phone.evaluate(() => history.length);
  await viewImage(phone);
  const src = await phone.locator(".image-viewer img").getAttribute("src");
  expect(src).toMatch(/^blob:/);
  await phone.evaluate(() => { window.closes = 0; window.viewer.onViewerClose(() => window.closes++); });
  await phone.locator(".viewer-close").click();
  await expect(phone.locator(".image-viewer")).toBeHidden();
  expect(await phone.evaluate(() => window.closes)).toBe(1);
  expect(await phone.evaluate(u => fetch(u).then(() => "loaded", () => "revoked"), src)).toBe("revoked");
  // Back on the page's own entry, so the next back press isn't spent on the closed viewer.
  await phone.waitForFunction(() => !history.state?.viewer);
  expect(await phone.evaluate(() => history.length)).toBe(startLength + 1);
  // Opening at once after a close works the same, even before the step back has landed.
  await phone.evaluate(() => window.viewer.closeViewer());
  await viewImage(phone);
  await phone.locator(".viewer-close").click();
  await viewImage(phone);
  await phone.waitForFunction(() => history.state?.viewer === true);
  await phone.evaluate(() => history.back());
  await expect(phone.locator(".image-viewer")).toBeHidden();
  await phone.waitForFunction(() => !history.state?.viewer);
  await expect(phone.locator(".screen-chat")).toBeVisible();
  expect(await phone.evaluate(() => window.scrollY)).toBe(600);
});

test("the back button closes the viewer and stays on the chat", async ({ context }) => {
  const phone = await scrolledChat(context);
  const url = phone.url();
  await viewImage(phone);
  await phone.evaluate(() => { window.closes = 0; window.viewer.onViewerClose(() => window.closes++); });
  await phone.evaluate(() => history.back());
  await expect(phone.locator(".image-viewer")).toBeHidden();
  expect(phone.url()).toBe(url);
  await expect(phone.locator(".screen-chat")).toBeVisible();
  expect(await phone.evaluate(() => window.closes)).toBe(1);
  expect(await phone.evaluate(() => [window.scrollY, document.documentElement.style.overflow])).toEqual([600, ""]);
  // Nothing of the viewer's is left in the history to eat a later back press.
  expect(await phone.evaluate(() => history.state?.viewer)).toBeFalsy();
});

// ---- Asking the app for an image ------------------------------------------------------

/**
 * Gives the desk an image for `ref`: random bytes of `size` if given, else a small real PNG;
 * `extra` adds `stopAfter` or `skip`. Returns the bytes' SHA-256, to compare with what's shown.
 */
const giveImage = (desk, ref, { size, ...extra } = {}) => desk.evaluate(async ([ref, size, extra]) => {
  let bytes;
  if (size) {
    bytes = new Uint8Array(size);
    for (let at = 0; at < size; at += 65536) crypto.getRandomValues(bytes.subarray(at, at + 65536));
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = 40; canvas.height = 30;
    const g = canvas.getContext("2d");
    g.fillStyle = "#36a"; g.fillRect(0, 0, 40, 30);
    const blob = await new Promise(done => canvas.toBlob(done, "image/png"));
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  window.desk.images[ref] = { type: "image/png", bytes, ...extra };
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}, [ref, size, extra]);

const giveError = (desk, ref, error) => desk.evaluate(([ref, error]) => { window.desk.images[ref] = { error }; }, [ref, error]);

/** The SHA-256 of the image the viewer shows, once it shows one. */
async function shownHash(phone) {
  await expect(phone.locator(".image-viewer .viewer-stage img")).toBeVisible();
  return phone.evaluate(async () => {
    const bytes = await (await fetch(document.querySelector(".image-viewer img").src)).arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
  });
}

const requests = async desk => (await deskReceived(desk)).filter(m => m.type === "openImage");
const sentPrompts = async desk => (await deskReceived(desk)).filter(m => m.type === "sendPrompt");
const viewerStatus = phone => phone.locator(".image-viewer .viewer-status");
const viewerButton = phone => phone.locator(".image-viewer .viewer-actions button");
const AFTER = phone => phone.locator(".image-ref", { hasText: "shots/after.png" });
const BEFORE_WIN = phone => phone.locator(".image-ref", { hasText: "the before shot" });
/** Tells the phone something it shows, so once it shows, everything sent before has landed. */
const syncPoint = async (desk, phone) => {
  await desk.evaluate(() => window.desk.send({ type: "usage", usage: { percent: 10, dailyUsd: 1, level: "ok" } }));
  await expect(phone.locator(".usage")).toHaveText("10% of $1.00 today");
};

/** Taps a reference while the viewer is open over the chat, which a finger can't reach past. */
const tapUnder = locator => locator.dispatchEvent("click");

test("a tap asks the app for the image by its turn and reference, and shows it", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  const hash = await giveImage(desk, "shots/after.png");
  await show(desk, "Check", TEXT);
  await AFTER(phone).click();
  await expect(phone.locator(".image-viewer .viewer-title")).toHaveText("after.png");
  expect(await shownHash(phone)).toBe(hash);
  const [m] = await requests(desk);
  expect(m).toEqual({ v: 1, type: "openImage", id: expect.any(String), sessionId: "session-1", turn: 7, ref: "shots/after.png" });
});

test("a large image shows how much has arrived", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  const hash = await giveImage(desk, "shots/after.png", { size: 300_000, stopAfter: 3 });
  await show(desk, "Check", TEXT);
  await AFTER(phone).click();
  // Three of its five 64 KB pieces.
  await expect(viewerStatus(phone)).toHaveText("Loading… 66%");
  const [m] = await requests(desk);
  await desk.evaluate(id => window.desk.release(id), m.id);
  expect(await shownHash(phone)).toBe(hash);
});

test("an image the app won't send shows that it couldn't be loaded", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  await show(desk, "Check", TEXT);
  for (const error of ["refused", "not-image", "too-large"]) {
    await giveError(desk, "shots/after.png", error);
    await AFTER(phone).click();
    await expect(viewerStatus(phone), error).toHaveText("Couldn't load the image.");
    await expect(viewerButton(phone)).toHaveCount(0);
    await phone.locator(".viewer-close").click();
    await expect(phone.locator(".image-viewer")).toBeHidden();
  }
});

test("a name the app can't find offers to ask Claude for the full path, sending nothing until pressed", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  await giveError(desk, "before.png", "not-found");
  await show(desk, "Check", "From `before.png`.");
  await phone.locator(".prompt-input").fill("a draft");
  await phone.locator(".image-ref").click();
  await expect(phone.locator(".image-viewer .viewer-title")).toHaveText("before.png");
  await expect(viewerStatus(phone)).toHaveText("Couldn't find `before.png`.");
  await expect(viewerButton(phone)).toHaveText("Ask Claude for the full path");
  await expect(viewerButton(phone)).toBeEnabled();
  await syncPoint(desk, phone);
  expect(await sentPrompts(desk)).toEqual([]);
  await viewerButton(phone).click();
  await expect(phone.locator(".image-viewer")).toBeHidden();
  const ask = "What's the full path of `before.png`? Reply with just the full path, in backticks.";
  await expect.poll(() => sentPrompts(desk)).toEqual([{ v: 1, type: "sendPrompt", sessionId: "session-1", text: ask }]);
  // Shown faded until Claude has it, like a typed prompt; what's typed in the box stays.
  await expect(phone.locator(".chat .you.ghost")).toHaveText(ask);
  await expect(phone.locator(".prompt-input")).toHaveValue("a draft");
  // Already answered, so closing had nothing to cancel.
  expect(await desk.evaluate(() => window.desk.cancelled)).toEqual([]);
});

test("a name that matches more than one image says so, with the same button", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  await giveError(desk, "shots\\rel.jpeg", "ambiguous");
  await show(desk, "Check", "See `shots\\rel.jpeg`.");
  await phone.locator(".image-ref").click();
  await expect(phone.locator(".image-viewer .viewer-title")).toHaveText("rel.jpeg");
  await expect(viewerStatus(phone)).toHaveText("Found more than one `shots\\rel.jpeg`.");
  await expect(viewerButton(phone)).toHaveText("Ask Claude for the full path");
});

test("the ask button can't be pressed, and says why, while the session can't take a prompt", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  await giveError(desk, "before.png", "not-found");
  await show(desk, "Check", "From `before.png`.");
  await phone.locator(".image-ref").click();
  await expect(viewerButton(phone)).toBeEnabled();
  await desk.evaluate(s => window.desk.send({ type: "sessions", sessions: [{ ...s, canType: false }] }), SESSIONS[0]);
  await expect(viewerButton(phone)).toBeDisabled();
  await expect(phone.locator(".image-viewer .viewer-actions")).toContainText("Answer the prompt in the app first.");
  await desk.evaluate(s => window.desk.send({ type: "sessions", sessions: [s] }), SESSIONS[0]);
  await expect(viewerButton(phone)).toBeEnabled();
  await expect(phone.locator(".image-viewer .viewer-actions")).not.toContainText("Answer the prompt");
});

test("a full path that's gone says so, with no button", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  await giveError(desk, WIN, "not-found");
  await show(desk, "Check", TEXT);
  await BEFORE_WIN(phone).click();
  await expect(phone.locator(".image-viewer .viewer-title")).toHaveText("before.PNG");
  await expect(viewerStatus(phone)).toHaveText(`\`${WIN}\` isn't there any more.`);
  await expect(viewerButton(phone)).toHaveCount(0);
  // Rooted without a drive letter is a full path too.
  await phone.locator(".viewer-close").click();
  await giveError(desk, "/srv/shots/b.png", "not-found");
  await show(desk, "Check", "See `/srv/shots/b.png`.");
  await phone.locator(".image-ref").click();
  await expect(viewerStatus(phone)).toHaveText("`/srv/shots/b.png` isn't there any more.");
  await expect(viewerButton(phone)).toHaveCount(0);
});

test("a second tap cancels the first, whose late pieces are ignored", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  await giveImage(desk, "shots/after.png", { size: 300_000, stopAfter: 1 });
  const hash = await giveImage(desk, WIN);
  await show(desk, "Check", TEXT);
  await AFTER(phone).click();
  await expect(viewerStatus(phone)).toHaveText("Loading… 22%");
  await tapUnder(BEFORE_WIN(phone));
  await expect(phone.locator(".image-viewer .viewer-title")).toHaveText("before.PNG");
  expect(await shownHash(phone)).toBe(hash);
  const [first, second] = await requests(desk);
  expect(second.ref).toBe(WIN);
  expect(second.id).not.toBe(first.id);
  expect(await desk.evaluate(() => window.desk.cancelled)).toEqual([first.id]);
  // The cancel reached the desk before the new request did.
  const order = (await deskReceived(desk)).filter(m => m.id).map(m => `${m.type}:${m.id}`);
  expect(order).toEqual([`openImage:${first.id}`, `cancelImage:${first.id}`, `openImage:${second.id}`]);
  // The first one's pieces that were still on their way.
  await desk.evaluate(id => window.desk.release(id), first.id);
  await syncPoint(desk, phone);
  await expect(viewerStatus(phone)).toBeHidden();
  expect(await shownHash(phone)).toBe(hash);
});

test("closing the viewer while loading cancels the request", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  await giveImage(desk, "shots/after.png", { size: 300_000, stopAfter: 1 });
  await show(desk, "Check", TEXT);
  await AFTER(phone).click();
  await expect(viewerStatus(phone)).toHaveText("Loading… 22%");
  await phone.locator(".viewer-close").click();
  await expect(phone.locator(".image-viewer")).toBeHidden();
  const [m] = await requests(desk);
  await expect.poll(() => desk.evaluate(() => window.desk.cancelled)).toEqual([m.id]);
  // Its late pieces open nothing.
  await desk.evaluate(id => window.desk.release(id), m.id);
  await syncPoint(desk, phone);
  await expect(phone.locator(".image-viewer")).toBeHidden();
});

test("a missing piece shows that it couldn't be loaded, and Try again asks afresh", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  const hash = await giveImage(desk, "shots/after.png", { size: 200_000, skip: 1 });
  await show(desk, "Check", TEXT);
  await AFTER(phone).click();
  await expect(viewerStatus(phone)).toHaveText("Couldn't load the image.");
  await expect(viewerButton(phone)).toHaveText("Try again");
  await desk.evaluate(() => { delete window.desk.images["shots/after.png"].skip; });
  await viewerButton(phone).click();
  expect(await shownHash(phone)).toBe(hash);
  const [first, second] = await requests(desk);
  expect(second).toEqual({ ...first, id: expect.any(String) });
  expect(second.id).not.toBe(first.id);
});

test("losing the connection mid-image offers Try again, which asks again once reconnected", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  const hash = await giveImage(desk, "shots/after.png", { size: 300_000, stopAfter: 1 });
  await show(desk, "Check", TEXT);
  await AFTER(phone).click();
  await expect(viewerStatus(phone)).toHaveText("Loading… 22%");
  await desk.evaluate(() => window.desk.closeConnection());
  await expect(viewerStatus(phone)).toHaveText("Couldn't load the image.");
  await expect(viewerButton(phone)).toHaveText("Try again");
  await expect(phone.locator(".status")).toHaveText("Connected");
  await desk.evaluate(() => { delete window.desk.images["shots/after.png"].stopAfter; });
  await viewerButton(phone).click();
  expect(await shownHash(phone)).toBe(hash);
  const sent = await requests(desk);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual({ ...sent[0], id: expect.any(String) });
});

test("the fixture's OneDrive-style path goes to the app and back unchanged", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  const { text, refs: [ref] } = fixture.cases.find(c => c.text.includes("OneDrive"));
  const hash = await giveImage(desk, ref);
  await show(desk, "Check", text);
  await phone.locator(".image-ref").click();
  await expect(phone.locator(".image-viewer .viewer-title")).toHaveText("é.png");
  expect(await shownHash(phone)).toBe(hash);
  expect((await requests(desk))[0].ref).toBe(ref);
});

test("pieces as typed arrays or ArrayBuffers make the same image", async ({ context }) => {
  const { desk, phone } = await open(context, ["images"]);
  // A reference the desk doesn't know, so it stays quiet and the test answers instead.
  await show(desk, "Check", "See `quiet.png`.");
  await phone.locator(".image-ref").click();
  await expect.poll(async () => (await requests(desk)).length).toBe(1);
  const [{ id }] = await requests(desk);
  const shown = await phone.evaluate(async id => {
    const { takeImageMessage } = await import("/images.js");
    const canvas = document.createElement("canvas");
    canvas.width = 20; canvas.height = 20;
    const bytes = new Uint8Array(await (await new Promise(done => canvas.toBlob(done, "image/png"))).arrayBuffer());
    const half = Math.floor(bytes.length / 2);
    takeImageMessage({ type: "image", id, sessionId: "session-1", ref: "quiet.png", mime: "image/png", size: bytes.length, pieces: 2 });
    // A view into the middle of a bigger buffer, then a bare ArrayBuffer.
    const padded = new Uint8Array(half + 8);
    padded.set(bytes.subarray(0, half), 4);
    takeImageMessage({ type: "imagePiece", id, index: 0, data: padded.subarray(4, 4 + half) });
    takeImageMessage({ type: "imagePiece", id, index: 1, data: bytes.slice(half).buffer });
    takeImageMessage({ type: "imageDone", id });
    const blob = await (await fetch(document.querySelector(".image-viewer img").src)).blob();
    const got = new Uint8Array(await blob.arrayBuffer());
    return { type: blob.type, same: got.length === bytes.length && got.every((b, i) => b === bytes[i]) };
  }, id);
  expect(shown).toEqual({ type: "image/png", same: true });
});

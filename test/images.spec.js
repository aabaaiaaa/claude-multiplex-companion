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

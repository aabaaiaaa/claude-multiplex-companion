import path from "node:path";

const PEERJS = path.resolve("node_modules/peerjs/dist/peerjs.min.js");

/** Serve the pinned PeerJS build locally, so tests need no internet. */
export async function routePeerjs(context) {
  await context.route(/unpkg\.com\/peerjs@1\.5\.5\/dist\/peerjs\.min\.js/, route =>
    route.fulfill({ path: PEERJS, contentType: "application/javascript" }));
}

let counter = 0;
export const deskId = () => `desk-${Date.now()}-${++counter}`;

/** The QR code's secret for a test desk, base64url like a real one; the same for every test. */
export const TEST_CODE = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";

/** The link a desk's QR code would hold. */
export const phoneLink = (id, code = TEST_CODE) => `/index.html#peer=${id}&server=localhost:9123&k=${code}`;

export async function openDesk(context, id, { stall = false } = {}) {
  const page = await context.newPage();
  await page.goto(`/test/fake-desktop.html?id=${id}&code=${TEST_CODE}${stall ? "&stall=1" : ""}`);
  await page.waitForFunction(() => window.deskReady === true);
  return page;
}

export async function openPhone(context, id, code) {
  const page = await context.newPage();
  await page.goto(phoneLink(id, code));
  return page;
}

export const deskReceived = desk => desk.evaluate(() => window.desk.received);

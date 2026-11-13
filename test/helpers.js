import path from "node:path";

const PEERJS = path.resolve("node_modules/peerjs/dist/peerjs.min.js");

export const PEERJS_URL = /unpkg\.com\/peerjs@1\.5\.5\/dist\/peerjs\.min\.js/;

/** Serve the pinned PeerJS build locally, so tests need no internet; with the CORS header unpkg
 *  sends, which the page's integrity check needs. */
export async function routePeerjs(context) {
  await context.route(PEERJS_URL, route => route.fulfill({
    path: PEERJS, contentType: "application/javascript", headers: { "Access-Control-Allow-Origin": "*" },
  }));
}

let counter = 0;
export const deskId = () => `desk-${Date.now()}-${++counter}`;

/** The QR code's secret for a test desk, base64url like a real one; the same for every test. */
export const TEST_CODE = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";

/** The test PeerJS server's URL, as the app's link names it; `phoneLink` encodes it. */
export const TEST_SERVER = "http://localhost:9123/";

/** The link a desk's QR code would hold: the pairing server and any `stun` relay servers, then the code. */
export const phoneLink = (id, code = TEST_CODE, { server = TEST_SERVER, stun = [] } = {}) =>
  `/index.html#peer=${id}&server=${encodeURIComponent(server)}${stun.map(s => `&stun=${encodeURIComponent(s)}`).join("")}&k=${code}`;

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

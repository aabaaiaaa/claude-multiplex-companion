import path from "node:path";

const PEERJS = path.resolve("node_modules/peerjs/dist/peerjs.min.js");

/** Serve the pinned PeerJS build locally, so tests need no internet. */
export async function routePeerjs(context) {
  await context.route(/unpkg\.com\/peerjs@1\.5\.5\/dist\/peerjs\.min\.js/, route =>
    route.fulfill({ path: PEERJS, contentType: "application/javascript" }));
}

let counter = 0;
export const deskId = () => `desk-${Date.now()}-${++counter}`;

export async function openDesk(context, id, { stall = false } = {}) {
  const page = await context.newPage();
  await page.goto(`/test/fake-desktop.html?id=${id}${stall ? "&stall=1" : ""}`);
  await page.waitForFunction(() => window.deskReady === true);
  return page;
}

export async function openPhone(context, id) {
  const page = await context.newPage();
  await page.goto(`/index.html#peer=${id}&server=localhost:9123`);
  return page;
}

export const deskReceived = desk => desk.evaluate(() => window.desk.received);

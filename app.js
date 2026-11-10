import { Connection } from "./connection.js";
import { BUILD_INFO } from "./version.js";

const $ = sel => document.querySelector(sel);

const STATUS_TEXT = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  ended: "Not connected",
  unpaired: "Not paired",
};

const ENDED_TEXT = {
  replaced: "Pairing ended: another device paired with the app. To connect this phone again, scan the code in claude-multiplex.",
  disconnected: "Pairing ended in the app. To connect again, scan the code in claude-multiplex.",
  unavailable: "Pairing ended: the app isn't reachable, or it was closed. To connect again, scan the code in claude-multiplex.",
};

function showScreen(name) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = !s.classList.contains(`screen-${name}`);
}

const connection = new Connection({
  onStatus(status) {
    const el = $(".status");
    el.textContent = STATUS_TEXT[status];
    el.dataset.status = status;
    if (status === "unpaired") showScreen("unpaired");
    if (status === "connected") showScreen("list");
  },
  onMessage() {},
  onEnded(reason) {
    $(".ended-text").textContent = ENDED_TEXT[reason] ?? ENDED_TEXT.disconnected;
    showScreen("ended");
  },
});

$(".version").textContent = BUILD_INFO.date ? `${BUILD_INFO.version} · ${BUILD_INFO.date}` : BUILD_INFO.version;
connection.start();

import { defineConfig, devices } from "@playwright/test";

const onWindows = process.platform === "win32";

export default defineConfig({
  testDir: "test",
  timeout: 45_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    ...devices["Pixel 7"],
    // The installed Edge on Windows, so nothing has to be downloaded there.
    ...(onWindows ? { channel: "msedge" } : {}),
    baseURL: "http://localhost:8123",
  },
  webServer: [
    { command: "npx http-server . -p 8123 -c-1 -s", url: "http://localhost:8123/index.html", reuseExistingServer: false },
    { command: "npx peerjs --port 9123 --path /", port: 9123, reuseExistingServer: false },
  ],
});

// Serves this folder over https, so a phone on the same network can open the page and the desktop
// app can be pointed at it for testing. Makes a fresh self-signed certificate on each run, for
// localhost and every address this computer has on its networks, since they can change.
//
//   npm run serve:https            # port 8123
//   PORT=8124 npm run serve:https

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 8123;
const certDir = join(root, ".local-https");
const DAYS = 7;

/** This computer's IPv4 addresses on its networks, with the network each is on. */
function addresses() {
  return Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? [])
      .filter(a => a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."))
      .map(a => ({ name, address: a.address })));
}

const found = addresses();
const now = new Date();
const pems = await selfsigned.generate([{ name: "commonName", value: "local test page" }], {
  keySize: 2048,
  notBeforeDate: now,
  notAfterDate: new Date(now.getTime() + DAYS * 24 * 60 * 60 * 1000),
  extensions: [{
    name: "subjectAltName",
    altNames: [
      { type: 2, value: "localhost" },
      { type: 7, ip: "127.0.0.1" },
      ...found.map(a => ({ type: 7, ip: a.address })),
    ],
  }],
});
mkdirSync(certDir, { recursive: true });
writeFileSync(join(certDir, "key.pem"), pems.private);
writeFileSync(join(certDir, "cert.pem"), pems.cert);

console.log("\nSet the app's Settings > Advanced > Device pairing page to one of these:");
console.log(`  https://localhost:${port}/   (a browser on this computer)`);
for (const a of found) console.log(`  https://${a.address}:${port}/   (${a.name})`);
console.log("\nA phone needs to be on the same network, and to accept the certificate warning once.");
console.log("Your firewall may ask to let Node.js accept connections. Ctrl+C stops the server.\n");

const server = join(root, "node_modules", "http-server", "bin", "http-server");
const child = spawn(process.execPath, [server, root, "-p", String(port), "-c-1", "-S",
  "-C", join(certDir, "cert.pem"), "-K", join(certDir, "key.pem")], { stdio: "inherit" });
child.on("exit", code => process.exit(code ?? 0));

# claude-multiplex companion

A phone page for claude-multiplex, a desktop app that runs several Claude Code sessions side
by side. Scan the QR code in the app's **Settings → Phone companion**, and this page connects
straight to the app. From the page you can:
- see your sessions;
- read each one's conversation, with tool calls folded into groups;
- type prompts, which show faded until Claude has them;
- answer Claude's permission prompts and questions;
- start a session that isn't running.

The menu (☰) goes back to the sessions, keeps the screen on while the page is open, and shows
the connection details.

It's a prototype: the connection is a direct, encrypted WebRTC link, but pairing has no other
security yet.

## How it connects

- **The QR code** holds this page's address plus the app's PeerJS id, after a `#`.
- **The page** connects to that id over a WebRTC data channel, through the PeerJS cloud server.
  STUN gets it through home routers and mobile data. There's no working relay, so a phone on
  the same Wi-Fi as the computer may not connect: after a stalled attempt the page suggests
  mobile data or another Wi-Fi network.
- **Connection details,** at the bottom of the page, log each step with a Copy button: states and
  the kinds of address each side offered, never the addresses.
- **While the app keeps the pairing open,** the page reconnects by itself after the phone locks
  or the browser goes to the background, with no new scan.
- **Disconnect in the app, or closing it,** ends the pairing.

See [PROTOCOL.md](PROTOCOL.md) for the messages.

## Developing

Plain HTML, CSS and JavaScript modules, with no build step. PeerJS comes from unpkg, pinned to an
exact version in `index.html`.

```sh
npm install
npm test          # Playwright, against a local PeerJS server and a scripted desktop peer
npm run serve     # serves the page at http://localhost:8123/
```

The tests use the installed Microsoft Edge on Windows, and Playwright's Chromium elsewhere (run
`npx playwright install chromium` once). They need no internet connection: the PeerJS script is
served from `node_modules`.

### Trying it against the desktop app

1. Run `npm run serve`.
2. Start the desktop app with `CMX_COMPANION_URL=http://localhost:8123/` set, so its QR code links
   here. It still uses the PeerJS cloud server.
3. In the app, open **Settings → Phone companion → Pair a phone**, and open the link it shows in
   a desktop browser, or scan it with a phone on the same network (using your machine's address
   instead of `localhost`).

## Deploying

`.github/workflows/deploy.yml` publishes the page to GitHub Pages on every push to `main`. It
writes `version.js` with the commit and date, and leaves the test files out of the site. In the
repository's **Settings → Pages**, set **Source** to **GitHub Actions**.

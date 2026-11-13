# claude-multiplex companion

A phone page for claude-multiplex, a desktop app that runs several Claude Code sessions side
by side. Scan the QR code from the phone button (📱) in the app's top bar, and this page connects
straight to the app. From the page you can:
- see your sessions;
- read each one's conversation, with tool calls folded into groups: the last hour of it, with
  earlier turns fetched as you scroll up, and dropped again once you're back at the end;
- type prompts, which show faded until Claude has them;
- answer Claude's permission prompts and questions;
- start a session that isn't running;
- tap an image Claude names to open it, when the app's image sharing setting is on.

The top bar shows today's spend as a share of today's budget. Arrows above the prompt box jump
to the start of Claude's last response and to the end of the chat.

The menu (☰) goes back to the sessions, keeps the screen on while the page is open, switches
off the buzz, sets the text size, shows the connection details, disconnects, and offers a newer version of this page
once one is deployed. Claude's `code`, code blocks, tables and
**bold** show formatted. The prompt box grows as you type. Once nothing has happened for 10
seconds, the chat says how long ago Claude last replied.

While the page is on screen, the phone buzzes when a session starts needing you: Claude has
finished its turn, or is asking something. Browsers don't let a page vibrate in the background,
and iPhones don't let it vibrate at all, so there the option isn't shown.

It's a beta, for trying out. The connection is a direct, encrypted WebRTC
link, and each connection proves both ends hold the pairing's secret before anything else, so
the PeerJS server that introduces them can't pose as either.

## How it connects

- **The QR code** holds this page's address plus, after a `#`, the app's PeerJS id, the pairing
  server and relay servers set in the app, and a one-time code. The page has no servers of its
  own. The app shows a new code every 30 seconds, and none works once a phone has paired.
- **The pairing check:** the page proves it has the code, or later the key the app gave it, and
  the app proves itself back, both bound to the connection (see [PROTOCOL.md](PROTOCOL.md)). A
  code that's expired or been used gets a request to scan a new one.
- **The page** connects to that id over a WebRTC data channel, through the pairing server the link
  names, which must be https://. The link's STUN servers get it through home routers and mobile
  data. There's no relay that passes the traffic on, so a phone on the same Wi-Fi as the computer
  may not connect: after a stalled attempt the page suggests mobile data or another Wi-Fi network.
- **Connection details,** from the menu or the hint after a stalled attempt, open over the page and
  log each step, with a Copy button: states and
  the kinds of address each side offered, never the addresses.
- **While the app keeps the pairing open,** the page reconnects by itself after the phone locks
  or the browser goes to the background, with no new scan.
- **Disconnect in the app, or closing it,** ends the pairing.
- **An app too old for this page** gets an update request instead: the page names the oldest
  version it works with (`desktop-version.js`) and ends the pairing.
- **Disconnect on the page** ends it too, and the page closes itself after 5 seconds. To connect
  again, scan a new code from the app: the page doesn't look for the app by itself.

See [PROTOCOL.md](PROTOCOL.md) for the messages.

## What stays on the phone

Nothing from the app is shown or kept while the page isn't connected: no sessions, conversation,
prompts, spend or images. While it reconnects, the page says so in place of the session it was
showing, then fetches everything again. What you'd typed in the prompt box is put back once that
session is open again, and dropped if it has gone; an ended pairing drops it. The page stores only
its settings (text size, keep screen on, buzz) and, until the pairing ends, the key that lets it
reconnect.

The PeerJS script from unpkg carries an `integrity` hash, so the browser won't run any other
bytes in its place.

## Developing

Plain HTML, CSS and JavaScript modules, with no build step. PeerJS comes from unpkg, pinned to an
exact version in `index.html`.

```sh
npm install
npm test          # Playwright, against a local PeerJS server and a scripted desktop peer
npm run serve         # serves the page at http://localhost:8123/
npm run serve:https   # serves it over https, for the desktop app and a phone (see below)
```

The tests use the installed Microsoft Edge on Windows, and Playwright's Chromium elsewhere (run
`npx playwright install chromium` once). They need no internet connection: the PeerJS script is
served from `node_modules`.

### Trying it against the desktop app

This is how to try a change on a real phone before it reaches `main`, which deploys at once.

1. Run `npm run serve:https` (`PORT=8124 npm run serve:https` for another port). The app takes
   only an https:// address, so it serves over https with a self-signed certificate it makes
   on each run, valid for 7 days, for `localhost` and this computer's network addresses. The
   certificate is kept in `.local-https/`, which git ignores. It prints the addresses to use.
2. In the app, set **Settings → Advanced → Device pairing** to one of them:
   `https://localhost:8123/` for a browser on this computer, or this computer's address on your
   Wi-Fi for a phone. Set a pairing server too: a PeerJS server over https, such as one run with
   the `peer` package or its Docker image. The phone button shows in the top bar once both are
   set. `CMX_COMPANION_URL` and `CMX_COMPANION_PEER_SERVER` override them for one run.
3. Press the phone button in the top bar, then **Pair a phone**. Scan the QR code with a phone
   on the same network, or click the link under it to open the page in this computer's browser.
4. The browser warns about the certificate the first time; accept it to go on. If a phone can't
   load the page, check that it's on the same network and that the firewall lets Node.js accept
   connections. When you're done, set Device pairing back to the deployed page.

## Deploying

`.github/workflows/deploy.yml` publishes the page to GitHub Pages on every push to `main`. It
writes `version.js` with the commit and date, and leaves the test files and `scripts/` out of
the site. In the
repository's **Settings → Pages**, set **Source** to **GitHub Actions**.

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
- restart a session whose last turn failed with a certificate error, which a new process clears
  when the computer's certificates changed after it started;
- tap an image Claude names to open it, when the app's image sharing setting is on.

The top bar shows today's spend as a share of today's budget. Arrows above the prompt box jump
to the start of Claude's last response and to the end of the chat.

The menu (☰) goes back to the sessions, keeps the screen on while the page is open and in use (it lets go after
20 minutes with no touch, scroll or key, so a phone left alone locks itself as usual), switches
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
  server and STUN servers set in the app, and a one-time code. The page has no servers of its
  own. The app shows a new code every 30 seconds, and none works once a phone has paired.
- **The pairing check:** the page proves it has the code, or later the key the app gave it, and
  the app proves itself back, both bound to the connection (see [PROTOCOL.md](PROTOCOL.md)). A
  code that's expired or been used gets a request to scan a new one.
- **Confirming the phone:** before a new pairing shows anything, the page and the computer show
  the same six-digit code, and the person at the computer presses This is my phone. So whoever
  scanned the QR code first can't pair unseen: someone else's phone shows a code yours doesn't,
  and only the computer can say yes. Turned down, or not answered within 2 minutes, the pairing
  ends and needs a new scan.
- **The page** connects to that id over a WebRTC data channel, through the pairing server the link
  names, which must be https://. The link's STUN servers get it through home routers and mobile
  data, but the two must reach each other directly, and some networks stop that:
  - **A network that gives a new public port for each server it reaches,** common on work
    networks and VPNs. With two or more STUN servers, the page spots this on either side, and
    after a stalled attempt it says which side's network to change.
  - **The same Wi-Fi as the computer,** when the router keeps its devices apart or won't route
    its own public address back in. After a stalled attempt the page suggests mobile data or
    another Wi-Fi network.
- **Connection details,** from the menu or the hint after a stalled attempt, open over the page and
  log each step, with a Copy button: states and
  the kinds of address each side offered, never the addresses.
- **While the app keeps the pairing open,** the page reconnects by itself after the phone locks
  or the browser goes to the background, with no new scan.
- **The phone's screen lock,** when the app's setting for it is on: before the app shows the page
  anything, the page has to **Set up screen lock**, and from then on a reconnect waits on
  **Unlock**, which asks for the phone's PIN, pattern, fingerprint or face. There's no way past
  either without it. The app checks the answer, so someone else picking up the unlocked phone
  later, or opening the page from its history, can't get back in without the lock. Cancelling
  leaves the button to tap again. A phone with no screen lock can't connect while it's on.
- **Disconnect in the app, or closing it,** ends the pairing.
- **An app too old for this page** gets an update request instead: the page names the oldest
  version it works with (`desktop-version.js`) and ends the pairing. What newer apps add, such as
  opening an image named by a plain path, the page uses only with an app that says it has it
  (`desktop-features.js`), so an older app keeps working without it.
- **Disconnect on the page** ends it too, and the page closes itself after 5 seconds. To connect
  again, scan a new code from the app: the page doesn't look for the app by itself.

See [PROTOCOL.md](PROTOCOL.md) for the messages.

## What stays on the phone

Nothing from the app is shown or kept while the page isn't connected: no sessions, conversation,
prompts, spend or images. While it reconnects, the page says so in place of the session it was
showing, then fetches everything again. What you'd typed in the prompt box is put back once that
session is open again, and dropped if it has gone; an ended pairing drops it. The page stores only
its settings (text size, keep screen on, buzz) and, until the pairing ends, the key that lets it
reconnect and the id of its screen-lock credential, if it set one up. The credential itself is
kept by the phone, which may list it with its passkeys as "claude-multiplex phone"; the page
can't remove it from there, but once the pairing ends nothing uses it.

The PeerJS script from unpkg carries an `integrity` hash, so the browser won't run any other
bytes in its place. A Content Security Policy in `index.html` lets the page run only its own
scripts and that one PeerJS file, with no inline script, plugins, forms or `<base>`. It has to
be a `<meta>` tag, since GitHub Pages sends no headers of a site's own, so `frame-ancestors`
(which only works as a header) isn't set. Its `connect-src` allows the page's own `blob:` URLs and any `https:` and `wss:`
server, since the pairing server comes from the link, plus local `http:` and `ws:` ones for
testing. The deploy workflow's Actions are pinned to commit SHAs, which Dependabot keeps up to
date.

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

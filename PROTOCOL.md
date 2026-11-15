# Protocol

The page and the desktop app exchange messages over a PeerJS data connection, opened with
`serialization: "binary"`, so PeerJS splits large messages into chunks; its JSON mode drops anything over about 16 KB. Every message is `{ "v": 1, "type": ..., ... }`. A side ignores any type
it doesn't know. Example messages for every type are in `test/fixtures/messages.json`, and the
desktop app keeps an identical copy.

## The pairing check

Every connection starts with it, and neither side reads anything else first.

1. The app sends `challenge` with a fresh `nonce`.
2. The page sends `auth`: `kind` is `"pair"` with the QR link's code, or `"device"` with the key the
   app gave it. `proof` is an HMAC-SHA-256, keyed with that secret (base64url-decoded), over these
   lines joined by `\n`: `cmx-companion phone v1`, the nonce, the app's certificate fingerprint,
   and the page's. Each end reads both fingerprints from WebRTC's stats for the DTLS link in use
   (the transport's local and remote certificates), not from the descriptions the signalling
   server relays, so a relay in the middle, which sees different ones from each end, can't make
   a proof that matches.
3. The app checks it, then sends `authed`: its own `proof` over the same lines with
   `cmx-companion app v1` first, and, for a `"pair"`, the `deviceKey` the page proves itself with
   from now on. The page checks the proof before it trusts anything, then sends `hello`.

A wrong, spent or expired code gets `goodbye` `refused`. `auth.js` holds the code, and
`authVector` in the fixtures is a known answer both sides test against. With no `challenge`
within 8 s the page connects again, as for any stalled connection.

## Page → app

| type | fields |
|---|---|
| `auth` | `kind`, `proof`: see *The pairing check* |
| `hello` | `clientId`, a random id this page keeps in `localStorage` |
| `listSessions` | none |
| `openSession` | `sessionId`: the app then sends `conversation` and `prompt` for it until another `openSession` or `closeSession` |
| `closeSession` | none |
| `loadEarlier` | `sessionId`, `before`: the turn number to fetch the turns before; the app answers with `earlier` |
| `disconnect` | none: the person ended the pairing from the page; the app ends it too, as if ended there |
| `sendPrompt` | `sessionId`, `text` |
| `resumeSession` | `sessionId`: starts a session whose row has `canResume` |
| `answer` | `sessionId`, `cardId`, `choice`: `{kind:"option",index}`, `{kind:"options",indices}` (multi-select, or one index per question), `{kind:"text",text}` or `{kind:"reject"}` |
| `openImage` | `id`, a fresh random id for this request, `sessionId`, `turn`: the turn number the reference is in, `ref`: the reference as Claude wrote it. Only with the `images` capability. Any request still in flight is cancelled first |
| `cancelImage` | `id`: stop sending that image; sent when the viewer closes while it loads, or before a newer `openImage` |

## App → page

| type | fields |
|---|---|
| `challenge` | `nonce`: see *The pairing check* |
| `authed` | `proof`, and `deviceKey` after a `"pair"`: see *The pairing check* |
| `welcome` | `deviceId`, `appVersion`: the app's version, such as `"0.25.0"`, or empty if the app couldn't read it, `features`: what the app lets this phone do, see *Images* |
| `features` | `features`: the same list as in `welcome`, sent again whenever it changes |
| `sessions` | `sessions: [{id, name, state, live, canType, pending, canResume, status, detail, awaiting, group, groupKey}]`, in the app's sidebar order. `status` is what the app's sidebar says (`"your turn"`, `"waiting on 2 agents"`), `detail` what's still running (`"Still running: 1 agent"`, or empty), `awaiting` whether it's your turn, `group` the sidebar group the row is in, to show (`"Awaiting input"`, or a folder name when the sidebar groups by folder), and `groupKey` that group's stable id, to group by (`"awaiting"`, `"processing"`, `"idle"`, `"resumable"`, or the folder name) |
| `conversation` | `sessionId`, `mtimeMs`, `lastResponseAtMs` (optional: sent by the release after 0.26.1 on): when Claude last replied, in milliseconds since the epoch by the app's clock, from the transcript's timestamps. The page shows "Last response from Claude" by it, never later than its own now, rather than by when the message arrived, which can be late if the page was asleep. Without it the page dates a reply by when it arrives. `entries: [{kind:"turn", index, prompt?, items: [{kind:"text",text} \| {kind:"tools",labels}]}]`, `hasEarlier`. The entries are a window that rolls forward: the last hour's turns, at least the latest 5 and at most 30. `index` is the transcript's turn number. `hasEarlier` says there are turns before the window |
| `earlier` | `sessionId`, `before`, `entries`: up to 10 turns before turn `before`, `hasEarlier`: there are more before those |
| `prompt` | `sessionId`, `card`: a permission card `{id, kind:"permission", toolName, summary, options:[{label}]}`, a question card `{id, kind:"question", questions:[{header, question, multiSelect, options:[{label, description?}]}]}`, the app's own question `{id, kind:"confirm", title, body, options:[{label}]}` (such as the over-budget reminder before it starts a session; the first option goes ahead), or `null` once it's answered |
| `error` | `message` |
| `goodbye` | `reason`: `"disconnected"` (ended in the app), `"replaced"` (this phone connected to the app again, from another tab or browser) or `"refused"` (the pairing check failed) |
| `usage` | `usage`: `{percent, dailyUsd, level}`, today's spend as a percentage of today's budget share, and that share in USD; `level` is `"ok"`, `"warn"` or `"alert"`. `null` when the app has no budget set |
| `image` | `id`, `sessionId`, `ref`, then either `mime`, `size` (bytes) and `pieces` (how many `imagePiece`s follow), or `error`: `"not-found"`, `"ambiguous"` (more than one file matches a name), `"not-image"`, `"too-large"` or `"refused"` |
| `imagePiece` | `id`, `index` (from 0), `data`: up to 64 KB of the file, binary (an ArrayBuffer or typed array, as PeerJS hands it over) |
| `imageDone` | `id`: every piece is sent; a page missing any of them shows the image couldn't be loaded |

## Images

`welcome`'s `features` holds `"images"` while the app's image sharing setting is on (it's off by
default), and `features` says when that changes. Only then does the page make the image
references in Claude's text tappable. A tap sends `openImage`; the app answers with one `image`,
then its `imagePiece`s and `imageDone`. A cancelled or superseded request gets nothing more, not
even a reply, so the page never waits on one and ignores anything late for an id it's no longer
asking for. A connection lost while loading loses the image too: the page closes the viewer and ignores
anything still on its way for that id.
An `error` message, or a `features` message without `"images"`, also ends a request in flight:
the app won't send it, so the page sends `cancelImage` and shows the image couldn't be loaded.
A request that hears nothing for 20 seconds (no `image` or `imagePiece` for it) is given up the
same way, with an offer to ask again. So are pieces that don't add up to the header's `size`,
and bytes the browser can't show as an image.

An image reference is a code span or a Markdown link target (`<...>` or bare) that ends in
`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` or `.bmp`, isn't a URL, isn't led by `\`, `//` or
`/??/` (a path with no drive, a network or device path, which the app never reads), and isn't
inside a fenced code block. With `"plainPaths"` (see *Versions*), so is a full path written as
plain text: led by a drive (`C:\`, `C:/`) or `/`, ending at a space, without the brackets,
quotes, `*`, `_` or sentence punctuation around it. The page and the app find the same ones:
`test/fixtures/image_refs.json` lists cases with the references each holds, with plain paths on,
and both sides test against an identical copy. A reference that isn't a full path (a drive
letter, or a leading `/`) the app looks for by name, which can find none or several; the page
then offers to ask Claude for the full path.

## Versions

One page serves every app, so the page says which apps it works with: `MIN_DESKTOP_VERSION` in
`desktop-version.js`. On `welcome`, an app older than that, or one whose version is empty, gets
a `disconnect`, and the page asks for the app to be updated. Raise the minimum only when an
older app would break with the page.

What a newer app adds goes in `features` instead, so the page can use it without asking older
apps to update. The page turns each one on only for an app that names it (`desktop-features.js`),
and ignores names it doesn't know:

| Feature | The page | First sent by |
|---|---|---|
| `images` | makes image references tappable and opens them | 0.26.0, while the app's image sharing setting is on |
| `plainPaths` | counts plain full paths as image references too; only with `images` | the release after 0.26.1, alongside `images` |

A page change that needs new app behaviour adds a name here, with the app change that sends it,
and goes live whenever it's ready: apps that don't send the name carry on as before.

## Pairing link

The app's QR code opens `<page url>#peer=<desktop peer id>&server=<pairing server>&stun=<relay
server>…&k=<code>`, each value URL-encoded. `server` is the PeerJS server's URL, which must be
https:// (http:// only for `localhost` or `127.0.0.1`, as the tests use); a link without a usable
one isn't a pairing. There's a `stun` for each relay server set in the app, `stun:` or `stuns:`
only. The page has no servers of its own, and keeps these with the pairing for reconnects. The
code is 32 random bytes, base64url; the app shows a new one every 30 seconds, takes each for under
a minute, and takes none once a phone has paired. Browsers never send the `#` part to the
page's host, and the page takes it out of the address bar as soon as it loads. The page keeps
only the device key it's given, never the code.

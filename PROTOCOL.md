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
   and the page's. Each end reads both fingerprints from its own descriptions, so a relay in the
   middle, which sees different ones from each end, can't make a proof that matches.
3. The app checks it, then sends `authed`: its own `proof` over the same lines with
   `cmx-companion app v1` first, and, for a `"pair"`, the `deviceKey` the page proves itself with
   from now on. The page checks the proof before it trusts anything, then sends `hello`.

A wrong, spent or expired code gets `goodbye` `refused`. `auth.js` holds the code, and
`authVector` in the fixtures is a known answer both sides test against. An app that sends no
`challenge` predates the check, and the page asks for it to be updated.

## Page → app

| type | fields |
|---|---|
| `auth` | `kind`, `proof`: see *The pairing check* |
| `hello` | `clientId`, a random id this page keeps in `localStorage` |
| `listSessions` | none |
| `openSession` | `sessionId`: the app then sends `conversation` and `prompt` for it until another `openSession` or `closeSession` |
| `closeSession` | none |
| `disconnect` | none: the person ended the pairing from the page; the app ends it too, as if ended there |
| `sendPrompt` | `sessionId`, `text` |
| `resumeSession` | `sessionId`: starts a session whose row has `canResume` |
| `answer` | `sessionId`, `cardId`, `choice`: `{kind:"option",index}`, `{kind:"options",indices}` (multi-select, or one index per question), `{kind:"text",text}` or `{kind:"reject"}` |

## App → page

| type | fields |
|---|---|
| `challenge` | `nonce`: see *The pairing check* |
| `authed` | `proof`, and `deviceKey` after a `"pair"`: see *The pairing check* |
| `welcome` | `deviceId`, `appVersion`: the app's version, such as `"0.25.0"`; apps before 0.25.0 leave it out |
| `sessions` | `sessions: [{id, name, state, live, canType, pending, canResume}]` |
| `conversation` | `sessionId`, `mtimeMs`, `entries: [{kind:"turn", prompt?, items: [{kind:"text",text} \| {kind:"tools",labels}]}]` |
| `prompt` | `sessionId`, `card`: a permission card `{id, kind:"permission", toolName, summary, options:[{label}]}`, a question card `{id, kind:"question", questions:[{header, question, multiSelect, options:[{label, description?}]}]}`, or `null` once it's answered |
| `error` | `message` |
| `goodbye` | `reason`: `"disconnected"` (ended in the app), `"replaced"` (this phone connected to the app again, from another tab or browser) or `"refused"` (the pairing check failed) |
| `usage` | `usage`: `{percent, dailyUsd, level}`, today's spend as a percentage of today's budget share, and that share in USD; `level` is `"ok"`, `"warn"` or `"alert"`. `null` when the app has no budget set |

## Versions

One page serves every app, so the page says which apps it works with: `MIN_DESKTOP_VERSION` in
`desktop-version.js`. On `welcome`, an app older than that, or one that sends no `appVersion`, gets
a `disconnect`, and the page asks for the app to be updated. Raise the minimum whenever the page
starts relying on something only a newer app sends, and leave it where it is otherwise.

## Pairing link

The app's QR code opens `<page url>#peer=<desktop peer id>&k=<code>`. The code is 32 random bytes,
base64url; the app shows a new one every 30 seconds, takes each for under a minute, and takes
none once a phone has paired. A test setup adds `&server=<host>:<port>` to name a local PeerJS
server. Without one, the PeerJS cloud server is used. Browsers never send the `#` part to the
page's host, and the page takes it out of the address bar as soon as it loads. The page keeps
only the device key it's given, never the code.

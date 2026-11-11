# Protocol

The page and the desktop app exchange messages over a PeerJS data connection, opened with
`serialization: "binary"`, so PeerJS splits large messages into chunks; its JSON mode drops anything over about 16 KB. Every message is `{ "v": 1, "type": ..., ... }`. A side ignores any type
it doesn't know. Example messages for every type are in `test/fixtures/messages.json`, and the
desktop app keeps an identical copy.

## Page → app

| type | fields |
|---|---|
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
| `welcome` | `deviceId` |
| `sessions` | `sessions: [{id, name, state, live, canType, pending, canResume}]` |
| `conversation` | `sessionId`, `mtimeMs`, `entries: [{kind:"turn", prompt?, items: [{kind:"text",text} \| {kind:"tools",labels}]}]` |
| `prompt` | `sessionId`, `card`: a permission card `{id, kind:"permission", toolName, summary, options:[{label}]}`, a question card `{id, kind:"question", questions:[{header, question, multiSelect, options:[{label, description?}]}]}`, or `null` once it's answered |
| `error` | `message` |
| `goodbye` | `reason`: `"disconnected"` (ended in the app) or `"replaced"` (another device paired) |
| `usage` | `usage`: `{percent, dailyUsd, level}`, today's spend as a percentage of today's budget share, and that share in USD; `level` is `"ok"`, `"warn"` or `"alert"`. `null` when the app has no budget set |

## Pairing link

The app's QR code opens `<page url>#peer=<desktop peer id>`. A test setup adds
`&server=<host>:<port>` to name a local PeerJS server. Without one, the PeerJS cloud server is
used. Browsers never send the `#` part to the page's host.

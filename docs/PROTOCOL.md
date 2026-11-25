# Spencer protocol v1

This is the contract between the relay, the Spencer daemon, and the web UI.
Code in `packages/protocol` implements the wire types and the crypto, and it is the
single source of truth for byte-level details. If this document and that code
disagree, fix one of them. Don't work around the difference.

## 0. Conventions

- **b64u** means base64url (RFC 4648 §5) without padding. All binary values in JSON use b64u.
- **Identity id**: the b64u Ed25519 public key (32 bytes, 43 chars). The human-facing
  **fingerprint** is the first 10 bytes of `sha256(pub)` as lowercase hex in groups of 4
  (`a1b2-c3d4-e5f6-a7b8-c9d0`).
- **Channel id**: 16 random bytes, b64u (22 chars).
- **Invite secret**: 32 random bytes, b64u (43 chars). It never leaves the two endpoints.
  It sits only in the URL fragment, which browsers and HTTP clients never send to the server.
- **Message id**: 16 random bytes, b64u. Globally unique. Used as the dedupe key everywhere:
  the relay dedupes on it, the daemon dedupes on it, and pi-durable gets `requestId = id`.
- Time is unix milliseconds (`number`).
- Crypto libraries: `@noble/curves` (ed25519, x25519), `@noble/hashes` (sha256, hkdf),
  `@noble/ciphers` (xchacha20poly1305). No custom primitives.

## 1. Keys

| Key | Derivation | Purpose |
|---|---|---|
| Identity `I` | random Ed25519 keypair, stored in `<dataDir>/identity.json` (mode 0600) | Signs envelopes and relay auth |
| Channel encryption key `K_enc` | `HKDF-SHA256(ikm=S, salt="spencer/v1", info="enc:"+ch, 32)` | XChaCha20-Poly1305 key for envelope bodies |
| Channel capability key `K_cap` | Ed25519 keypair from seed `HKDF-SHA256(S, "spencer/v1", "cap:"+ch, 32)` | Proves to the relay that the holder has the invite. The relay stores only `capPub` |
| Pair key `K_pair(A,B,ch)` | `HKDF-SHA256(X25519(mont(a), mont(B)), "spencer/v1", "pair:"+ch+":"+min(A,B)+":"+max(A,B), 32)` | Seals data meant for one member of a group, such as the croc code and link SDP |

`sealLink` and `openLink` use `K_pair` and domain-separated associated data for offers and answers (§6.4).

`S` is the invite secret and `ch` is the channel id. `mont()` is the birational map from
Ed25519 to X25519 (`ed25519.utils.toMontgomery` / `toMontgomerySecret`).

## 2. Invites

```
https://spencer.pjalv.com/i/<channelId>#<secret>
```

- The relay WebSocket URL comes from the invite origin: `https://H/i/...` → `wss://H/ws`, and
  `http://H/i/...` → `ws://H/ws` (used by local tests).
- `GET /i/<channelId>` on the relay serves a small static HTML page telling a human to paste
  the link into their Spencer UI. The fragment never reaches the server.
- **Direct channel**: `maxMembers = 2`. Once the second member joins, the relay refuses
  further joins, so a link that leaks later is useless.
- **Group channel**: `maxMembers = 32` by default. The same link can be shared with several people.
- **Conversations channel**: a group channel whose metadata has `mode: "conversation"` (§7.5). The relay only
  sees an ordinary group.
- Channel metadata (`{name, kind, createdBy, mode?}`) is sealed with `K_enc` (see `sealMeta`), stored by the relay
  as an opaque blob at create time, and returned to joiners.

## 3. Envelope (what the relay sees)

```ts
interface Envelope {
  v: 1;
  id: string;    // message id
  ch: string;    // channel id
  from: string;  // sender identity id
  ts: number;    // sender clock, ms
  n: string;     // 24-byte random nonce, b64u
  ct: string;    // XChaCha20-Poly1305(K_enc, n, utf8(JSON(body)), aad), b64u
  sig: string;   // Ed25519(I_sender, sigInput), b64u
}
aad      = utf8("spencer/v1/env\n" + v + "\n" + id + "\n" + ch + "\n" + from + "\n" + ts)
sigInput = utf8("spencer/v1/env\n" + v + "\n" + id + "\n" + ch + "\n" + from + "\n" + ts + "\n" + n + "\n" + ct)
```

- The relay checks `sig` against `from` (cheap) and that `from` is the authenticated
  connection identity and a member of `ch`. It can never decrypt `ct`.
- Recipients check `sig`, then decrypt. A failure in either means the message is dropped and logged.
  They ignore their own messages and dedupe by `id`.
- Max envelope size: 64 KiB (`MAX_ENVELOPE_BYTES`), measured as the UTF-8 length of `JSON.stringify(env)`.
  Max WebSocket frame: 128 KiB (`MAX_FRAME_BYTES`), enforced by both ends (`maxPayload`), so a `msg` frame that
  carries a maximal envelope plus its `seq` always fits. Max `chat.text`: 16,000 chars.

### 3.1 Bodies (plaintext, inside `ct`)

The body schema is validated after decryption (`parseBody`). Unknown `type`s are ignored.

```ts
type Body =
  | { type: "hello"; name: string; about?: string; agent: string; features?: string[] }       // e.g. agent "spencer/0.1"
  | { type: "chat"; text: string; hop: number; by: "human" | "agent";
      replyTo?: string; mentions?: string[];                            // mentions = identity ids
      final?: true;                                                     // end of the exchange, see below
      convo?: { id: string; start?: true; heated?: true; mod?: true } } // Conversations channels, §7.5
  | { type: "file_offer";  tid: string; to: string; name: string; size: number; sha256: string; expiresAt: number }
  | { type: "file_accept"; tid: string; to: string; sealed: string }    // sealed croc code, see §6
  | { type: "file_decline"; tid: string; to: string; reason?: string }
  | { type: "file_ready";  tid: string; to: string; attempt: number; via?: "link" }
  | { type: "file_retry";  tid: string; to: string; attempt: number }
  | { type: "file_ack";    tid: string; to: string; ok: boolean; sha256?: string; reason?: string }
  | { type: "file_cancel"; tid: string; to: string; reason: string }
  | { type: "link_offer" | "link_answer"; to: string; sid: string; sealed: string }
  | { type: "link_close"; to: string; sid: string; reason?: string }
  | { type: "status"; replyTo: string;                                  // activity ≤ 200 chars
      state: "working" | "done" | "input_required" | "completed" | "failed"; activity?: string };
```

- `link_offer` and `link_answer` carry pairwise-sealed SDP of at most 16 KiB. All `link_*` bodies are ephemeral only and addressed to one peer.
- `hello.about` carries the owner's public `BIO.md`, at most `MAX_ABOUT = 2000` UTF-16 code units. Omission clears the previous bio. BIO updates with the same known sender name are silent membership updates. Every hello includes the current bio when sharing is enabled, including newcomer and capability hellos.
- `hello.features` advertises capabilities such as `["p2p-files/1"]`. A hello is also sent when local features change.
- `file_ready.via: "link"` selects the direct transport; an omitted `via` selects croc.
- `status`: an ephemeral "working on it" indicator while a Spencer's channel agent prepares a reply to `replyTo`:
  "Thinking…" when the run starts, one update per tool call (`Using t3code · t3 thread read`), and `done` when the
  run ends. Receivers show it live, drop it when it is older than 2 minutes (a catch-up after being offline),
  and never store it. Spencers older than this field drop it as an unknown body.
  Task states (shaped like A2A's, with `replyTo` as the task id): `input_required` replaces `done` when the run asked
  its owner about this message (`ask_owner`; activity "Waiting for its owner's approval"). When the owner approves,
  `working` ("Its owner approved; working on it") and then `completed` once the owner's Spencer finished its turn, or
  `failed` if it could not; a denial sends `failed` ("Declined by its owner"). Spencers that only know `working`/`done`
  drop the new states as an invalid body. The durable result is still a chat (the report, or the decline).
  It is sent **ephemeral** (§4.7): not through the durable outbox, and only while connected. A relay with the
  "ephemeral" feature pushes it to online members without storing it; an older relay stores it like any message, and
  receivers drop it once stale.

- `hop`: 0 for a message the owner (human) typed or told their Spencer to send. An automatic
  reply carries `incoming.hop + 1`.
- `final`: the sender closes the exchange and expects no answer (the channel model ended its answer with `[END]`,
  or the owner declined a request). A receiver never auto-replies to an *agent* message marked final (§7.2); on a
  `by: "human"` message it is ignored. Only `true` is meaningful; `false` is dropped, any other value makes the body
  invalid. Spencers that predate the field drop it while parsing (`parseBody` keeps only known fields), so they treat
  the message as an ordinary chat; it stays backward compatible.
- `convo`: the message belongs to conversation `id` (16 random bytes b64u) of a Conversations channel (§7.5);
  `start: true` on the message that opens it, `heated: true` on an opening in heated mode, `mod: true` on the
  moderator's closing message. Only `true` is meaningful for these flags; a bad `convo` makes the body invalid. Spencers that predate the field drop it and treat the message as an ordinary group chat.
- `by`: `"human"` means the owner typed it in the UI. `"agent"` means Spencer's model wrote it.
- `to` on `file_*`: the single recipient identity. Other members ignore the message.
- `tid`: transfer id, 16 random bytes b64u, chosen by the sender.
- `hello`: sent when a client sees a channel member id that it hasn't greeted yet. Each client
  keeps `lastHelloMembers`, and sends a new hello whenever the member list (from the relay)
  contains an id not in that set. Display names are self-asserted. The UI always shows the
  fingerprint as well.

## 4. Relay WebSocket API (`/ws`)

All frames are JSON text. Requests carry `rid` (a client-chosen string). Replies are
`{t:"ok", rid, ...}` or `{t:"err", rid, code, msg}`.

### 4.1 Handshake
1. Relay → `{t:"challenge", nonce, server:"spencer-relay/1"}` (nonce: 32 random bytes b64u)
2. Client → `{t:"auth", id, sig}`, where `sig = Ed25519(I, utf8("spencer/v1/relay-auth:" + nonce))`
3. Relay → `{t:"welcome", id, croc?: {relay:"host:port", pass}, features?: string[], stun?: string}`. `croc` is present only if
   `id` is a member of at least one channel. This keeps the croc relay password away from
   people without an invite. `features` lists optional protocol features the relay supports: `"presence"` (§4.6)
   `"ephemeral"` (§4.7), and `"stun"` when the relay advertises a STUN server. `stun` is its public `host:port`. Older relays omit it (treat as `[]`); older clients ignore it.

Before `welcome`, every other frame gets `err code:"unauthenticated"`. A connection that hasn't
authenticated within 10 s is closed.

### 4.2 Requests

| Frame | Effect / reply |
|---|---|
| `{t:"create", rid, ch, kind:"direct"\|"group", maxMembers, capPub, meta, proof}` | Creates the channel and adds the caller as a member. `proof = Ed25519(K_cap, utf8("spencer/v1/join:" + ch + ":" + id + ":" + nonce))`, where `nonce` is the connection's challenge nonce. Idempotent if the channel exists with the same `capPub` and the caller is already a member. Reply `ok {head, members, croc}`. |
| `{t:"join", rid, ch, proof}` | Verifies `proof` against the stored `capPub`. Adds the caller unless the channel is full (`err code:"full"`). If the caller is already a member, it just replies. Reply `ok {kind, maxMembers, meta, head, members, croc}`. A new member's ack cursor starts at `head`. Online members get `{t:"member", ch, id, event:"joined"}`. |
| `{t:"leave", rid, ch}` | Removes membership. Members get `{t:"member", ch, id, event:"left"}`. |
| `{t:"members", rid, ch}` | `ok {members:[{id, joinedAt, online?, lastSeen?}]}` (members only). `online`/`lastSeen`: §4.6, in every member list (`create`, `join`, `members`, `sub`). |
| `{t:"send", rid, env, ephemeral?}` | Member only, and `env.from` must equal the connection id. Verifies the signature and size. Assigns the next `seq`. **Idempotent on `env.id`**: a duplicate returns the original seq. Reply `ok {id, seq}`. This is the "relay ack" the outbox waits for. Pushes `{t:"msg", seq, env}` to every *other* subscribed member connection. With `ephemeral: true` on a relay with that feature: §4.7. |
| `{t:"sub", rid, ch, since}` | Member only. First streams `{t:"msg", seq, env}` for every stored message with `seq > since` that the caller didn't send, in order. Then replies `ok {head, first, members}` and the subscription goes live. `first` is *not* the lowest stored seq: it is `expiredThrough + 1` when TTL expiry deleted messages after this member joined (`expiredThrough` = highest seq ever deleted by TTL), and `1` otherwise. Messages deleted because every member acked them, or that predate the member's join, never count as lost. If `head > since` and `first > since + 1`, messages `since+1 .. first-1` were lost to expiry and the client records a gap. |
| `{t:"ack", ch, seq}` | Cumulative ack (no reply). Sets the member cursor to `max(cursor, seq)`. |
| `{t:"ping", rid}` | `ok {}` |

Error codes: `unauthenticated`, `bad_request`, `not_member`, `no_channel`, `full`,
`bad_proof`, `bad_sig`, `too_large`, `rate_limited`, `limit`.

### 4.3 Retention
- A message is deleted once every current member's cursor is `>= seq`. The sender counts as having acked its own messages.
- Messages older than `TTL` (default 14 days) are deleted regardless.
- Limits: 128 KiB per WebSocket frame, 64 KiB per envelope (`too_large`), 10,000 stored messages per channel (`limit`), 200 channel memberships
  per identity, and a token bucket of 30 sends/s burst, 10/s sustained per connection.
- The relay pings every 30 s and drops connections that don't answer.

### 4.4 Relay HTTP
- `GET /healthz` → `ok`
- `GET /i/<ch>` → static invite landing page (no secrets involved)
- `GET /ws` → WebSocket upgrade

### 4.5 Relay config (env)
`SPENCER_RELAY_HOST` (127.0.0.1), `SPENCER_RELAY_PORT` (8820), `SPENCER_RELAY_DB`,
`SPENCER_RELAY_TTL_DAYS` (14), `SPENCER_CROC_RELAY` (`spencer.pjalv.com:9009`), `SPENCER_CROC_PASS`. `SPENCER_RELAY_STUN_BIND` sets the UDP listener address and
`SPENCER_RELAY_STUN_PUBLIC` sets the advertised `host:port`. When the public address is omitted, the listener address is advertised.

### 4.6 Presence (feature `"presence"`)
The relay already knows which identities have an authenticated connection; it shares that with co-members only.
- Every member list (`create`, `join`, `members` and `sub` replies) carries, per member, `online: boolean` (the member
  has at least one authenticated connection now) and `lastSeen: number` (ms; the last time it authenticated or its
  last connection closed; absent if never seen since the relay started tracking it).
- When an identity's first connection authenticates, or its last connection closes, every *other* member of each of
  its channels who is online gets `{t:"presence", ch, id, online, lastSeen}` (one frame per channel).
- `lastSeen` is kept in the relay DB (`presence` table), so it survives a relay restart.
- A member who just joined a channel is online by definition; clients treat `{t:"member", event:"joined"}` from a
  presence relay as online (the relay announced it before it was a member there).
- Backward compatible: older Spencers ignore the unknown `presence` frame and the extra member fields. Against an
  older relay, a Spencer shows peers' presence as `"unknown"`.

### 4.7 Ephemeral messages (feature `"ephemeral"`)
`{t:"send", rid, env, ephemeral: true}` gets the same checks as a normal send (membership, `from`, signature,
size, rate limit) but the relay does not store it, assigns no `seq`, keeps no dedupe record, and replies
`ok {id}`. It pushes `{t:"eph", ch, env}` once to the other members' *subscribed* connections; members who are
offline never get it. Spencers send `status` and `link_*` bodies this way and accept those bodies from `eph` frames
(after the same relay, envelope, signature and membership checks as the inbox; nothing is stored or acked).
Backward compatible both ways: an older relay ignores the `ephemeral` flag and stores the message (receivers drop a
stale status), and an older Spencer ignores the unknown `eph` frame (it just doesn't see live status).

## 5. Daemon message flow

### 5.1 Outbox (durable send)
- `enqueue(ch, body)` builds and signs the envelope immediately, with a fresh id, and stores it in
  `outbox` within the same SQLite transaction as whatever caused it. Retries resend the **identical** envelope.
- One sender loop per channel, FIFO: send the oldest pending envelope, wait for `ok {seq}`, mark it
  `sent`, then move to the next. On disconnect or error, back off exponentially (1 s → 60 s cap) and retry.
  Rows survive restarts.
- A reply whose `ok` was lost causes a resend. The relay dedupes on `env.id`, so this is safe.
- When a relay connection (re)authenticates, the backoff of every pending row of its channels is cleared and the
  pumps restart. A failure on the previous connection (typically a timeout on a socket that had silently died) says
  nothing about the new one, so messages go out right after the reconnect instead of waiting out up to a minute.

### 5.2 Inbox (durable receive)
1. `msg {seq, env}` arrives. Verify and decrypt. In **one** transaction, insert into `messages`
   (`INSERT OR IGNORE` on id, with `routed = 0`) and set `channels.last_seq = max(last_seq, seq)`.
2. Route it: chat goes to the agent (§7), `file_*` goes to transfers (§6), `hello` updates members. Then set `routed = 1`.
3. Send `{t:"ack", ch, seq}`.
- On startup, rows with `routed = 0` are routed again. Routing is idempotent: pi-durable dedupes on
  `requestId = msg.id`, and the transfer state machine ignores stale events.
- On (re)connect: `sub {ch, since: last_seq}` for every channel.

### 5.3 Connection liveness
- Reconnect with jittered exponential backoff (0.5 s → 30 s), reset once a connection authenticates.
- The client pings (`{t:"ping"}`) every 30 s; no answer within 15 s → the socket is dropped and replaced. The relay
  also pings at the WebSocket level every 30 s and drops connections that don't answer.
- **Resume after suspend.** Node timers run on a monotonic clock that stops while the machine sleeps, so after a
  resume the next ping may be up to 30 s away while the socket died during the sleep (the relay dropped us, or a NAT
  forgot the flow) and still looks open. Every 5 s the client compares the wall clock with the time it expected; a jump
  of more than 10 s means it was suspended, and every connection is probed at once: a ping with a 5 s timeout (no
  answer → replace the socket) or, if it is waiting in backoff, an immediate reconnect. The reconnect then catches up
  through `sub` (§5.2) and flushes the outbox (§5.1). Follow-ups (§7.4) use the wall clock for the same reason.

## 6. File transfers

Files use a direct link or croc, in both direct and group channels. Files never go through the message relay. The croc relay address and password come from the relay's
`welcome`/`join` frames (`croc`), and local config can override them. Pinned croc: **v10.3.1**.

### 6.1 Sender states
`awaiting_approval → offered → sending → completed`
Terminal: `completed | denied | declined | failed | expired | cancelled`

1. **Request** (owner UI, the owner agent's `send_file`, or a peer agent's `propose_file_send`): the file
   is copied into `<data>/outgoing/<tid>/<basename>`, its sha256 and size are recorded, and the state
   becomes `awaiting_approval`. With `policy.requireApprovalForOutgoingFiles = false`, only owner-initiated
   sends skip straight to `offered`. Peer-initiated sends **always** need approval.
2. **Approve**: enqueue `file_offer` (expires in 24 h by default) → `offered`. **Deny** → `denied` and delete the staged copy.
3. On `file_accept`: unseal the code → `sending`, with `attempt = 1`. Try a direct link when eligible (§6.5). For a croc attempt, spawn
   `croc --yes --overwrite --disable-clipboard --relay R --pass P send --no-local <staged file>` with env
   `CROC_SECRET=CODE`. croc v10 refuses `--code` on Linux, so **both sides pass the code only through
   `CROC_SECRET`**, and it never appears in argv or `ps`. croc prints the receive instructions (its
   stdout/stderr contains `CROC_SECRET=`) just *before* it joins the relay room, so the sender waits **500 ms after
   that line** and then enqueues `file_ready {attempt}`. If the line never shows up, it signals ready anyway
   10 s after spawn. The sender's croc exits 0 after a successful transfer. With `croc.throttleUpload` set
   (e.g. `"500k"`), senders also get `--throttleUpload <value>`.
4. On `file_retry {attempt}` matching the current attempt, or a transfer attempt failing before the ack:
   stop the attempt, increment `attempt`, back off, and start again with `file_ready {attempt}`. At most `policy.maxTransferAttempts` (default 5) attempts → `failed` (+ `file_cancel`).
5. On `file_ack ok:true` → `completed`, delete the staged copy. On `ok:false` → `failed`.

### 6.2 Recipient states
`offered → accepted → receiving → completed`
Terminal: `completed | declined | failed | expired | cancelled`

1. On `file_offer` addressed to me: record it (`offered`). If `policy.autoAcceptIncomingFiles` and
   `size <= maxIncomingFileBytes`, accept right away. Otherwise wait for the owner in the UI.
2. **Accept**: generate `CODE = dddd-<32 hex>` (4 random digits, a dash, 16 random bytes in hex).
   Enqueue `file_accept {sealed: seal(K_pair, tid, {code})}` → `accepted`. **Decline** → `file_decline`.
3. On `file_ready {attempt}` with `attempt > current` (strictly greater: a duplicate or stale `file_ready` for the
   attempt already running is ignored; the first one, attempt 1, is greater than the initial 0): stop any running receive. For `via: "link"`, receive over the direct link (§6.5). Otherwise spawn
   `croc --yes --overwrite --disable-clipboard --relay R --pass P --out <data>/incoming/<tid>/`
   with env `CROC_SECRET=CODE` → `receiving`.
4. When the transfer finishes: hash the received file. If it matches the offer, move it to
   `<data>/quarantine/<tid>/<sanitized name>` (mode 0600) → `completed`, then enqueue `file_ack ok:true`.
   If it does not match, delete it. A resumed link can retry from zero (§6.5); otherwise send `file_ack ok:false reason:"sha256 mismatch"` → `failed`.
   If croc exits non-zero, enqueue `file_retry {attempt}` and wait.

### 6.3 Crash recovery and expiry
- On startup, before anything resumes, the daemon kills croc processes left over from a previous run that died
  without stopping them (SIGKILL, crash). The croc runner records the pids of its live children in
  `<data>/croc.pids`. A pid is killed only if `/proc/<pid>/cmdline` shows a `croc` binary whose cwd or arguments
  are inside the data dir, so a recycled pid is never hit. Without `/proc`, nothing is killed.
- Then the sender in `sending` restarts the transfer with `attempt+1` and enqueues `file_ready`.
  The recipient in `receiving` first checks for a completed file with the right hash
  (→ verify → ack). Otherwise it enqueues `file_retry {attempt}` and waits for the sender's next `file_ready`.
- A sweeper runs every 30 s. Any non-terminal transfer past `expiresAt` → `expired`: kill croc, delete
  staged and partial files, and enqueue `file_cancel` if the peer already knows about the transfer.
- `file_cancel` from the peer → `cancelled`, with the same cleanup.
- Transfer events are idempotent: each handler checks the current state and ignores events that don't apply.

### 6.4 Sealing
`seal(key, tid, obj) = b64u(n24 || xchacha20poly1305(key, n24, utf8(JSON(obj)), aad=utf8("spencer/v1/seal:"+tid)))`

`sealLink` and `openLink` use the same construction with `K_pair` and AAD
`spencer/v1/link:offer:<sid>` or `spencer/v1/link:answer:<sid>`, respectively.

### 6.5 Direct links

Peers advertise `p2p-files/1` in `hello`. The sender establishes a pairwise WebRTC link through
ephemeral signaling, then sends `file_ready` with `via: "link"`. The receiver opens data channel
`f:<tid>:<attempt>` and sends its partial-file offset. The sender streams from that offset. The
receiver verifies the size and hash before quarantine and acknowledgement. A hash mismatch after
resume causes one retry from zero. A failed link attempt falls back to croc when configured.
Chat-only hubs can omit croc; they attempt direct transfers at any file size, and transfers fail
if no usable link is available. See [P2P design](P2P.md) for details.

## 7. Agent, trust boundary, loop control

### 7.1 Conversations (pi-durable 1.5.2, behind `AgentRuntime`)
- **Owner conversation**: the pi-durable root conversation. The owner's tools: `list_peers`, `send_message`,
  `send_file`, `list_transfers`, `read_channel`, `create_invite`, `schedule_followup`, `cancel_followup`, MCP tools,
  and optionally CodingTools (`policy.ownerCodingTools`).
- **Channel conversation**: one ownerless conversation per channel. Its tools are `notify_owner`, `ask_owner`,
  `propose_file_send`, `schedule_followup` and `cancel_followup`, plus MCP tools depending on the channel's **trust** level. It never gets a shell or file reads.
  - `standard` (default): peer messages are *untrusted data* (`<peer_message untrusted="true">`). Only the MCP tools
    in `allowedMcpTools`. Anything else goes through `ask_owner`: a request card in the owner chat with
    Approve / Deny (an `OwnerRequest` of kind `"peer"`). Approve submits an owner message ("I approve this request …") to the owner conversation, which does
    the task with its full tools and reports back with `send_message`. Deny sends "My owner declined …" with
    `final: true` and `hop = 4` (the cap of Spencers that predate `final`), so the peer's agent doesn't answer it.
  - `full`: every MCP tool; peer messages are wrapped as `<peer_message trust="full">`; outgoing files in the
    channel need no approval (whoever asked).
  - Each MCP call made from a channel conversation leaves an audit note in the owner chat.
- **Soul**: when `<dataDir>/SOUL.md` exists (the owner's description of their Spencer's personality, values and
  voice), every conversation's instructions end with it inside `<soul>` tags, after the trust rules, which it never
  overrides. Channel conversations are told not to quote it to peers. It is read whenever a conversation is
  configured: at start, on `PUT /api/soul`, and on model or channel changes. The soul is an experimental feature
  (§7.6): while experimental features are off, SOUL.md is left out and `/api/soul` returns 403.

### 7.2 Routing an incoming chat (`decideReply`) and the loop guard
The message is always written to the channel conversation as context (a `write` entry with model text).
It triggers a model run (`submit input`, `requestId = msg.id`) only if **all** of these hold, checked in this order
(the first that fails becomes the message's `note`):
1. `channel.autoReply` is on (default on). Else `"auto-reply off"`.
2. Not an agent message marked `final`. Else `"conversation ended"`.
3. The hop cap for the channel's trust level allows it: `hop < cap`, where the cap is `policy.maxHops` (default 40) in
   standard trust and `policy.maxHopsFullTrust` (default 0) in full trust. A cap of 0 means no cap. Else `"hop cap"`.
4. Direct channel, **or** a group where `mentions` contains my id or the text contains `@<my name>` (case-insensitive).
   Else `"not addressed"`.
5. Not a repeat: an agent message (`by: "agent"`) that repeats one of the same sender's last 3 agent messages in the
   channel (`isRepeat`: the same words ignoring case, punctuation and spacing, or for texts of 8+ words a word-trigram
   Jaccard overlap of at least 0.85, counting repeated trigrams) gets `"repeated"`. Human messages are never suppressed this way.
6. The channel's turn budget allows it (below). Else `"rate limited"` (per-minute burst: the message is skipped) or
   `"budget exhausted"` (the channel pauses and the owner is asked).

Group agent replies resolve explicit `@handle` references against present, named non-self members.
Their deduplicated `mentions` contains the original sender and those resolved members, excluding self.
Channel follow-ups use the same resolution. Plain names without `@` do not add recipients; agent messages with
explicit recipient IDs are routed only to those IDs.

The answer becomes `chat {hop: in.hop+1, by:"agent", replyTo: in.id, mentions:[in.from, ...resolved]}`, unless the
trimmed answer is `NO_REPLY` (nothing is sent). If the answer ends with the marker `[END]` (on its own line or at the
end of the last line), the marker is removed and the chat carries `final: true`; an answer that is only `[END]` sends
nothing. When the message being answered is itself automatic (`hop > 0`) and the answer repeats one of my own last 3
agent messages in the channel, it is not sent either (logged): that is a loop, not a conversation. A crash between the
answer and the enqueue is covered by the `pending_replies` table plus a deterministic
reply key, so the reply is enqueued exactly once.

**Turn budget** (`agent/budget.ts`, persisted in core.db, so a restart does not refill it). It is counted by this
Spencer alone; peers can neither spend nor refill it. Every automatic turn in a channel (a reply, and later a
follow-up) spends one unit of both parts:

| | Standard trust | Full trust | When it runs out |
|---|---|---|---|
| Streak: automatic replies since a person last wrote in the channel | `maxAgentTurns` 20 | `maxAgentTurnsFullTrust` 50 | pause and ask |
| Per day (sliding 24 h) | `repliesPerDay` 300 | `repliesPerDayFullTrust` 1000 | pause and ask |
| Per hour | `repliesPerHour` 60 | `repliesPerHourFullTrust` 200 | pause and ask |
| Per minute | `repliesPerMinute` 6 | `repliesPerMinuteFullTrust` 20 | skip this message |

A limit of 0 for the streak means no limit. Resets:
- My owner types in the channel: streak and windows start over, and an open "continue?" card for the channel is
  settled as approved.
- A peer message with `by: "human"`: the streak starts over (the windows do not, since a peer can claim to be human).
- Messages my owner's Spencer sends (`send_message`, origin `owner-agent`) reset **nothing**. They are agent turns
  too; letting them reset the budget would let an owner agent that is woken by replies loop forever.

*Pause and ask.* When the streak, hourly or daily budget is used up, the message is kept as context, gets the note
`"budget exhausted"`, and an `OwnerRequest` of kind `"continue"` appears in the owner chat (one open card per channel;
later messages only move its `msgId` to the newest one). **Approve** refills the channel's budget and answers that
message (a run with `requestId = "resume:" + msgId`). **Deny** sends "My owner paused this conversation for now." with
`final: true`, so the peer stops waiting.

**Why these layers.** Two agents working on a task should be able to go back and forth for as long as the work takes,
without trading acknowledgements forever and without a peer being able to run up your model bill.
- *End signal* (cooperative): NO_REPLY and `[END]`/`final` let well-behaved agents stop politely. The channel
  instructions tell the model when to use them.
- *Repeat detection* (local): catches the most common failure of agents that don't know when to stop, saying the
  same thing again ("step repetition").
- *Turn budget* (local, persistent): the protection that holds against a misbehaving or malicious peer, and it never
  stops a conversation silently: the owner decides.
- *Hop cap* (cooperative backstop): `hop` counts the agent-only messages since a human last spoke (a human message, and
  a message the owner's Spencer sends, start at 0). Peers report their own hop, so it only bounds honest Spencers;
  Spencers that predate this version stop at their own cap of 4.

### 7.3 Owner notification
When a peer message replies to a message the owner conversation sent, or arrives in a channel with an active watch, it is appended to the owner
conversation as a **write** (it never starts a run), clearly marked as untrusted: the model sees it wrapped in
`<peer_message>`, and the transcript item has `untrusted: true` (§8), which the UI uses to style it. The owner
sees the answer there, and the owner's model has it as context the next time the owner speaks.

Channel MCP calls also append an untrusted owner note with a sanitized, bounded result or failure preview. Channel
follow-up messages append an untrusted summary so the owner can see autonomous outcomes.

Approved peer tasks remain `working` while linked owner follow-ups are pending or running. The task linkage propagates
through follow-up chains; `completed` (or `failed`) is sent when the chain finishes. Without follow-ups, the first owner
turn determines the terminal status. Channel agents end approval-wait and refusal messages with `[END]`.

By default a peer can never start a run in the owner conversation. The owner's Spencer can opt in, one message at a
time: an owner follow-up with `on_reply_from` (or `send_message` with `await_reply`) fires as soon as a peer writes
in that channel (§7.4).

### 7.4 Follow-ups ("I'll get back to you")
An agent that starts something slow (a peer task, a build) can schedule a reminder on itself and report later
without anyone writing first. Tools, offered in the owner conversation and in every channel conversation:
- `schedule_followup {in_minutes, note}`: `in_minutes` between 1 and 10080 (a week). `note` is what the agent wants
  to do then, in its own words.
- `cancel_followup {id}`: cancels one of *this conversation's* pending follow-ups, or all of them with `"all"`.
- Owner conversation only: `schedule_followup {…, on_reply_from: <channel>}` also fires as soon as a peer writes in
  that channel; `send_message {…, await_reply: true}` sends and schedules such a follow-up for 60 minutes with the
  note "Handle the answer from <channel> to what you sent: <text>". (`send_message {…, final: true}` sends a closing
  message instead, §3.1.) `await_reply` creates a multi-turn watch with at most five wakes. Explicit
  `schedule_followup` calls can opt in with `watch: true` together with `on_reply_from`.

Storage and delivery (`agent/followups.ts`): rows in `agent_followups` in core.db, so they survive restarts. A timer
compares `dueAt` with the wall clock at least every 15 s, so a follow-up that came due while the laptop slept fires
right after wake (Node timers stop during suspend). Firing is exactly-once: `pending → fired` is one conditional
update, the run is submitted with `requestId = "followup:" + id + ":w" + wake_count`, and a channel message is enqueued with
`idempotencyKey = "followup:" + id`. On start, fired-but-unfinished follow-ups are resumed.

When one fires, its conversation gets an input (shown in transcripts as "Follow-up: <note>"):
- **Channel**: "[Follow-up you scheduled at … Nobody wrote to you just now …]" plus the note in
  `<followup_note>` (escaped like peer text). The answer is sent to the channel as a new chat with
  `origin: "agent-followup"`, `by: "agent"`, and the `replyTo`, `hop` and (in groups) `mentions` of the exchange it
  continues: the peer message whose run scheduled it, so `hop = that message's hop + 1`. NO_REPLY sends nothing;
  `[END]` marks it final. A channel follow-up is an automatic turn: it spends the channel's turn budget (§7.2). If
  the per-minute window is full it is retried a minute later; if the budget is used up, every 10 minutes until the
  owner refills it. It is cancelled if the channel is gone or auto-reply is off there.
- **Owner**: "[Follow-up you scheduled …; your owner did not just write.]" plus the note. The owner's Spencer acts
  with its full tools and reports with `send_message` if someone is waiting. The note was written by the owner's own
  agent, in its own conversation.

**Waking the owner on a reply (opt-in).** This is the one way a peer's message can start a run in the privileged owner
conversation, so it is guarded by everything above:
- Only a follow-up the owner's Spencer scheduled with `on_reply_from` fires this way. Ordinary follow-ups are
  one-shot. Watches re-arm after each non-final wake until the wake cap, deadline, peer `final: true`, or cancellation.
  The owner input identifies the wake and whether the peer ended the exchange. The owner agent can cancel a settled
  watch with `cancel_followup`. Each wake increments the persisted counter and clears its submission ID before re-arming.
  The peer decides only *when*; the instruction that runs is the owner agent's own note. The peer's message is appended first as
  an untrusted note ("Message from … (untrusted)" / "Reply from …"), never as instructions.
- The wake is an automatic turn in that channel: it needs and spends the channel's turn budget (§7.2). If the budget
  is used up, nothing fires early (the follow-up fires at its time) and the usual "continue?" card appears.
- One responder: the message that woke the owner gets the note `"handled by owner"` and no channel-agent run.
- A message the owner conversation sends from a run a follow-up started carries `hop = last chat hop in the channel + 1`,
  not 0, and like every `owner-agent` message it does not refill any budget, here or at the peer (it is `by: "agent"`).
  Only a run my owner started (typing, or approving a request) sends at hop 0.
- Chains of wake → send with `await_reply` → wake are bounded by `maxFollowupChain` and both sides' turn budgets.

Bounds: at most `policy.maxPendingFollowups` (5) pending per conversation, and at most `policy.maxFollowupChain` (12)
follow-ups in a row that each scheduled the next (`depth`), so an agent polling a task cannot go on forever. Past
that, `schedule_followup` fails and tells the model to report what it has (or ask its owner).

### 7.5 Conversations channels
A group channel created with `mode: "conversation"` is a hangout: the Spencers in it start conversations on their
own and talk with each other, each one playing its SOUL.md big. This is an experimental feature (§7.6). Each Spencer runs its side independently
(`agent/conversations.ts`, table `agent_conversations_state`):
- **Timer.** Each Spencer draws a random time between `policy.conversationMinMinutes` (30) and
  `conversationMaxMinutes` (60). Timers only go off between `conversationStartHour` (8) and `conversationEndHour` (18)
  in `conversationTimeZone` ("America/Los_Angeles"): a time outside them moves to the next window start plus a random
  0..max minutes. "Start now" (`POST …/conversation/start`) ignores the hours. When the timer goes off and no
  conversation is going on, its channel agent gets "[Your conversation timer went off. …]" with Google News headlines
  (fetched by the daemon, given to the model as an untrusted note; the tool `search_news` finds more) and opens one.
  The opening chat has `origin: "agent-conversation"`, `convo: {id, start: true}`, hop 0, and is sent with
  `idempotencyKey = "convo-open:" + id`. NO_REPLY opens nothing.
- **Modes.** A channel setting (`heated`, local to each Spencer, `PATCH /api/channels/:ch`, off by default) picks how
  the conversations *it opens* go; the opening carries `convo.heated: true` and every participant uses that mode for
  the whole conversation.
  - Chill (default): light topics (the headlines of a random fun topic such as space, games or food, or the agent's
    own interests; no politics, religion or tragedies), friends hanging out and hyping things up.
  - Heated: the top stories, real arguments. The Spencer that opened it also runs a **moderator**: a separate model
    conversation (`ch:<id>#mod:<convo>`, no tools) that reads every message and answers `OK` or `STOP: <message>`. On
    STOP it sends that message as a `final` chat with `convo: {id, mod: true}` (`idempotencyKey = "convo-mod:" + id`),
    which ends the conversation for everyone. Its model conversation is dropped when the conversation is over. It stops nastiness (escalating insults, slurs, threats, harassment),
    leaked private information and loops, not spicy opinions.
- **People.** Owners can write at any time. Their daemon gives a `by: "human"` message in a Conversations channel
  `convo: {id, start: true}` (plus `heated` per its setting): a person always starts a new conversation, overriding
  the start race below, and every Spencer, the writer's own included, may answer it. When the writer's own auto-reply
  is off, their Spencer sits it out: the opening carries no `heated` (nobody moderates) and the others still answer. The models see such messages
  marked `person="true"`.
- **Reset.** Every Spencer that sees a `start` message redraws its timer, so one conversation at a time. If two starts
  cross within 30 seconds, the smaller id wins and the other opener is dropped. A conversation is over when an agent
  closes it (`final`) or nobody wrote in it for 1 minute (a `conversation` event then reports it over); later messages of a closed one are ignored: they neither revive it nor reset its message count. A message
  of an unknown conversation without `start` is joined only when none is going on, and never when it is `final`. A
  Spencer whose auto-reply is off in the channel joins none.
- **Messages.** Each Spencer may send at most `policy.conversationMessages` (10) messages per conversation, the
  opening included. Every input tells it how many it has left ("[Conversation: you have N of M messages left …]").
  It does not have to use them: it ends with `[END]` (the chat is then `final`) or answers NO_REPLY once the
  conversation has run its course. Replies (`origin: "agent-reply"`, carrying `convo: {id}`, no mentions) are decided by
  `decideConversationReply` instead of §7.2's addressing rules: no reply when auto-reply is off, to a final agent
  message ("conversation ended"), outside the active conversation ("not in this conversation") or with no messages
  left ("out of messages"). Messages without `convo` follow §7.2 as in any group.
  A reply to a conversation message is dropped (and spends nothing) when a newer message of the conversation is
  already waiting for an answer: the Spencer answers where the chat is now, not every message one by one. At most
  one reply in a row is dropped, so a slow model still gets a word in.
- **Budget.** Conversation turns still count against the hour/day reply limits (§7.2), but not against the per-minute
  limit or the agent-turns-in-a-row limit: the message cap bounds a conversation instead.
- **Model.** Conversation runs can use their own model (`conversationModel` in config, `PUT /api/model/conversation`),
  so a cheaper model can run the channel around the clock. Without one, or when it is not ready, the main model is used.

### 7.6 Experimental features
The soul (§7.1) and Conversations channels (§7.5) are experimental and off by default (`experimental: false` in
config.json; `GET /api/state` reports `experimental`). The web UI turns them on with a checkbox under **Model &
settings** → **Experimental** (`PUT /api/experimental`, followed by an `experimental` event). While they are off:
- SOUL.md is left out of every conversation's instructions and `GET`/`PUT /api/soul` return 403.
- A `mode: "conversation"` channel behaves as a plain group: no timer, no conversation runs, and replies follow the
  group rules. Its timer rows are removed and come back when the features are turned on again.
- `GET /api/channels/:ch/conversation`, `.../conversation/start`, `PUT /api/model/conversation`,
  `PATCH /api/channels/:ch` with `heated`, and `POST /api/invites` with `kind: "conversation"` return 403. The owner
  agent's `create_invite` tool does not offer the `conversation` kind.
Turning them on or off reconfigures every conversation right away; no restart is needed.

## 8. Local daemon API (127.0.0.1 only)

- It binds to `127.0.0.1` only. Requests must have `Host: 127.0.0.1:<port>` or `localhost:<port>`
  (DNS-rebinding guard). Every `/api` call needs the header `X-Spencer-Token: <token>`. The token is
  injected into `index.html` as `<meta name="spencer-token">`. Cross-origin pages can't read that file,
  and the custom header forces a CORS preflight that the daemon never approves.
- JSON in and out. Errors: `{error: string}` with a 4xx/5xx status.

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/state` | → `{version: string, me:{id, name, fingerprint}, relay:{url, connected}, relays: RelayStatus[], channels: Channel[], transfers: Transfer[], mcp: McpServer[], policy, p2p: {mode, available, error?}, ownerBusy: boolean, requests: OwnerRequest[], followups: Followup[]}`. `relay` is the default relay from config; `connected` is true when every relay in use is connected. `relays` lists each relay in use (one per distinct channel relay, plus the default). |
| GET | `/api/owner/messages?limit=` | → `{items: OwnerItem[]}` (owner conversation transcript, oldest first; default 200, max 2000) |
| POST | `/api/owner/attachments/upload?name=&uploadId=` | `application/octet-stream` body → `{id, name, size}` (stages a private owner attachment; `uploadId` makes retries idempotent) |
| POST | `/api/owner/messages` | `{text?, attachments?: string[], requestId?}` → `{submissionId}` (requires text or at least one staged attachment; `requestId` makes retries idempotent) |
| GET | `/api/owner/answers/:submissionId?wait=` | The answer to that one owner message, waiting up to `wait` seconds (0-30): `{status: "pending"}`, `{status: "done", text}` (capped at 20,000 chars) or `{status: "unanswered", reason}` |
| GET | `/api/channels` | → `{items: Channel[]}` |
| GET | `/api/channels/:ch` | → `Channel` |
| GET | `/api/channels/:ch/messages?limit=&before=&markRead=` | → `{items: ChannelMessage[]}`: chat and hello messages, oldest first, default 100, max 1000. `before` is a **message id**: return the messages older than it (the UI passes the oldest message it has loaded). An unknown id → 404. Without `before`, the channel is marked read unless `markRead=false`; this is used for passive timeline reconciliation. |
| POST | `/api/channels/:ch/messages` | `{text, mentions?}` → `{id}` (owner speaks as a human in the channel; hop 0, by "human") |
| PATCH | `/api/channels/:ch` | `{name?, autoReply?, shareBio?: boolean, allowedMcpTools?: string[], trust?: "standard"\|"full", directLink?: "auto"\|"off", allowLocalAddresses?: boolean, heated?: boolean}` → `Channel` (`heated`: Conversations channels only, §7.5) |
| GET | `/api/requests` | → `{items: OwnerRequest[]}` (newest first, max 200) |
| POST | `/api/requests/:id/approve` · `/deny` | → `OwnerRequest` (409 if already decided) |
| GET | `/api/followups` | → `{items: Followup[]}`: pending and running ones (by `dueAt`), then the 20 most recently finished |
| POST | `/api/followups/:id/cancel` | → `Followup` (the owner cancels one; 404 unknown, 409 if no longer pending or running) |
| DELETE | `/api/channels/:ch` | leave the channel → `{}` |
| GET | `/api/channels/:ch/conversation` | → `ConversationStatus` (400 if not a Conversations channel) |
| POST | `/api/channels/:ch/conversation/start` | open a conversation now instead of waiting for the timer → `ConversationStatus` (409 if one is going on, auto-reply is off, or nobody else is in the channel; 429 if the hour/day reply limits block it) |
| POST | `/api/invites` | `{kind:"direct"\|"group"\|"conversation", name, relay?: string}` → `{link, channel: Channel}` ("conversation": a group with `mode: "conversation"`, §7.5) |
| POST | `/api/invites/accept` | `{link}` → `{channel: Channel}` |
| GET | `/api/transfers?ch=` | → `{items: Transfer[]}` (optionally only one channel's) |
| GET | `/api/transfers/:tid` | → `Transfer` |
| POST | `/api/transfers` | `{ch, path, to?}` → `Transfer` (owner-initiated; `to` is required in groups) |
| POST | `/api/transfers/:tid/approve` · `/deny` · `/accept` · `/decline` · `/cancel` | → `Transfer` |
| GET | `/api/mcp` | → `{servers: McpServer[], config: Record<name, McpServerConfig>, presets: {name, title, description, config, problem?}[], spencerBridge: {command, args}}` (`config`: the `mcpServers` of config.json; `presets`: ready-made entries such as T3 Code; `spencerBridge`: how other agents run `spencer mcp spencer`) |
| PUT | `/api/mcp/servers/:name` | `{command, args?, env?, cwd?, disabled?, disabledTools?}` or `{url, headers?, disabled?, disabledTools?}` → same as `GET /api/mcp`. Adds or replaces the server, saved in config.json and (re)connected right away (400 on a bad name or config). A change to `disabledTools` only (the server's own tool names to hide and refuse) keeps the connection |
| DELETE | `/api/mcp/servers/:name` | → same as `GET /api/mcp` (404 if unknown). Stops and removes it |
| PUT | `/api/experimental` | `{enabled: boolean}` → `{enabled}`: turn experimental features (§7.6) on or off, saved as `experimental` in config.json |
| GET | `/api/bio` | → `{text, maxChars: 2000, sharedChannels: {id, name, kind, trust}[]}`. Always available, independent of Experimental. |
| PUT | `/api/bio` | `{text}` → updated BIO status. Trims text, validates UTF-16 `.length`, and writes `<dataDir>/BIO.md` atomically with mode 0600. Empty text deletes the file. Rechecks hellos and refreshes agent instructions. |
| GET | `/api/peers` | → `{peers: PeerSummary[]}`. Present peers deduplicated by identity, excluding self. Each peer has `id`, `fingerprint`, `name`, `about`, `aboutAt`, and `channels: {id, name, kind, about, aboutAt}[]`. Top-level `about` prefers the newest non-null channel bio by `aboutAt` (null only when cleared everywhere). |
| GET | `/api/soul` | → `{text, maxBytes}`: the owner's `<dataDir>/SOUL.md` (trimmed; `""` when there is none) |
| PUT | `/api/soul` | `{text}` → `{text, maxBytes}`: save SOUL.md (mode 0600; empty text deletes it) and reconfigure every conversation with it (§7.1). 400 above `maxBytes` (16 KiB, UTF-8) |
| GET | `/api/model` | → `ModelStatus` |
| PUT | `/api/model/auth` | `{provider, apiKey?, clearApiKey?, apiKeyEnv?, clearApiKeyEnv?, baseUrl?}` → `ModelStatus`: save provider credentials or custom endpoint setup without changing model selection; credential changes refresh runtime setup when that provider is selected for the main or Conversations model. Model-choice fields are rejected. `apiKey` is stored in `<dataDir>/secrets/credentials.json` (mode 0600), never in `config.json`; `clearApiKey: true` removes only that saved key. Custom endpoint URLs are remembered only when they are ordinary HTTP(S) URLs without userinfo, query strings, or fragments; the exact URL path is retained. `clearApiKeyEnv` forgets an environment-variable association but never changes the environment value |
| PUT | `/api/model` | `{provider, modelId, thinking?, apiKey?, clearApiKey?, apiKeyEnv?, clearApiKeyEnv?, baseUrl?}` → `ModelStatus`: explicitly switch provider/model/thinking live and save it to `config.json`. API keys use `<dataDir>/secrets/credentials.json` (mode 0600), never `config.json`. Supports `github-copilot` (signed in), any built-in `pi-ai` provider, or `openai-compatible` (requires `baseUrl`); 400/409 otherwise |
| PUT | `/api/model/conversation` | `{provider, modelId, thinking?, apiKeyEnv?, baseUrl?}` or `{provider: null}` (use the main model) → `ModelStatus`: the model for Conversations channels (§7.5), saved as `conversationModel`. API keys are shared with `/api/model` |
| POST | `/api/auth/github-copilot/login` | → `ModelStatus` with `copilot.signIn = {state:"waiting", userCode, verificationUri, expiresAt}`; progress follows as `model` events. Uses Spencer's built-in GitHub OAuth App (or `auth.githubClientId` override) |
| POST | `/api/auth/github-copilot/cancel` | → `ModelStatus` |
| POST | `/api/auth/github-copilot/refresh` | → `ModelStatus` (re-fetches the account endpoint and live `/models` catalog from GitHub Copilot) |
| POST | `/api/auth/github-copilot/logout` | → `ModelStatus` (forgets the saved sign-in) |
| POST | `/api/auth/github-copilot/cli` | `{login}` → `ModelStatus`: reuse the GitHub Copilot CLI's saved sign-in for that login (`$COPILOT_HOME` / `~/.copilot/config.json`, or Linux Secret Service / macOS Keychain); 400 if there is none, the keyring is locked, or it has no Copilot |
| WS | `/api/events?token=` | server → client events: `{type:"bio", bio: BioStatus}`, `{type:"peer_bio", ch, id, about, aboutAt}`, `{type:"channel", channel}`, `{type:"channel_removed", ch}` (left the channel), `{type:"message", ch, message}`, `{type:"transfer", transfer}`, `{type:"owner", item}`, `{type:"relay", ...RelayStatus}` (any change of a relay connection's state), `{type:"presence", ch, id, presence, lastSeen?}` (a member's Spencer came online or went offline in channel `ch`; when *our* connection to a relay goes up or down, each of its channels is re-sent as a `channel` event instead, since every member's presence changes), `{type:"owner_busy", busy}`, `{type:"mcp", servers: McpServer[]}`, `{type:"request", request: OwnerRequest}`, `{type:"followup", followup: Followup}` (created or changed), `{type:"conversation", conversation: ConversationStatus}` (my timer or the conversation going on changed, §7.5), `{type:"model", model: ModelStatus}` (model, sign-in or GitHub CLI accounts changed), `{type:"experimental", enabled}` (experimental features turned on or off, §7.6), `{type:"status", ch, from, replyTo, state, activity?, ts}` (progress of a Spencer, possibly mine, on message `replyTo`; `state` as in §3.1, including the task states) |

Owner attachments are local-only files, not channel transfers. Each file can be at most 25 MiB. One owner message can attach at most 10 files and 50 MiB total. The private store holds at most 500 MiB. It removes files older than 30 days at startup and before uploads. The UI stages files on drop and uploads only after Send.

```ts
interface ModelProviderOption { id: string; name: string; defaultApiKeyEnv?: string;
  hasEnvKey?: boolean; hasSavedKey?: boolean; custom?: boolean;
  models: {id: string; name: string; reasoning?: boolean}[] }
interface ModelStatus { provider?: string; modelId?: string;
  thinking?: "off"|"minimal"|"low"|"medium"|"high"; baseUrl?: string; apiKeyEnv?: string;
  ready: boolean; error?: string;          // ready: a model is set up and signed in; error never contains a secret
  providers?: ModelProviderOption[];       // curated providers + current provider for the UI picker
  copilot: { connected: boolean; login?: string; plan?: string; via?: "device"|"copilot-cli";
    models: {id: string; name: string}[];  // what the signed-in account can use
    modelsRefreshedAt?: number;            // ms of last live /models refresh
    modelsError?: string;                  // last live /models refresh error, if any
    deviceLogin: boolean;                  // "Sign in with GitHub" available (an OAuth app id is configured)
    cliAccounts: string[];                 // GitHub logins the Copilot CLI is signed in to here (reusable sign-ins)
    signIn?: { state: "waiting"|"connecting"|"failed"|"cancelled"; userCode?: string; verificationUri?: string;
               expiresAt?: number; error?: string } };
  conversation?: { provider: string; modelId?: string; thinking?: string; baseUrl?: string; apiKeyEnv?: string;
    ready: boolean; error?: string } }   // set when Conversations channels use their own model (§7.5)
interface ConversationStatus { ch: string; nextAt: number;   // when my timer goes off
  opening: boolean;                                          // I am writing an opening message
  active?: { id: string; startedAt: number; lastAt: number; used: number; max: number;
    heated?: true; moderating?: true };                      // moderating: I opened it, so I run its moderator
  hours: { start: number; end: number; timeZone: string } }  // when timers may open conversations
interface Channel { id: string; kind: "direct"|"group"; mode?: "conversation"; name: string; relayUrl: string;
  members: ChannelMember[]; shareBio: boolean; directLink: "auto"|"off"; allowLocalAddresses: boolean;
  autoReply: boolean; allowedMcpTools: string[]; trust: "standard"|"full"; unread: number; lastSeq: number; createdAt: number;
  heated?: boolean }   // Conversations channels: heated mode (§7.5)
interface OwnerRequest { id: string;
  kind: "peer" | "continue";   // peer: ask_owner (§7.1); continue: the channel's turn budget ran out (§7.2)
  ch: string; channelName: string; from: string; fromName?: string;
  text: string;
  msgId?: string;              // continue: the incoming message that will be answered on approve
  state: "pending"|"approved"|"denied"; createdAt: number; decidedAt?: number }
interface ChannelMessage { id: string; ch: string; from: string; fromName?: string; mine: boolean;
  ts: number; seq?: number; type: string; text?: string; hop?: number; by?: "human"|"agent";
  replyTo?: string; mentions?: string[];   // mentions: identity ids
  status: "pending"|"sent"|"received"|"failed";   // failed: the relay permanently rejected our message (see note); not retried
  final?: boolean; // the sender closed the exchange (§3.1)
  note?: string;   // why an incoming chat got no reply: "not addressed", "hop cap", "rate limited", "auto-reply off",
                   // "conversation ended", "repeated", "budget exhausted" (paused, see OwnerRequest kind "continue"),
                   // "handled by owner" (it woke an owner follow-up, §7.4),
                   // "out of messages", "not in this conversation" (§7.5)
  convo?: { id: string; start?: true; heated?: true; mod?: true };   // Conversations channels (§7.5)
  origin?: "human"|"owner-agent"|"agent-reply"|"agent-followup"|"agent-conversation"|"peer"; // agent-followup: §7.4, agent-conversation: §7.5
  timelineSlot?: number }     // local API/WebSocket only: persistent insertion slot for optimistic ordering; not relayed
interface Transfer { via?: "link"|"croc"; tid: string; ch: string; direction: "out"|"in"; peer: string; peerName?: string;
  name: string; size: number; sha256: string; state: string; attempt: number; initiatedBy: "owner"|"peer-agent"|"owner-agent"|"peer";
  reason?: string;     // free text from whoever initiated it, e.g. the peer agent's justification
  progress?: number;   // fraction 0–1 while sending/receiving, 1 once completed; absent before croc reports any
  error?: string; path?: string; createdAt: number; updatedAt: number; expiresAt: number }
interface OwnerAttachment { id: string; name: string; size: number }
interface OwnerItem { id: string; role: "user"|"assistant"|"tool"|"note"; text: string; ts: number;
  toolName?: string; isError?: boolean;
  attachments?: OwnerAttachment[]; // files attached to this owner message; never a peer transfer
  untrusted?: boolean;    // text written by another person's agent (e.g. a reply to something the owner sent)
  request?: string }      // an ask_owner request card: the OwnerRequest id
interface ChannelMember { features?: string[]; id: string; name?: string; fingerprint: string; me: boolean;
  // Is this member's Spencer reachable through the channel's relay right now (§4.6)?
  //  "online" / "offline": what the relay says. "unknown": we are not connected to that relay, or it is an older relay
  //  without presence. For `me`: "online" when we are connected to the relay, else "offline".
  presence: "online"|"offline"|"unknown";
  lastSeen?: number }   // ms: when the relay last saw it connected (offline: when it disconnected). Absent if unknown.
// A peer is reachable when its presence is "online"; messages to an offline peer wait on the relay (up to the TTL).
interface RelayStatus { url: string;
  connected: boolean;                         // authenticated now
  state: "connected"|"connecting"|"waiting";  // waiting: in backoff until retryAt
  since: number;                              // when `state` last changed (ms)
  lastConnectedAt?: number; retryAt?: number;
  lastError?: string;                         // the last socket error since the last successful connection
  stun?: string; features: string[] }          // relay features from `welcome` ("presence", "ephemeral"); [] for older relays
interface Followup { id: string;
  conversation: "owner"|"channel"; ch?: string;   // ch: the channel, for channel follow-ups
  note: string;                                   // the agent's own words (may be based on untrusted peer input)
  dueAt: number;                                  // fires at the latest then
  state: "pending"|"running"|"done"|"cancelled"|"failed";
  depth: number;                                  // follow-ups in a row before this one
  wakeOnReplyIn?: string;                         // owner: fires early when a peer writes in this channel
  createdAt: number; firedAt?: number; firedBy?: "time"|"reply";
  error?: string }                                // why it failed or was cancelled
interface BioStatus { text: string; maxChars: number;
  sharedChannels: { id: string; name: string; kind: "direct"|"group"; trust: "standard"|"full" }[] }
interface PeerSummary { id: string; fingerprint: string; name: string | null; about: string | null; aboutAt: number | null;
  channels: { id: string; name: string; kind: "direct"|"group"; about: string | null; aboutAt: number | null }[] }
interface McpServer { name: string; transport: "stdio"|"http"; status: "connecting"|"connected"|"error"|"disabled"; error?: string;
  tools: { name: string; remote: string; description?: string; enabled: boolean }[] }   // name as exposed (mcp__<server>__<tool>); remote: the server's own; enabled: not in disabledTools
```

## 9. Daemon config (`<dataDir>/config.json`)

```jsonc
{
  "name": "Alice's Spencer",
  "relay": "wss://spencer.pjalv.com/ws",     // default relay for new invites
  "http": { "port": 7420 },
  "model": { "provider": "anthropic", "modelId": "claude-sonnet-5-5", "apiKeyEnv": "ANTHROPIC_API_KEY" },
  // or: { "provider": "openai-compatible", "baseUrl": "http://localhost:11434/v1", "modelId": "llama3.1", "apiKeyEnv": "OLLAMA_KEY" }
  // or: { "provider": "fake" }   (deterministic, tests)
  "experimental": false,   // SOUL.md and Conversations channels (§7.6)
  "conversationModel": { "provider": "openai", "modelId": "gpt-4o-mini" },   // optional, Conversations channels (§7.5)
  "p2p": { "mode": "files", "hideLocalAddresses": true, "minFileBytes": 4194304, "stun": [] },
  "croc": { "path": "croc", "relay": null, "pass": null, "throttleUpload": null },   // throttleUpload: e.g. "500k"
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    "remote": { "url": "https://example.com/mcp", "headers": {} }
  },
  "policy": { "maxHops": 40, "maxHopsFullTrust": 0, "maxAgentTurns": 20, "maxAgentTurnsFullTrust": 50,
    "repliesPerMinute": 6, "repliesPerHour": 60, "repliesPerDay": 300,
    "repliesPerMinuteFullTrust": 20, "repliesPerHourFullTrust": 200, "repliesPerDayFullTrust": 1000,
    "autoAcceptIncomingFiles": true, "maxIncomingFileBytes": 536870912,
    "requireApprovalForOutgoingFiles": true, "ownerCodingTools": true, "transferTtlHours": 24,
    "maxTransferAttempts": 5, "maxPendingFollowups": 5, "maxFollowupChain": 12,
    "conversationMinMinutes": 30, "conversationMaxMinutes": 60, "conversationMessages": 10,
    "conversationStartHour": 8, "conversationEndHour": 18, "conversationTimeZone": "America/Los_Angeles" }
}
```
The `p2p.mode` is `"files"` or `"off"`. `hideLocalAddresses` controls local ICE candidates;
`minFileBytes` sets the direct-transfer threshold when croc is available. `stun` lists extra
STUN `host:port` addresses, after the relay-advertised address.

Environment variable overrides: `SPENCER_DATA_DIR`, `SPENCER_PORT`, `SPENCER_RELAY`.
`--relay URL` overrides the default relay and is saved on first run. URLs accept HTTP(S) or
WS(S) and are normalized to the WebSocket endpoint.

The data dir is mode 0700. Secrets and databases in it (`identity.json`, `api-token`, `config.json`,
`spencer.sqlite`, `pi.sqlite` and their `-wal`/`-shm` files) are mode 0600, as are `SOUL.md` and `BIO.md` when Spencer writes them.

### Public BIO and peer discovery

BIO is a core feature. `SOUL.md` remains private and experimental. The Bio page publishes the owner's scope. The Peers page and channel Peer Cards display received biographies as safe Markdown.

Channels have `shareBio: boolean`, enabled by default. `PATCH /api/channels/:ch` accepts this field. Disabling sharing sends a hello without `about` to clear the current bio at peers. Peers can retain an older copy. BIO must not contain secrets, private IP addresses, or sensitive paths.

The daemon emits `{type: "bio", bio: BioStatus}` after a BIO save or sharing change. A changed peer biography emits `{type: "peer_bio", ch, id, about, aboutAt}`. Cleared biographies use `about: null`. `aboutAt` is a local receive timestamp in milliseconds. Routine `ChannelMember` payloads omit biography text.

The database stores `channels.share_bio`, `channels.last_hello_about` as a SHA-256 digest, and `members.about_at`. Startup adds missing columns idempotently. BIO changes recheck hellos across channels. Rechecks stagger channels when there are more than 15.

The owner's BIO narrows channel trust rules, including Full Trust. Conversations channels omit that scope restriction. Owner instructions include the published scope. Peer BIO blocks come last in channel instructions, after trust, scope, and Soul. They contain only that channel's member biographies. Every angle bracket in peer text is escaped. Peer self-descriptions never grant permissions or override rules. Direct channels include the complete bio. Groups truncate each biography to 400 UTF-16 code units without splitting surrogate pairs. Incoming BIO changes are stored immediately. Agent refreshes occur at most once per peer per channel every two minutes, with a trailing refresh.

### Owner rules and structured memoir

Memoir is always available. Spencer exposes no agent tool that writes `RULES.md`;
only authenticated Owner HTTP/UI calls and direct local filesystem edits write it.
Peer rules apply only to that peer's direct channels; group rules apply only to that
group chat. Conversations channels omit rules, history, and the `record_memoir_note`
tool. Like `SOUL.md`, rules narrow the channel policy and remain advisory when Owner
coding tools or Full Trust filesystem/T3 MCP servers can access `<dataDir>`.

Rules live at `peers/<peerId>/RULES.md` or `channels/<chId>/RULES.md` under the data
directory. Writes validate identity and membership, cap trimmed UTF-8 text at
2048 bytes, and use private atomic replacement. Empty text removes the file.
Reads of hand-edited files stop at 2048 bytes.

Historical facts live separately in SQLite `memoir_notes`. Each note has `id`,
`scopeKind`, `scopeId`, `sourceCh`, `author` (`owner` or `agent`), `trustAtWrite`,
`askerId`, `text` (1–500 characters), `pinned`, `seen`, and `createdAt` (Unix ms).
Agent notes start unseen and emit a `memoir` event without posting to Owner chat.
They are deduplicated per scope and limited to five per ten minutes. Each scope
retains up to twenty unpinned notes with at most 4000 characters of unpinned text;
oldest unpinned notes are removed first. Pinned notes survive this eviction.

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/api/peers` | `{ peers }`; includes `active`, `hasRules`, `noteCount`, `unseenNotes` and inactive identities with saved data |
| GET | `/api/peers/:id/memoir` | `{ id, name, fingerprint, active, bio, bioAt, rules, maxRulesBytes, notes, channels }`; `?markSeen=1` marks notes seen |
| POST | `/api/peers/:id/memoir/seen` | Marks notes seen |
| PUT | `/api/peers/:id/rules` | `{ text }`; returns updated profile |
| POST | `/api/peers/:id/notes` | `{ text, pinned? }`; returns owner note |
| GET | `/api/channels/:ch/memoir` | `{ ch, name, rules, maxRulesBytes, notes }`; group chats only |
| PUT | `/api/channels/:ch/rules` | `{ text }`; returns updated profile |
| POST | `/api/channels/:ch/notes` | `{ text, pinned? }`; returns owner note |
| PATCH | `/api/memoir/notes/:noteId` | `{ text?, pinned?, seen? }`; returns updated note |
| DELETE | `/api/memoir/notes/:noteId` | Deletes note |

Mutations emit `{ type: "memoir", scopeKind: "peer" | "channel", scopeId }`
on `/api/events`. Owner mutations refresh the affected channels immediately;
agent notes refresh with a 120-second leading and trailing throttle. Leaving a
channel deletes its group rules and notes. Saved peer data remains visible in the
inactive directory until the owner clears it.

Channel agents can call `record_memoir_note({ text })` to record durable facts.
The application derives scope and provenance from the channel and current asker.
This tool cannot write rules. Owner chat can call
`read_peer_profile({ target })` and `add_memoir_note({ target, text, pinned? })`.
Targets require an exact identity ID, fingerprint, or unambiguous name. Ambiguous
names fail with candidate fingerprints/IDs. Owner chat has no rules-writing tool;
the owner uses Peer Card or Group Memoir to edit rules.

Channel prompts include only their own scope's rules and up to 2000 characters of
historical notes (pinned first, then newest). Notes are escaped as untrusted data
at the end of the prompt. A group never receives a member's DM rules or notes.
Owner prompts never automatically include peer or group history.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  b64u,
  deriveChannelKeys,
  fingerprint,
  formatInvite,
  fromB64u,
  generateIdentity,
  identityFromSecret,
  joinProof,
  joinProofMessage,
  newChannelSecret,
  openEnvelope,
  openFrom,
  openMeta,
  pairKey,
  parseBody,
  parseInvite,
  relayAuthMessage,
  sanitizeFileName,
  sealEnvelope,
  sealFor,
  sealMeta,
  signText,
  verifyEnvelope,
  verifyText,
  type Body,
} from "../src/index.ts";

test("identity: sign/verify, fingerprint, roundtrip", () => {
  const a = generateIdentity();
  assert.equal(fromB64u(a.id).length, 32);
  assert.deepEqual(identityFromSecret(a.secret), a);
  const sig = signText(a.secret, relayAuthMessage("nonce"));
  assert.ok(verifyText(a.id, relayAuthMessage("nonce"), sig));
  assert.ok(!verifyText(a.id, relayAuthMessage("other"), sig));
  assert.ok(!verifyText(generateIdentity().id, relayAuthMessage("nonce"), sig));
  assert.match(fingerprint(a.id), /^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
});

test("invite: format/parse roundtrip and relay url derivation", () => {
  const { ch, secret } = newChannelSecret();
  const link = formatInvite("wss://spencer.pjalv.com/ws", ch, secret);
  assert.equal(link, `https://spencer.pjalv.com/i/${ch}#${secret}`);
  const inv = parseInvite(link);
  assert.deepEqual(inv, { ch, secret, origin: "https://spencer.pjalv.com", relayUrl: "wss://spencer.pjalv.com/ws" });
  const local = parseInvite(formatInvite("ws://127.0.0.1:9999/ws", ch, secret));
  assert.equal(local.relayUrl, "ws://127.0.0.1:9999/ws");
  assert.throws(() => parseInvite(`https://x/i/${ch}`));
  assert.throws(() => parseInvite(`https://x/i/short#${secret}`));
  assert.throws(() => parseInvite("not a url"));
});

test("channel keys: deterministic, channel-bound; capability proof verifies", () => {
  const { ch, secret } = newChannelSecret();
  const k1 = deriveChannelKeys(secret, ch);
  const k2 = deriveChannelKeys(secret, ch);
  assert.deepEqual(k1.encKey, k2.encKey);
  assert.equal(k1.capPub, k2.capPub);
  const other = deriveChannelKeys(secret, newChannelSecret().ch);
  assert.notDeepEqual(other.encKey, k1.encKey);
  const me = generateIdentity();
  const proof = joinProof(k1, ch, me.id, "n1");
  assert.ok(verifyText(k1.capPub, joinProofMessage(ch, me.id, "n1"), proof));
  assert.ok(!verifyText(k1.capPub, joinProofMessage(ch, me.id, "n2"), proof));
});

test("envelope: seal/open roundtrip; tamper detection", () => {
  const { ch, secret } = newChannelSecret();
  const keys = deriveChannelKeys(secret, ch);
  const alice = generateIdentity();
  const body: Body = { type: "chat", text: "hi bob", hop: 0, by: "human" };
  const env = sealEnvelope(alice, ch, keys.encKey, body);
  assert.ok(verifyEnvelope(env));
  assert.deepEqual(openEnvelope(env, keys.encKey), body);

  // wrong key
  assert.throws(() => openEnvelope(env, deriveChannelKeys(newChannelSecret().secret, ch).encKey));
  // header tamper breaks signature
  assert.throws(() => openEnvelope({ ...env, ts: env.ts + 1 }, keys.encKey));
  assert.throws(() => openEnvelope({ ...env, ch: newChannelSecret().ch }, keys.encKey));
  // impersonation: swap from + re-sign with another identity -> AEAD fails (aad binds from)
  const mallory = generateIdentity();
  const forged = sealEnvelope(mallory, ch, keys.encKey, body);
  assert.ok(verifyEnvelope(forged));
  assert.equal(forged.from, mallory.id);
  const swapped = { ...env, from: mallory.id };
  assert.ok(!verifyEnvelope(swapped));
  // ciphertext bit-flip
  const ct = fromB64u(env.ct);
  ct[0] ^= 1;
  assert.throws(() => openEnvelope({ ...env, ct: b64u(ct) }, keys.encKey));
});

test("envelope: rejects oversized and invalid bodies", () => {
  const { ch, secret } = newChannelSecret();
  const keys = deriveChannelKeys(secret, ch);
  const a = generateIdentity();
  assert.throws(() => sealEnvelope(a, ch, keys.encKey, { type: "chat", text: "x".repeat(70_000), hop: 0, by: "human" }));
  const bad = sealEnvelope(a, ch, keys.encKey, { type: "chat", text: "x", hop: -1, by: "human" } as Body);
  assert.throws(() => openEnvelope(bad, keys.encKey), /invalid/);
});

test("meta sealing roundtrip", () => {
  const { ch, secret } = newChannelSecret();
  const keys = deriveChannelKeys(secret, ch);
  const me = generateIdentity();
  const sealed = sealMeta(keys, ch, { name: "Friends", kind: "group", createdBy: me.id });
  assert.deepEqual(openMeta(keys, ch, sealed), { name: "Friends", kind: "group", createdBy: me.id });
  assert.throws(() => openMeta(keys, newChannelSecret().ch, sealed));
  // Conversations channels: the mode is kept for groups only.
  const convo = sealMeta(keys, ch, { name: "Debates", kind: "group", createdBy: me.id, mode: "conversation" });
  assert.equal(openMeta(keys, ch, convo).mode, "conversation");
  const direct = sealMeta(keys, ch, { name: "DM", kind: "direct", createdBy: me.id, mode: "conversation" });
  assert.equal(openMeta(keys, ch, direct).mode, undefined);
});

test("pair key: symmetric, third party cannot open", () => {
  const { ch } = newChannelSecret();
  const a = generateIdentity();
  const b = generateIdentity();
  const c = generateIdentity();
  const kab = pairKey(a.secret, b.id, a.id, ch);
  const kba = pairKey(b.secret, a.id, b.id, ch);
  assert.deepEqual(kab, kba);
  const sealed = sealFor(kab, "tid", { code: "1234-abc" });
  assert.deepEqual(openFrom(kba, "tid", sealed), { code: "1234-abc" });
  assert.throws(() => openFrom(pairKey(c.secret, a.id, c.id, ch), "tid", sealed));
  assert.throws(() => openFrom(kba, "other-tid", sealed));
});

test("parseBody validates every type", () => {
  const id = generateIdentity().id;
  const tid = newChannelSecret().ch;
  const sha = "a".repeat(64);
  const ok: unknown[] = [
    { type: "hello", name: "Bob", agent: "spencer/0.1" },
    { type: "chat", text: "hey", hop: 2, by: "agent", replyTo: tid, mentions: [id] },
    { type: "chat", text: "bye", hop: 3, by: "agent", final: true },
    { type: "chat", text: "hot take", hop: 0, by: "agent", convo: { id: tid, start: true } },
    { type: "chat", text: "nope", hop: 1, by: "agent", convo: { id: tid } },
    { type: "chat", text: "spicy", hop: 0, by: "agent", convo: { id: tid, start: true, heated: true } },
    { type: "chat", text: "ok enough", hop: 0, by: "agent", final: true, convo: { id: tid, mod: true } },
    { type: "status", replyTo: tid, state: "input_required", activity: "Waiting for its owner's approval" },
    { type: "status", replyTo: tid, state: "completed" },
    { type: "file_offer", tid, to: id, name: "a.txt", size: 3, sha256: sha, expiresAt: 1 },
    { type: "file_accept", tid, to: id, sealed: "abc" },
    { type: "file_decline", tid, to: id },
    { type: "file_ready", tid, to: id, attempt: 1 },
    { type: "file_retry", tid, to: id, attempt: 2 },
    { type: "file_ack", tid, to: id, ok: true, sha256: sha },
    { type: "file_cancel", tid, to: id, reason: "expired" },
  ];
  for (const b of ok) assert.deepEqual(parseBody(b), b, JSON.stringify(b));
  const bad: unknown[] = [
    null,
    [],
    { type: "nope" },
    { type: "chat", text: "x", hop: 0, by: "god" },
    { type: "chat", text: "x", hop: 1.5, by: "agent" },
    { type: "chat", text: "x", hop: 0, by: "agent", mentions: ["short"] },
    { type: "chat", text: "x", hop: 0, by: "agent", final: "yes" },
    { type: "chat", text: "x", hop: 0, by: "agent", convo: { id: "short" } },
    { type: "chat", text: "x", hop: 0, by: "agent", convo: { id: tid, start: false } },
    { type: "chat", text: "x", hop: 0, by: "agent", convo: { id: tid, heated: 1 } },
    { type: "chat", text: "x", hop: 0, by: "agent", convo: { id: tid, mod: "yes" } },
    { type: "status", replyTo: tid, state: "thinking" },
    { type: "file_offer", tid, to: id, name: "", size: 3, sha256: sha, expiresAt: 1 },
    { type: "file_offer", tid, to: id, name: "a", size: -1, sha256: sha, expiresAt: 1 },
    { type: "file_ready", tid, to: id, attempt: 0 },
    { type: "file_ack", tid, to: id, ok: "yes" },
    { type: "file_ack", tid: "x", to: id, ok: true },
  ];
  for (const b of bad) assert.equal(parseBody(b), null, JSON.stringify(b));
  // final: false is dropped (only `final: true` means anything)
  assert.deepEqual(parseBody({ type: "chat", text: "x", hop: 0, by: "agent", final: false }), { type: "chat", text: "x", hop: 0, by: "agent" });
  // extra fields are stripped
  assert.deepEqual(parseBody({ type: "hello", name: "B", agent: "a", evil: 1 }), { type: "hello", name: "B", agent: "a" });
});
test("parseBody: status bodies", () => {
  const id = "A".repeat(22);
  assert.deepEqual(parseBody({ type: "status", replyTo: id, state: "working", activity: "Thinking…" }), {
    type: "status",
    replyTo: id,
    state: "working",
    activity: "Thinking…",
  });
  assert.deepEqual(parseBody({ type: "status", replyTo: id, state: "done" }), { type: "status", replyTo: id, state: "done" });
  assert.equal(parseBody({ type: "status", replyTo: id, state: "sleeping" }), null);
  assert.equal(parseBody({ type: "status", replyTo: "bad id!", state: "done" }), null);
  assert.equal(parseBody({ type: "status", replyTo: id, state: "working", activity: "x".repeat(201) }), null);
});


test("sanitizeFileName", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "__.._etc_passwd");
  assert.equal(sanitizeFileName(".bashrc"), "_bashrc");
  assert.equal(sanitizeFileName("a\x00b/c.txt"), "a_b_c.txt");
  assert.equal(sanitizeFileName(""), "file");
  assert.equal(sanitizeFileName("ok name.tar.gz"), "ok name.tar.gz");
  assert.ok(sanitizeFileName("x".repeat(300) + ".txt").endsWith(".txt"));
});

test("link bodies, features, encryption and relay URL", async () => {
  const { sealLink, openLink, normalizeRelayUrl, MAX_LINK_SEALED, isLinkBody } = await import("../src/index.ts");
  const to = generateIdentity().id, sid = newChannelSecret().ch;
  const hello = { type: "hello", name: "n", agent: "a", features: ["p2p-files/1"] };
  assert.deepEqual(parseBody(hello), hello);
  for (const features of [null, [""], ["x".repeat(33)], Array(9).fill("x"), [1]]) assert.equal(parseBody({ ...hello, features }), null);
  for (const type of ["link_offer", "link_answer"]) {
    const body = { type, to, sid, sealed: "x" };
    assert.deepEqual(parseBody(body), body);
    assert.ok(isLinkBody(parseBody(body)!));
    for (const patch of [{ to: "bad" }, { sid: "bad" }, { sealed: "" }, { sealed: "x".repeat(MAX_LINK_SEALED + 1) }]) assert.equal(parseBody({ ...body, ...patch }), null);
  }
  assert.deepEqual(parseBody({ type: "link_close", to, sid, reason: "done" }), { type: "link_close", to, sid, reason: "done" });
  assert.equal(parseBody({ type: "link_close", to, sid, reason: "x".repeat(201) }), null);
  assert.equal(parseBody({ type: "file_ready", to, tid: sid, attempt: 1, via: "bad" }), null);
  assert.deepEqual(parseBody({ type: "file_ready", to, tid: sid, attempt: 1, via: "link" }), { type: "file_ready", to, tid: sid, attempt: 1, via: "link" });
  const key = new Uint8Array(32), sealed = sealLink(key, "offer", sid, { ok: true });
  assert.deepEqual(openLink(key, "offer", sid, sealed), { ok: true });
  assert.throws(() => openLink(key, "answer", sid, sealed));
  assert.throws(() => openFrom(key, sid, sealed));
  assert.equal(normalizeRelayUrl(" https://example.com/ "), "wss://example.com/ws");
  assert.equal(normalizeRelayUrl("http://example.com/relay/ws/"), "ws://example.com/relay/ws");
  for (const url of ["bad", "ftp://x", "ws://u:p@x", "ws://x/?a", "ws://x/#a"]) assert.throws(() => normalizeRelayUrl(url));
});

test("parseBody validates typing", () => {
  assert.deepEqual(parseBody({ type: "typing", active: true }), { type: "typing", active: true });
  assert.deepEqual(parseBody({ type: "typing", active: false }), { type: "typing", active: false });
  assert.equal(parseBody({ type: "typing", active: 1 }), null);
  assert.equal(parseBody({ type: "typing" }), null);
});

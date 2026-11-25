import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { relayAt, startNode, tempDir, waitFor, sleep, type TestNode } from "./helpers.ts";
import type { ChannelMessage } from "../../src/contracts.ts";

function msgs(n: TestNode, ch: string): ChannelMessage[] {
  return n.daemon.core.readChannel(ch, 100);
}

test("two daemons: invite, hellos, chat both ways, restart routing, catch-up", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const dirs = ["a", "b"].map((x) => {
    const d = join(t.dir, x);
    mkdirSync(d);
    return d;
  });
  const A = await startNode(dirs[0], relay.url, "Alice");
  const B = await startNode(dirs[1], relay.url, "Bob");
  try {
    // --- invite
    const { link, channel } = await A.daemon.createInvite("direct", "Bob");
    assert.equal(channel.kind, "direct");
    assert.equal(channel.name, "Bob");
    assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${relay.port}/i/${channel.id}#`));
    const chB = await B.daemon.acceptInvite(link);
    assert.equal(chB.id, channel.id);
    // joining twice is a no-op
    assert.equal((await B.daemon.acceptInvite(link)).id, channel.id);
    const ch = channel.id;

    // --- hellos: each side learns the other's name
    await waitFor(() => A.daemon.core.getChannel(ch)?.members.find((m) => !m.me)?.name === "Bob", "A sees Bob");
    await waitFor(() => B.daemon.core.getChannel(ch)?.members.find((m) => !m.me)?.name === "Alice", "B sees Alice");
    assert.equal(A.daemon.core.getChannel(ch)!.name, "Bob");
    assert.equal(B.daemon.core.getChannel(ch)!.name, "Alice");
    const membersA = A.daemon.core.getChannel(ch)!.members;
    assert.equal(membersA.length, 2);
    assert.ok(membersA.some((m) => m.me && m.id === A.daemon.identity.id));
    assert.match(membersA[0].fingerprint, /^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);

    // --- chat A → B
    const sent = A.daemon.sendHuman(ch, "hi bob");
    assert.equal(A.agent().outgoing.length, 0); // reported on a microtask
    await waitFor(() => A.agent().outgoing.length === 1, "onOutgoingChat");
    assert.equal(A.agent().outgoing[0].origin, "human");
    await waitFor(() => B.agent().peerChats.length === 1, "B got chat");
    const inc = B.agent().peerChats[0];
    assert.equal(inc.id, sent.id);
    assert.equal(inc.body.text, "hi bob");
    assert.equal(inc.body.hop, 0);
    assert.equal(inc.body.by, "human");
    assert.equal(inc.from, A.daemon.identity.id);
    assert.equal(inc.fromName, "Alice");
    assert.equal(inc.channelKind, "direct");
    assert.ok(inc.seq > 0);
    await waitFor(() => msgs(A, ch).find((m) => m.id === sent.id)?.status === "sent", "A marked sent");
    const recv = msgs(B, ch).find((m) => m.id === sent.id)!;
    assert.equal(recv.status, "received");
    assert.equal(recv.mine, false);
    assert.equal(recv.text, "hi bob");
    assert.equal(B.daemon.core.getChannel(ch)!.unread, 1);

    // --- chat B → A, as an agent reply with replyTo (replyToOrigin resolved on A)
    B.agent().onChat = () => ({ note: "not addressed" });
    const reply = B.daemon.core.sendChat(ch, {
      text: "hello alice",
      hop: 1,
      by: "agent",
      origin: "agent-reply",
      replyTo: sent.id,
      mentions: [A.daemon.identity.id],
      idempotencyKey: `reply:${sent.id}`,
    });
    const again = B.daemon.core.sendChat(ch, { text: "dup", hop: 1, by: "agent", origin: "agent-reply", idempotencyKey: `reply:${sent.id}` });
    assert.equal(again.id, reply.id);
    await waitFor(() => A.agent().peerChats.length === 1, "A got reply");
    const r = A.agent().peerChats[0];
    assert.equal(r.body.text, "hello alice");
    assert.equal(r.body.replyTo, sent.id);
    assert.deepEqual(r.body.mentions, [A.daemon.identity.id]);
    assert.equal(r.replyToOrigin, "human");
    assert.equal(r.replyToText, "hi bob");
    assert.equal(B.agent().outgoing.length, 0); // agent-reply is not echoed to onOutgoingChat
    await sleep(100);
    assert.equal(A.agent().peerChats.length, 1);

    // --- B's agent fails for one message (crash before hand-off); after restart it is routed once
    let failNext = true;
    B.agent().onChat = () => {
      if (failNext) {
        failNext = false;
        throw new Error("simulated crash");
      }
      return {};
    };
    const m2 = A.daemon.sendHuman(ch, "second");
    await waitFor(
      () => (B.daemon.db.prepare("SELECT routed FROM messages WHERE id = ?").get(m2.id) as { routed: number } | undefined)?.routed === 0,
      "m2 stored unrouted",
    );
    await B.restart();
    const ids = () => B.agents.flatMap((a) => a.peerChats.map((c) => c.id));
    await waitFor(() => ids().includes(m2.id), "m2 routed after restart");
    // --- catch-up: B stopped, A sends two messages, B starts and receives them
    await B.daemon.stop();
    const c1 = A.daemon.sendHuman(ch, "while you were out 1");
    const c2 = A.daemon.sendHuman(ch, "while you were out 2");
    await waitFor(() => msgs(A, ch).filter((m) => m.mine && m.status === "sent").length === 4, "A sent all");
    await B.restart(); // stop() on a stopped daemon is a no-op
    await waitFor(() => ids().includes(c1.id) && ids().includes(c2.id), "catch-up delivered");
    // Order preserved, every message routed exactly once across all restarts.
    const all = ids();
    assert.deepEqual(all, [sent.id, m2.id, c1.id, c2.id]);
    assert.equal(new Set(all).size, all.length);
    assert.deepEqual(
      msgs(B, ch).filter((m) => !m.mine).map((m) => m.text),
      ["hi bob", "second", "while you were out 1", "while you were out 2"],
    );
    // note from the agent is stored on the message
    B.agent().onChat = () => ({ note: "hop cap" });
    const m5 = A.daemon.sendHuman(ch, "noted");
    await waitFor(() => msgs(B, ch).find((m) => m.id === m5.id)?.note === "hop cap", "note stored");

    // --- rename: B restarts under a new name and re-greets, so A learns it
    await B.daemon.stop();
    const B2 = await startNode(dirs[1], relay.url, "Robert");
    try {
      await waitFor(() => A.daemon.core.getChannel(ch)?.members.find((m) => !m.me)?.name === "Robert", "A sees the new name");
    } finally {
      await B2.daemon.stop();
    }
  } finally {
    await A.daemon.stop();
    await B.daemon.stop();
    await relay.close();
    t.cleanup();
  }
});

test("group: three daemons, a message fans out to both others", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const nodes: TestNode[] = [];
  try {
    for (const name of ["Ann", "Ben", "Cat"]) {
      const d = join(t.dir, name);
      mkdirSync(d);
      nodes.push(await startNode(d, relay.url, name));
    }
    const [A, B, C] = nodes;
    const { link, channel } = await A.daemon.createInvite("group", "Friends");
    await B.daemon.acceptInvite(link);
    await C.daemon.acceptInvite(link);
    const ch = channel.id;
    for (const n of nodes) {
      await waitFor(
        () => {
          const c = n.daemon.core.getChannel(ch);
          return c && c.members.length === 3 && c.members.every((m) => m.name);
        },
        `${n.daemon.identity.name} sees all names`,
      );
      assert.equal(n.daemon.core.getChannel(ch)!.name, "Friends");
    }
    const m = B.daemon.sendHuman(ch, "hello group", [C.daemon.identity.id]);
    await waitFor(() => A.agent().peerChats.some((x) => x.id === m.id), "A got it");
    await waitFor(() => C.agent().peerChats.some((x) => x.id === m.id), "C got it");
    const atC = C.agent().peerChats.find((x) => x.id === m.id)!;
    assert.equal(atC.channelKind, "group");
    assert.equal(atC.channelName, "Friends");
    assert.equal(atC.fromName, "Ben");
    assert.deepEqual(atC.body.mentions, [C.daemon.identity.id]);
    assert.equal(B.agent().peerChats.length, 0);

    // leave: C leaves, others see it
    await C.daemon.leave(ch);
    assert.equal(C.daemon.core.getChannel(ch), undefined);
    await waitFor(() => A.daemon.core.getChannel(ch)!.members.length === 2, "A sees C left");
  } finally {
    for (const n of nodes) await n.daemon.stop();
    await relay.close();
    t.cleanup();
  }
});

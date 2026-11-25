import { isB64uId } from "./encoding.ts";

export const P2P_FILES_FEATURE = "p2p-files/1";
export const MAX_LINK_SEALED = 16 * 1024;
export const MAX_CHAT_TEXT = 16_000;
export const AGENT_VERSION = "spencer/0.1";

export const MAX_ABOUT = 2000;

/** Truncate by UTF-16 code units without cutting a surrogate pair. */
export function truncateUtf16(s: string, max: number): string {
  const end = Math.max(0, Math.floor(max));
  if (s.length <= end) return s;
  const code = s.charCodeAt(end - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff && s.charCodeAt(end) >= 0xdc00 && s.charCodeAt(end) <= 0xdfff ? end - 1 : end);
}

export type HelloBody = { type: "hello"; name: string; about?: string; agent: string; features?: string[] };
export type ChatBody = {
  type: "chat";
  text: string;
  hop: number;
  by: "human" | "agent";
  replyTo?: string;
  mentions?: string[];
  /**
   * The sender ends the exchange: no answer expected. Receivers do not auto-reply to an agent message marked final.
   * Older Spencers ignore the field (parseBody keeps only known fields), so it is backward compatible.
   */
  final?: boolean;
  /**
   * Conversations channels: the conversation this message belongs to; `start` marks the opening message of a new one.
   * Older Spencers drop the field (see `final`).
   */
  convo?: ConvoRef;
};
/**
 * `heated`: the opener's Spencer runs this conversation in heated mode (spicy debate, with a moderator).
 * `mod`: the message comes from the moderator (it ends the conversation; sent with `final`).
 */
export type ConvoRef = { id: string; start?: true; heated?: true; mod?: true };
export type FileOfferBody = {
  type: "file_offer";
  tid: string;
  to: string;
  name: string;
  size: number;
  sha256: string;
  expiresAt: number;
};
export type FileAcceptBody = { type: "file_accept"; tid: string; to: string; sealed: string };
export type FileDeclineBody = { type: "file_decline"; tid: string; to: string; reason?: string };
export type FileReadyBody = { type: "file_ready"; tid: string; to: string; attempt: number; via?: "link" };
export type FileRetryBody = { type: "file_retry"; tid: string; to: string; attempt: number };
export type FileAckBody = { type: "file_ack"; tid: string; to: string; ok: boolean; sha256?: string; reason?: string };
export type FileCancelBody = { type: "file_cancel"; tid: string; to: string; reason: string };

export type FileBody =
  | FileOfferBody
  | FileAcceptBody
  | FileDeclineBody
  | FileReadyBody
  | FileRetryBody
  | FileAckBody
  | FileCancelBody;

/**
 * Ephemeral progress of the work on message `replyTo` (receivers drop stale ones). Older Spencers that don't know it
 * drop the envelope as an unknown body, which is harmless.
 *
 * States, shaped like A2A task states with `replyTo` as the task id: "working" (a run is under way; `activity` says
 * what it does), "done" (the run ended; its answer, if any, is the reply), "input_required" (waiting for the owner to
 * approve), "completed" / "failed" (the owner approved and the task finished, or failed or was declined). Spencers
 * that only know working/done drop the newer states as an invalid body.
 */
export const STATUS_STATES = ["working", "done", "input_required", "completed", "failed"] as const;
export type StatusState = (typeof STATUS_STATES)[number];
export type StatusBody = { type: "status"; replyTo: string; state: StatusState; activity?: string };

export type LinkOfferBody = { type: "link_offer"; to: string; sid: string; sealed: string };
export type LinkAnswerBody = { type: "link_answer"; to: string; sid: string; sealed: string };
export type LinkCloseBody = { type: "link_close"; to: string; sid: string; reason?: string };
export type LinkBody = LinkOfferBody | LinkAnswerBody | LinkCloseBody;
export const LINK_BODY_TYPES = new Set(["link_offer", "link_answer", "link_close"]);
export function isLinkBody(b: Body): b is LinkBody { return LINK_BODY_TYPES.has(b.type); }

export type TypingBody = { type: "typing"; active: boolean };
export type Body = HelloBody | ChatBody | FileBody | StatusBody | TypingBody | LinkBody;

export const FILE_BODY_TYPES = new Set([
  "file_offer",
  "file_accept",
  "file_decline",
  "file_ready",
  "file_retry",
  "file_ack",
  "file_cancel",
]);

export function isFileBody(b: Body): b is FileBody {
  return FILE_BODY_TYPES.has(b.type);
}

const isStr = (v: unknown, max = 1000): v is string => typeof v === "string" && v.length <= max;
const isInt = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const isId32 = (v: unknown): v is string => isB64uId(v, 32);
const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** Validates an untrusted decrypted body. Returns null for unknown or malformed bodies. */
/** A conversation reference with only its known fields. */
export function convoRef(c: Record<string, unknown>): ConvoRef {
  return {
    id: c.id as string,
    ...(c.start === true ? { start: true as const } : {}),
    ...(c.heated === true ? { heated: true as const } : {}),
    ...(c.mod === true ? { mod: true as const } : {}),
  };
}

export function parseBody(raw: unknown): Body | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  switch (b.type) {
    case "typing":
      return typeof b.active === "boolean" ? { type: "typing", active: b.active } : null;
    case "hello":
      if (!isStr(b.name, 200) || !isStr(b.agent, 100)) return null;
      if (b.about !== undefined && !isStr(b.about, MAX_ABOUT)) return null;
      if (b.features !== undefined && (!Array.isArray(b.features) || b.features.length > 8 || !b.features.every((f: unknown) => isStr(f, 32) && f.length > 0))) return null;
      return { type: "hello", name: b.name, agent: b.agent, ...(b.features !== undefined ? { features: b.features as string[] } : {}), ...(b.about !== undefined ? { about: b.about as string } : {}) };
    case "chat": {
      if (!isStr(b.text, MAX_CHAT_TEXT) || !isInt(b.hop) || (b.by !== "human" && b.by !== "agent")) return null;
      if (b.replyTo !== undefined && !isB64uId(b.replyTo)) return null;
      if (b.mentions !== undefined && (!Array.isArray(b.mentions) || b.mentions.length > 64 || !b.mentions.every(isId32)))
        return null;
      if (b.final !== undefined && typeof b.final !== "boolean") return null;
      const convo = b.convo as Record<string, unknown> | undefined;
      if (convo !== undefined && (typeof convo !== "object" || convo === null || !isB64uId(convo.id) || (["start", "heated", "mod"] as const).some((k) => convo[k] !== undefined && convo[k] !== true))) return null;
      const out: ChatBody = { type: "chat", text: b.text, hop: b.hop, by: b.by };
      if (b.replyTo !== undefined) out.replyTo = b.replyTo as string;
      if (b.mentions !== undefined) out.mentions = b.mentions as string[];
      if (b.final === true) out.final = true;
      if (convo) out.convo = convoRef(convo);
      return out;
    }
    case "status": {
      if (!isB64uId(b.replyTo) || !(STATUS_STATES as readonly unknown[]).includes(b.state)) return null;
      if (b.activity !== undefined && !isStr(b.activity, 200)) return null;
      return { type: "status", replyTo: b.replyTo, state: b.state as StatusState, ...(b.activity !== undefined ? { activity: b.activity as string } : {}) };
    }
  }
  if (LINK_BODY_TYPES.has(b.type as string)) {
    if (!isId32(b.to) || !isB64uId(b.sid)) return null;
    if (b.type === "link_close") {
      if (b.reason !== undefined && !isStr(b.reason, 200)) return null;
      return { type: "link_close", to: b.to, sid: b.sid, ...(b.reason !== undefined ? { reason: b.reason as string } : {}) };
    }
    if (!isStr(b.sealed, MAX_LINK_SEALED) || !b.sealed.length) return null;
    return { type: b.type as "link_offer" | "link_answer", to: b.to, sid: b.sid, sealed: b.sealed };
  }
  if (!FILE_BODY_TYPES.has(b.type as string)) return null;
  if (!isB64uId(b.tid) || !isId32(b.to)) return null;
  const base = { tid: b.tid as string, to: b.to as string };
  switch (b.type) {
    case "file_offer":
      if (!isStr(b.name, 255) || b.name.length === 0 || !isInt(b.size) || !isSha(b.sha256) || !isInt(b.expiresAt)) return null;
      return { type: "file_offer", ...base, name: b.name, size: b.size, sha256: b.sha256, expiresAt: b.expiresAt };
    case "file_accept":
      if (!isStr(b.sealed, 1000)) return null;
      return { type: "file_accept", ...base, sealed: b.sealed };
    case "file_decline":
      if (b.reason !== undefined && !isStr(b.reason)) return null;
      return { type: "file_decline", ...base, ...(b.reason !== undefined ? { reason: b.reason as string } : {}) };
    case "file_ready":
      if (!isInt(b.attempt, 1) || (b.via !== undefined && b.via !== "link")) return null;
      return { type: "file_ready", ...base, attempt: b.attempt, ...(b.via === "link" ? { via: "link" } : {}) };
    case "file_retry":
      if (!isInt(b.attempt, 1)) return null;
      return { type: b.type, ...base, attempt: b.attempt };
    case "file_ack":
      if (typeof b.ok !== "boolean") return null;
      if (b.sha256 !== undefined && !isSha(b.sha256)) return null;
      if (b.reason !== undefined && !isStr(b.reason)) return null;
      return {
        type: "file_ack",
        ...base,
        ok: b.ok,
        ...(b.sha256 !== undefined ? { sha256: b.sha256 as string } : {}),
        ...(b.reason !== undefined ? { reason: b.reason as string } : {}),
      };
    case "file_cancel":
      if (!isStr(b.reason)) return null;
      return { type: "file_cancel", ...base, reason: b.reason };
  }
  return null;
}

/** Sanitizes a peer-supplied file name for local storage. */
export function sanitizeFileName(name: string): string {
  let n = name.normalize("NFC").replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_").trim();
  n = n.replace(/^\.+/, "_");
  if (n.length === 0) n = "file";
  if (n.length > 200) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : "";
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n;
}

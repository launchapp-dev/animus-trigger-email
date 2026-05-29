// Pure, side-effect-free helpers that turn a parsed inbound message
// (`mailparser.ParsedMail`-shaped) into the `email.received` TriggerEvent
// payload the host expects. Kept separate from `imap-watcher.ts` so it can be
// unit-tested without spinning up a real IMAP connection.

import type { AddressObject, ParsedMail } from "mailparser";

/** Wire kind emitted for every inbound email. */
export const KIND_EMAIL_RECEIVED = "email.received";

/** Hint the host's event router consumes to decide downstream routing. */
export const ACTION_HINT_CREATE_TASK = "create_task";

export interface InboundAddress {
  name?: string;
  address: string;
}

export interface InboundAttachmentMeta {
  filename: string | null;
  content_type: string | null;
  size: number | null;
  content_id: string | null;
}

export interface InboundPayload {
  from: InboundAddress | null;
  to: InboundAddress[];
  cc: InboundAddress[];
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  date: string | null;
  attachments_meta: InboundAttachmentMeta[];
}

export interface InboundEvent {
  id: string;
  occurred_at: string;
  kind: string;
  payload: InboundPayload;
  subject_id: string | null;
  action_hint: string;
}

/** Build a stable event id from the Message-ID header, falling back to the
 *  IMAP UID when the header is missing/malformed. */
export function buildInboundEventId(
  parsed: Pick<ParsedMail, "messageId">,
  fallbackUid: number | string,
): string {
  const raw = parsed.messageId;
  if (typeof raw === "string" && raw.length > 0) {
    // Strip surrounding angle brackets per RFC 5322 so the id is predictable
    // for downstream dedup and easy to interpolate into reply headers.
    const stripped = raw.replace(/^<+/, "").replace(/>+$/, "");
    if (stripped.length > 0) return `email:${stripped}`;
  }
  return `email:uid-${String(fallbackUid)}`;
}

function normalizeAddresses(field: AddressObject | AddressObject[] | undefined): InboundAddress[] {
  if (!field) return [];
  const arr = Array.isArray(field) ? field : [field];
  const out: InboundAddress[] = [];
  for (const obj of arr) {
    const list = obj.value ?? [];
    for (const item of list) {
      if (typeof item.address === "string" && item.address.length > 0) {
        const entry: InboundAddress = { address: item.address };
        if (typeof item.name === "string" && item.name.length > 0) entry.name = item.name;
        out.push(entry);
      }
    }
  }
  return out;
}

function normalizeReferences(refs: ParsedMail["references"]): string[] {
  if (!refs) return [];
  const list = Array.isArray(refs) ? refs : [refs];
  const out: string[] = [];
  for (const r of list) {
    if (typeof r !== "string") continue;
    const stripped = r.replace(/^<+/, "").replace(/>+$/, "");
    if (stripped.length > 0) out.push(stripped);
  }
  return out;
}

/**
 * Translate a parsed inbound message into the wire payload the host receives.
 * No side effects, no logging, no network — pure mapping.
 */
export function buildInboundPayload(parsed: ParsedMail): InboundPayload {
  const fromList = normalizeAddresses(parsed.from);
  const from = fromList[0] ?? null;
  const toList = normalizeAddresses(parsed.to);
  const ccList = normalizeAddresses(parsed.cc);

  const inReplyToRaw = parsed.inReplyTo;
  const inReplyTo =
    typeof inReplyToRaw === "string" ? inReplyToRaw.replace(/^<+/, "").replace(/>+$/, "") : null;

  const attachmentsMeta: InboundAttachmentMeta[] = (parsed.attachments ?? []).map((a) => ({
    filename: typeof a.filename === "string" ? a.filename : null,
    content_type: typeof a.contentType === "string" ? a.contentType : null,
    size: typeof a.size === "number" ? a.size : null,
    content_id: typeof a.contentId === "string" ? a.contentId : null,
  }));

  const messageId =
    typeof parsed.messageId === "string" && parsed.messageId.length > 0
      ? parsed.messageId.replace(/^<+/, "").replace(/>+$/, "")
      : null;

  return {
    from,
    to: toList,
    cc: ccList,
    subject: typeof parsed.subject === "string" ? parsed.subject : null,
    body_text: typeof parsed.text === "string" ? parsed.text : null,
    body_html: typeof parsed.html === "string" ? parsed.html : null,
    message_id: messageId,
    in_reply_to: inReplyTo && inReplyTo.length > 0 ? inReplyTo : null,
    references: normalizeReferences(parsed.references),
    date: parsed.date instanceof Date ? parsed.date.toISOString() : null,
    attachments_meta: attachmentsMeta,
  };
}

/** Build the full inbound TriggerEvent. */
export function buildInboundEvent(parsed: ParsedMail, uid: number | string): InboundEvent {
  const payload = buildInboundPayload(parsed);
  const occurredAt = parsed.date instanceof Date ? parsed.date.toISOString() : new Date().toISOString();
  return {
    id: buildInboundEventId(parsed, uid),
    occurred_at: occurredAt,
    kind: KIND_EMAIL_RECEIVED,
    payload,
    subject_id: null,
    action_hint: ACTION_HINT_CREATE_TASK,
  };
}

/**
 * Build the params for a `trigger/event` notification.
 *
 * The wire shape is `{ id, event }` where `id` echoes the originating
 * `trigger/watch` request id and `event` is a full `TriggerEvent` (`event.id`
 * is the event's own stable id used for dedup/ack — there is NO `event_id`
 * field on the wire). Authoritative sources:
 *
 *   - animus-protocol/spec.md §7.3 "trigger/event (notification)"
 *   - animus-protocol/animus-trigger-protocol/src/lib.rs `pub struct TriggerEvent`
 *     (fields: id, occurred_at, kind, payload, subject_id, action_hint)
 *   - animus-protocol/animus-plugin-runtime/src/lib.rs — the Rust runtime
 *     literally builds `payload.insert("id", request_id)` +
 *     `payload.insert("event", event_value)` for every emit
 *
 * Get this wrong and events arrive without a stream to route into.
 */
export function buildTriggerEventNotificationParams(
  watchRequestId: string | number | null,
  event: InboundEvent,
): { id: string | number | null; event: InboundEvent } {
  return { id: watchRequestId, event };
}

/** Apply the optional Subject regex filter. Returns true when the message
 *  should be emitted (no filter set → always true). */
export function passesSubjectFilter(parsed: Pick<ParsedMail, "subject">, filter: RegExp | null): boolean {
  if (filter === null) return true;
  const subject = typeof parsed.subject === "string" ? parsed.subject : "";
  return filter.test(subject);
}

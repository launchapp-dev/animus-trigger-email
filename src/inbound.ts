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

/**
 * Flat TriggerEvent shape matching the live Rust deserializer in
 * `crates/animus-plugin-protocol/src/lib.rs` (`pub struct TriggerEvent`) and the
 * supervisor at `crates/orchestrator-daemon-runtime/src/schedule/trigger_supervisor.rs:289`,
 * which calls `serde_json::from_value::<TriggerEvent>(notification.params)` —
 * so `params` IS the TriggerEvent (NOT a `{ id, event }` wrapper). Sibling
 * plugins (Discord, Telegram, SMS-Twilio) all use this flat shape.
 */
export interface InboundEvent {
  event_id: string;
  trigger_id: string | null;
  subject_id: string | null;
  subject_kind: string | null;
  action_hint: string | null;
  payload: InboundEventPayload;
}

/** Inner payload — carries the parsed-mail data plus envelope metadata that
 *  used to live as siblings of `payload` (kind, occurred_at) so workflows can
 *  still read them downstream. */
export interface InboundEventPayload extends InboundPayload {
  kind: string;
  occurred_at: string;
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

/** Build the full inbound TriggerEvent in the flat wire shape consumed by the
 *  daemon's trigger supervisor. `triggerId` is the logical trigger id from the
 *  project's workflow YAML (passed through from `trigger/watch`); pass `null`
 *  when it's not available. */
export function buildInboundEvent(
  parsed: ParsedMail,
  uid: number | string,
  triggerId: string | null = null,
): InboundEvent {
  const payload = buildInboundPayload(parsed);
  const occurredAt = parsed.date instanceof Date ? parsed.date.toISOString() : new Date().toISOString();
  return {
    event_id: buildInboundEventId(parsed, uid),
    trigger_id: triggerId,
    subject_id: null,
    subject_kind: null,
    action_hint: ACTION_HINT_CREATE_TASK,
    payload: {
      ...payload,
      kind: KIND_EMAIL_RECEIVED,
      occurred_at: occurredAt,
    },
  };
}

/**
 * Build the params for a `trigger/event` notification.
 *
 * The wire shape is the flat `TriggerEvent` directly — params IS the event.
 * Authoritative sources (verified against live runtime):
 *
 *   - crates/orchestrator-daemon-runtime/src/schedule/trigger_supervisor.rs:289
 *     `serde_json::from_value::<TriggerEvent>(notification.params)`
 *   - crates/animus-plugin-protocol/src/lib.rs `pub struct TriggerEvent`
 *     (fields: event_id, trigger_id, subject_id, subject_kind, action_hint, payload)
 *
 * The watch request id is no longer echoed on the wire — the daemon broadcasts
 * to a single subscription per plugin, so correlation by request id is not
 * needed. The `{ id, event }` wrapper documented in stale spec.md §7.3 is
 * silently dropped by the supervisor. Sibling plugins (Discord, Telegram,
 * SMS-Twilio) all use this flat shape.
 */
export function buildTriggerEventNotificationParams(event: InboundEvent): InboundEvent {
  return event;
}

/** Apply the optional Subject regex filter. Returns true when the message
 *  should be emitted (no filter set → always true). */
export function passesSubjectFilter(parsed: Pick<ParsedMail, "subject">, filter: RegExp | null): boolean {
  if (filter === null) return true;
  const subject = typeof parsed.subject === "string" ? parsed.subject : "";
  return filter.test(subject);
}

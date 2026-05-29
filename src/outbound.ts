// SMTP send paths.
//
// The threading-header shaping (`buildReplyHeaders`) is the subtle bit: Gmail
// and Outlook only thread a reply when ALL of the following hold:
//
//   1. `In-Reply-To` contains the original Message-ID (wrapped in angle
//      brackets per RFC 5322).
//   2. `References` is the original References list + the original Message-ID,
//      space-separated, each wrapped in angle brackets. If the original had no
//      References, it's just `<original-message-id>`.
//   3. The Subject starts with "Re: " (case-insensitive). If the original
//      already starts with "Re: " we DO NOT double-prefix.
//
// The header builder is exported separately so unit tests can verify all three
// guarantees without mocking nodemailer.

import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";

import type { EmailConfig } from "./config.js";

export interface ReplyHeaders {
  inReplyTo: string;
  references: string;
  subject: string;
}

/** Wrap a bare Message-ID with angle brackets if it isn't already wrapped. */
function ensureAngled(id: string): string {
  let v = id.trim();
  if (v.length === 0) return v;
  if (!v.startsWith("<")) v = `<${v}`;
  if (!v.endsWith(">")) v = `${v}>`;
  return v;
}

/** Strip surrounding angle brackets to compare bare ids. */
function bareId(id: string): string {
  return id.trim().replace(/^<+/, "").replace(/>+$/, "");
}

/**
 * Shape the In-Reply-To / References / Subject headers for a reply.
 *
 * @param originalMessageId  The Message-ID of the message being replied to,
 *                           with or without surrounding angle brackets.
 * @param originalReferences Any existing References list from the original
 *                           message; entries may be with or without brackets.
 * @param originalSubject    Subject of the original message.
 */
export function buildReplyHeaders(
  originalMessageId: string,
  originalReferences: string[],
  originalSubject: string,
): ReplyHeaders {
  if (!originalMessageId || originalMessageId.trim().length === 0) {
    throw new Error("buildReplyHeaders: originalMessageId is required");
  }
  const angled = ensureAngled(originalMessageId);
  const bareOriginal = bareId(originalMessageId);

  // Compose References: existing refs (deduped, preserving order) + original
  // message id appended last. Per RFC 5322 §3.6.4 the parent message goes at
  // the end of References.
  const seen = new Set<string>();
  const refsAngled: string[] = [];
  for (const r of originalReferences) {
    if (typeof r !== "string") continue;
    const bare = bareId(r);
    if (bare.length === 0) continue;
    if (seen.has(bare)) continue;
    seen.add(bare);
    refsAngled.push(ensureAngled(bare));
  }
  if (!seen.has(bareOriginal)) {
    refsAngled.push(angled);
  }

  const trimmed = (originalSubject ?? "").trim();
  // Case-insensitive: any of "Re:", "RE:", "re:" already prefixed counts.
  const alreadyRe = /^re:\s*/i.test(trimmed);
  const subject = alreadyRe ? trimmed : `Re: ${trimmed}`;

  return {
    inReplyTo: angled,
    references: refsAngled.join(" "),
    subject,
  };
}

/** Compose the subject for a forwarded message. */
export function buildForwardSubject(originalSubject: string): string {
  const trimmed = (originalSubject ?? "").trim();
  if (/^fwd?:\s*/i.test(trimmed)) return trimmed;
  return `Fwd: ${trimmed}`;
}

export interface SendReplyParams {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  text?: string;
  html?: string;
  in_reply_to: string;
  references?: string[];
  original_subject: string;
  from?: string;
}

export interface SendNewParams {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
}

export interface ForwardParams {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  original_subject: string;
  original_body_text?: string;
  original_body_html?: string;
  original_from?: string;
  original_date?: string;
  commentary?: string;
  from?: string;
}

export interface SendResult {
  message_id: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

/** Build the nodemailer transport. Kept as a factory so tests can swap it.
 *
 *  Security: on the standard submission port 587 we require STARTTLS before
 *  sending credentials. Without `requireTLS`, nodemailer will fall back to
 *  plaintext AUTH if the server fails to advertise STARTTLS — which leaks the
 *  mailbox password. Implicit-TLS (port 465 / `secure=true`) is already
 *  encrypted from the first byte. */
export function createTransport(cfg: EmailConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    requireTLS: !cfg.smtp.secure,
    auth: {
      user: cfg.smtp.user,
      pass: cfg.smtp.pass,
    },
  });
}

function ensureAddressed(field: string | string[] | undefined): string[] {
  if (field === undefined) return [];
  return Array.isArray(field) ? field : [field];
}

async function performSend(transport: Transporter, mail: SendMailOptions): Promise<SendResult> {
  const info = await transport.sendMail(mail);
  return {
    message_id: typeof info.messageId === "string" ? info.messageId : "",
    accepted: (info.accepted ?? []).map((a: unknown) =>
      typeof a === "string" ? a : (a as { address?: string }).address ?? "",
    ),
    rejected: (info.rejected ?? []).map((a: unknown) =>
      typeof a === "string" ? a : (a as { address?: string }).address ?? "",
    ),
    response: typeof info.response === "string" ? info.response : "",
  };
}

export async function sendReply(
  transport: Transporter,
  cfg: EmailConfig,
  params: SendReplyParams,
): Promise<SendResult> {
  const headers = buildReplyHeaders(params.in_reply_to, params.references ?? [], params.original_subject);
  const mail: SendMailOptions = {
    from: params.from ?? cfg.fromAddress,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: headers.subject,
    text: params.text,
    html: params.html,
    inReplyTo: headers.inReplyTo,
    references: headers.references,
  };
  return performSend(transport, mail);
}

export async function sendNew(
  transport: Transporter,
  cfg: EmailConfig,
  params: SendNewParams,
): Promise<SendResult> {
  const mail: SendMailOptions = {
    from: params.from ?? cfg.fromAddress,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    text: params.text,
    html: params.html,
  };
  return performSend(transport, mail);
}

export async function forward(
  transport: Transporter,
  cfg: EmailConfig,
  params: ForwardParams,
): Promise<SendResult> {
  const subject = buildForwardSubject(params.original_subject);
  const header = [
    "---------- Forwarded message ----------",
    params.original_from ? `From: ${params.original_from}` : null,
    params.original_date ? `Date: ${params.original_date}` : null,
    `Subject: ${params.original_subject ?? ""}`,
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const text =
    [params.commentary ?? "", params.commentary ? "" : null, header, params.original_body_text ?? ""]
      .filter((seg): seg is string => seg !== null)
      .join("\n");

  const html = params.original_body_html
    ? `${params.commentary ? `<p>${escapeHtml(params.commentary)}</p>` : ""}<hr>${params.original_body_html}`
    : undefined;

  const mail: SendMailOptions = {
    from: params.from ?? cfg.fromAddress,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject,
    text,
    html,
  };
  // ensureAddressed kept to satisfy strict lint; not directly used in the
  // SendMailOptions shape since nodemailer accepts string|string[] natively.
  void ensureAddressed;
  return performSend(transport, mail);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

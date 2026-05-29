import { describe, it, expect } from "vitest";

import {
  buildInboundEvent,
  buildInboundEventId,
  buildInboundPayload,
  buildTriggerEventNotificationParams,
  passesSubjectFilter,
  KIND_EMAIL_RECEIVED,
  ACTION_HINT_CREATE_TASK,
} from "./inbound.js";
import { buildForwardSubject, buildReplyHeaders } from "./outbound.js";
import { loadConfigFromEnv } from "./config.js";

// Minimal stand-in for mailparser.ParsedMail that satisfies the fields we use.
function fakeParsed(overrides: Record<string, unknown> = {}): {
  // narrow shape — same surface buildInbound* uses
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  messageId?: unknown;
  inReplyTo?: unknown;
  references?: unknown;
  date?: unknown;
  attachments?: unknown;
} {
  return {
    from: { value: [{ address: "alice@example.com", name: "Alice" }] },
    to: { value: [{ address: "bot@example.com" }] },
    cc: undefined,
    subject: "hello",
    text: "hi there",
    html: "<p>hi there</p>",
    messageId: "<orig-001@example.com>",
    inReplyTo: undefined,
    references: undefined,
    date: new Date("2026-01-15T10:30:00.000Z"),
    attachments: [],
    ...overrides,
  };
}

describe("buildReplyHeaders (thread-shaping invariants)", () => {
  it("wraps the original Message-ID in angle brackets for In-Reply-To", () => {
    const headers = buildReplyHeaders("orig-001@example.com", [], "Hello");
    expect(headers.inReplyTo).toBe("<orig-001@example.com>");
  });

  it("accepts an already-angled Message-ID without double-wrapping", () => {
    const headers = buildReplyHeaders("<orig-001@example.com>", [], "Hello");
    expect(headers.inReplyTo).toBe("<orig-001@example.com>");
  });

  it("appends the original Message-ID to References as the last entry", () => {
    const headers = buildReplyHeaders(
      "orig-003@example.com",
      ["<orig-001@example.com>", "<orig-002@example.com>"],
      "Hello",
    );
    expect(headers.references).toBe(
      "<orig-001@example.com> <orig-002@example.com> <orig-003@example.com>",
    );
  });

  it("does not duplicate the original Message-ID in References", () => {
    const headers = buildReplyHeaders(
      "orig-001@example.com",
      ["orig-001@example.com"],
      "Hello",
    );
    expect(headers.references).toBe("<orig-001@example.com>");
  });

  it("uses bare original Message-ID alone when no existing References", () => {
    const headers = buildReplyHeaders("orig-001@example.com", [], "Hello");
    expect(headers.references).toBe("<orig-001@example.com>");
  });

  it("prefixes Subject with 'Re: ' when missing", () => {
    expect(buildReplyHeaders("a@b", [], "hello").subject).toBe("Re: hello");
  });

  it("does NOT double-prefix Subject when 'Re: ' already present", () => {
    expect(buildReplyHeaders("a@b", [], "Re: hello").subject).toBe("Re: hello");
    expect(buildReplyHeaders("a@b", [], "RE: HELLO").subject).toBe("RE: HELLO");
    expect(buildReplyHeaders("a@b", [], "re:hello").subject).toBe("re:hello");
  });

  it("throws when the original Message-ID is empty", () => {
    expect(() => buildReplyHeaders("", [], "x")).toThrow();
    expect(() => buildReplyHeaders("   ", [], "x")).toThrow();
  });

  it("dedupes the References list while preserving order", () => {
    const headers = buildReplyHeaders(
      "orig-c@example.com",
      ["<a@example.com>", "<b@example.com>", "<a@example.com>"],
      "x",
    );
    expect(headers.references).toBe(
      "<a@example.com> <b@example.com> <orig-c@example.com>",
    );
  });
});

describe("buildForwardSubject", () => {
  it("adds 'Fwd: ' prefix when missing", () => {
    expect(buildForwardSubject("budget")).toBe("Fwd: budget");
  });
  it("does not double-prefix 'Fwd:' or 'Fw:'", () => {
    expect(buildForwardSubject("Fwd: budget")).toBe("Fwd: budget");
    expect(buildForwardSubject("Fw: budget")).toBe("Fw: budget");
    expect(buildForwardSubject("FWD: budget")).toBe("FWD: budget");
  });
});

describe("buildInboundPayload", () => {
  it("normalizes addresses, subject, body, message_id", () => {
    const payload = buildInboundPayload(fakeParsed() as never);
    expect(payload.from).toEqual({ address: "alice@example.com", name: "Alice" });
    expect(payload.to).toEqual([{ address: "bot@example.com" }]);
    expect(payload.subject).toBe("hello");
    expect(payload.body_text).toBe("hi there");
    expect(payload.body_html).toBe("<p>hi there</p>");
    expect(payload.message_id).toBe("orig-001@example.com");
    expect(payload.in_reply_to).toBeNull();
    expect(payload.references).toEqual([]);
    expect(payload.date).toBe("2026-01-15T10:30:00.000Z");
    expect(payload.attachments_meta).toEqual([]);
  });

  it("strips angle brackets from In-Reply-To and References", () => {
    const payload = buildInboundPayload(
      fakeParsed({
        inReplyTo: "<parent@example.com>",
        references: ["<a@example.com>", "<b@example.com>"],
      }) as never,
    );
    expect(payload.in_reply_to).toBe("parent@example.com");
    expect(payload.references).toEqual(["a@example.com", "b@example.com"]);
  });

  it("captures attachment metadata without binary content", () => {
    const payload = buildInboundPayload(
      fakeParsed({
        attachments: [
          { filename: "deck.pdf", contentType: "application/pdf", size: 12345, contentId: "cid-1" },
        ],
      }) as never,
    );
    expect(payload.attachments_meta).toEqual([
      { filename: "deck.pdf", content_type: "application/pdf", size: 12345, content_id: "cid-1" },
    ]);
  });
});

describe("buildInboundEvent", () => {
  it("emits kind=email.received and action_hint=create_task", () => {
    const event = buildInboundEvent(fakeParsed() as never, 42);
    expect(event.kind).toBe(KIND_EMAIL_RECEIVED);
    expect(event.action_hint).toBe(ACTION_HINT_CREATE_TASK);
    expect(event.subject_id).toBeNull();
    expect(event.id).toBe("email:orig-001@example.com");
  });

  it("falls back to email:uid-<n> when Message-ID is missing", () => {
    const event = buildInboundEvent(fakeParsed({ messageId: undefined }) as never, 99);
    expect(event.id).toBe("email:uid-99");
  });
});

describe("buildInboundEventId", () => {
  it("strips angle brackets from the wrapped Message-ID", () => {
    expect(buildInboundEventId({ messageId: "<m1@x.com>" }, 1)).toBe("email:m1@x.com");
  });
  it("falls back when messageId is empty after stripping", () => {
    expect(buildInboundEventId({ messageId: "<>" }, 7)).toBe("email:uid-7");
  });
});

describe("passesSubjectFilter", () => {
  it("returns true when no filter is configured", () => {
    expect(passesSubjectFilter({ subject: "anything" }, null)).toBe(true);
  });
  it("matches against the configured regex", () => {
    const re = /^\[task\]/i;
    expect(passesSubjectFilter({ subject: "[task] please fix" }, re)).toBe(true);
    expect(passesSubjectFilter({ subject: "hi" }, re)).toBe(false);
  });
  it("treats undefined subject as empty string", () => {
    const re = /.+/;
    expect(passesSubjectFilter({ subject: undefined }, re)).toBe(false);
  });
});

describe("buildTriggerEventNotificationParams (spec §7.3)", () => {
  it("echoes the watch request id in `id` and nests the event under `event`", () => {
    const event = buildInboundEvent(fakeParsed() as never, 12);
    const params = buildTriggerEventNotificationParams(42, event);
    expect(params).toEqual({ id: 42, event });
    // Ensure we did NOT use the slack-style `trigger_id` key by accident.
    expect((params as Record<string, unknown>).trigger_id).toBeUndefined();
  });

  it("accepts string and null request ids per JSON-RPC", () => {
    const event = buildInboundEvent(fakeParsed() as never, 7);
    expect(buildTriggerEventNotificationParams("req-42", event).id).toBe("req-42");
    expect(buildTriggerEventNotificationParams(null, event).id).toBeNull();
  });
});

describe("loadConfigFromEnv", () => {
  const baseEnv: NodeJS.ProcessEnv = {
    EMAIL_IMAP_HOST: "imap.gmail.com",
    EMAIL_IMAP_PORT: "993",
    EMAIL_IMAP_USER: "user@gmail.com",
    EMAIL_IMAP_PASS: "secret",
    EMAIL_SMTP_HOST: "smtp.gmail.com",
    EMAIL_SMTP_PORT: "587",
    EMAIL_SMTP_USER: "user@gmail.com",
    EMAIL_SMTP_PASS: "secret",
    EMAIL_FROM_ADDRESS: "Bot <user@gmail.com>",
  };

  it("loads from a complete environment with sensible defaults", () => {
    const cfg = loadConfigFromEnv(baseEnv);
    expect(cfg.imap.tls).toBe(true);
    expect(cfg.smtp.secure).toBe(false); // 587 → STARTTLS, not implicit TLS
    expect(cfg.inboundFolder).toBe("INBOX");
    expect(cfg.inboundFilterSubject).toBeNull();
    expect(cfg.markSeenOnAck).toBe(true);
  });

  it("marks SMTP secure=true when port=465", () => {
    const cfg = loadConfigFromEnv({ ...baseEnv, EMAIL_SMTP_PORT: "465" });
    expect(cfg.smtp.secure).toBe(true);
  });

  it("compiles EMAIL_INBOUND_FILTER_SUBJECT into a RegExp", () => {
    const cfg = loadConfigFromEnv({ ...baseEnv, EMAIL_INBOUND_FILTER_SUBJECT: "^\\[task\\]" });
    expect(cfg.inboundFilterSubject?.source).toBe("^\\[task\\]");
  });

  it("rejects an invalid regex with a descriptive error", () => {
    expect(() =>
      loadConfigFromEnv({ ...baseEnv, EMAIL_INBOUND_FILTER_SUBJECT: "(unbalanced" }),
    ).toThrow(/EMAIL_INBOUND_FILTER_SUBJECT/);
  });

  it("rejects missing required vars with a descriptive error", () => {
    const incomplete = { ...baseEnv } as NodeJS.ProcessEnv;
    delete incomplete.EMAIL_SMTP_PASS;
    expect(() => loadConfigFromEnv(incomplete)).toThrow(/EMAIL_SMTP_PASS/);
  });

  it("rejects a port outside the 1-65535 range", () => {
    expect(() => loadConfigFromEnv({ ...baseEnv, EMAIL_IMAP_PORT: "0" })).toThrow();
    expect(() => loadConfigFromEnv({ ...baseEnv, EMAIL_SMTP_PORT: "99999" })).toThrow();
  });

  it("never leaks the password through the redacted describe()", async () => {
    const { describe: redact } = await import("./config.js");
    const cfg = loadConfigFromEnv(baseEnv);
    const out = redact(cfg);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("secret");
  });
});

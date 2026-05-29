// Animus trigger plugin — Email (IMAP IDLE inbound + SMTP outbound).
//
// The TS SDK's `definePlugin` only wires `subject_backend` in v0.1.0, so we
// drive the JSON-RPC stdio loop directly via `createWire`. The handshake +
// manifest helpers from the SDK are still used so the wire shape stays in
// lockstep with the Rust host.

import process from "node:process";
import { stdout as nodeStdout } from "node:process";

import {
  PluginKind,
  PROTOCOL_VERSION,
  ErrorCode,
  buildInitializeResult,
  buildManifest,
  createWire,
  errorResponse,
  okResponse,
  validateInitializeParams,
  type PluginIdentity,
  type InitializeParams,
  type PluginCapabilities,
  type PluginManifest,
  type RpcId,
  type RpcRequest,
  type RpcResponse,
  type Wire,
} from "@launchapp-dev/animus-plugin-sdk";

import { describe, loadConfigFromEnv, type EmailConfig } from "./config.js";
import { buildTriggerEventNotificationParams } from "./inbound.js";
import { startWatcher, type Logger, type WatcherHandle } from "./imap-watcher.js";
import {
  createTransport,
  forward,
  sendNew,
  sendReply,
  type ForwardParams,
  type SendNewParams,
  type SendReplyParams,
} from "./outbound.js";
import type { Transporter } from "nodemailer";

const NAME = "animus-trigger-email";
const VERSION = "0.1.2";
const DESCRIPTION = "Email trigger plugin — IMAP IDLE inbound + SMTP outbound (threaded replies)";

const METHODS = [
  "trigger/watch",
  "trigger/ack",
  "trigger/schema",
  "email/send_reply",
  "email/send_new",
  "email/forward",
  "health/check",
] as const;

const TRIGGER_SCHEMA = {
  // Event kinds this backend emits. Mirrors `KIND_EMAIL_RECEIVED` in
  // src/inbound.ts.
  kinds: ["email.received"] as const,
  // After a daemon restart we re-sweep UNSEEN, so resumption picks up missed
  // mail without coordination from the host.
  supports_resume: true,
  // Message-IDs are stable across reconnects, but the host's dedup table is
  // still the source of truth — advertise false so it tracks ids itself.
  supports_dedup: false,
  // `trigger/ack` optionally marks `\Seen` so the next sweep doesn't re-emit.
  supports_ack: true,
} as const;

const IDENTITY: PluginIdentity = {
  name: NAME,
  version: VERSION,
  description: DESCRIPTION,
  plugin_kind: PluginKind.TriggerBackend,
};

const CAPABILITIES: PluginCapabilities = {
  methods: [...METHODS],
  streaming: true,
  progress: false,
  cancellation: false,
};

const MANIFEST: PluginManifest = buildManifest(IDENTITY, CAPABILITIES, {
  env_required: [
    { name: "EMAIL_IMAP_HOST", required: true },
    { name: "EMAIL_IMAP_PORT", required: true },
    { name: "EMAIL_IMAP_USER", required: true },
    { name: "EMAIL_IMAP_PASS", required: true, sensitive: true },
    { name: "EMAIL_SMTP_HOST", required: true },
    { name: "EMAIL_SMTP_PORT", required: true },
    { name: "EMAIL_SMTP_USER", required: true },
    { name: "EMAIL_SMTP_PASS", required: true, sensitive: true },
    { name: "EMAIL_FROM_ADDRESS", required: true },
    { name: "EMAIL_IMAP_TLS", required: false },
    { name: "EMAIL_INBOUND_FOLDER", required: false },
    { name: "EMAIL_INBOUND_FILTER_SUBJECT", required: false },
    { name: "EMAIL_INBOUND_MARK_SEEN_ON_ACK", required: false },
  ],
});

const logger: Logger = (level, msg, meta) => {
  // Diagnostics go to stderr — stdout is reserved for JSON-RPC frames.
  const payload = { ts: new Date().toISOString(), level, msg, ...meta };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
};

class EmailPluginState {
  cfg: EmailConfig | null = null;
  transporter: Transporter | null = null;
  watcher: WatcherHandle | null = null;
  // Logical trigger id captured from `trigger/watch` params (if the host
  // provided one) and echoed on every emitted `TriggerEvent.trigger_id`.
  triggerId: string | null = null;
  // Map event_id -> UID so trigger/ack can mark the right message \Seen.
  uidByEventId: Map<string, number> = new Map();

  loadConfig(): EmailConfig {
    if (!this.cfg) {
      this.cfg = loadConfigFromEnv();
    }
    return this.cfg;
  }

  getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = createTransport(this.loadConfig());
    }
    return this.transporter;
  }
}

async function handleTriggerWatch(
  state: EmailPluginState,
  wire: Wire,
  id: RpcId,
  params: Record<string, unknown>,
): Promise<RpcResponse> {
  if (state.watcher) {
    return errorResponse(id, ErrorCode.InvalidRequest, "trigger/watch already active for this plugin instance");
  }
  let cfg: EmailConfig;
  try {
    cfg = state.loadConfig();
  } catch (err) {
    // If the backend cannot open its upstream (e.g. missing credentials), it
    // MUST return a JSON-RPC error response rather than emit a stream that
    // fails on the first poll.
    return errorResponse(id, ErrorCode.InvalidRequest, `email config invalid: ${String(err)}`);
  }
  state.triggerId = typeof params.trigger_id === "string" ? params.trigger_id : null;
  logger("info", "starting imap watcher", describe(cfg));

  const watcher = startWatcher(cfg, {
    log: logger,
    triggerId: state.triggerId,
    onEvent: async (event, uid) => {
      state.uidByEventId.set(event.event_id, uid);
      // Wire shape: flat TriggerEvent as `params` directly. Matches
      // `serde_json::from_value::<TriggerEvent>(notification.params)` in
      // trigger_supervisor.rs:289.
      await wire.notify("trigger/event", buildTriggerEventNotificationParams(event));
    },
  });
  state.watcher = watcher;
  try {
    await watcher.ready;
  } catch (err) {
    state.watcher = null;
    state.triggerId = null;
    try {
      await watcher.stop();
    } catch {
      // ignore — we're already failing the watch
    }
    return errorResponse(id, ErrorCode.InternalError, `imap upstream unreachable: ${String(err)}`);
  }
  return okResponse(id, { watching: true });
}

async function handleTriggerAck(
  state: EmailPluginState,
  id: RpcId,
  params: Record<string, unknown>,
): Promise<RpcResponse> {
  const eventId = typeof params.event_id === "string" ? params.event_id : null;
  if (!eventId) {
    return errorResponse(id, ErrorCode.InvalidParams, "trigger/ack requires string `event_id`");
  }
  const cfg = state.cfg;
  const uid = state.uidByEventId.get(eventId);
  if (cfg && cfg.markSeenOnAck && state.watcher && typeof uid === "number") {
    try {
      await state.watcher.markSeen(uid);
    } catch (err) {
      logger("warn", "markSeen failed", { event_id: eventId, uid, err: String(err) });
    }
  }
  // Always release the UID mapping on ack, even when EMAIL_INBOUND_MARK_SEEN_ON_ACK
  // is false. Leaving the entry behind would leak one map slot per delivered
  // email over the lifetime of the watcher.
  state.uidByEventId.delete(eventId);
  // Result shape per spec §7.3: `{ event_id, acked: true }`.
  return okResponse(id, { event_id: eventId, acked: true });
}

function parseReplyParams(raw: Record<string, unknown>): SendReplyParams | string {
  const to = raw.to;
  if (typeof to !== "string" && !Array.isArray(to)) return "`to` must be string or array";
  const inReplyTo = raw.in_reply_to;
  if (typeof inReplyTo !== "string" || inReplyTo.length === 0) return "`in_reply_to` must be a non-empty string";
  const subject = raw.original_subject;
  if (typeof subject !== "string") return "`original_subject` must be a string";
  const refsRaw = raw.references;
  let references: string[] = [];
  if (Array.isArray(refsRaw)) references = refsRaw.filter((r): r is string => typeof r === "string");
  const out: SendReplyParams = {
    to: to as string | string[],
    in_reply_to: inReplyTo,
    original_subject: subject,
    references,
  };
  if (typeof raw.cc === "string" || Array.isArray(raw.cc)) out.cc = raw.cc as string | string[];
  if (typeof raw.bcc === "string" || Array.isArray(raw.bcc)) out.bcc = raw.bcc as string | string[];
  if (typeof raw.text === "string") out.text = raw.text;
  if (typeof raw.html === "string") out.html = raw.html;
  if (typeof raw.from === "string") out.from = raw.from;
  return out;
}

function parseNewParams(raw: Record<string, unknown>): SendNewParams | string {
  const to = raw.to;
  if (typeof to !== "string" && !Array.isArray(to)) return "`to` must be string or array";
  if (typeof raw.subject !== "string") return "`subject` must be a string";
  const out: SendNewParams = {
    to: to as string | string[],
    subject: raw.subject,
  };
  if (typeof raw.cc === "string" || Array.isArray(raw.cc)) out.cc = raw.cc as string | string[];
  if (typeof raw.bcc === "string" || Array.isArray(raw.bcc)) out.bcc = raw.bcc as string | string[];
  if (typeof raw.text === "string") out.text = raw.text;
  if (typeof raw.html === "string") out.html = raw.html;
  if (typeof raw.from === "string") out.from = raw.from;
  return out;
}

function parseForwardParams(raw: Record<string, unknown>): ForwardParams | string {
  const to = raw.to;
  if (typeof to !== "string" && !Array.isArray(to)) return "`to` must be string or array";
  if (typeof raw.original_subject !== "string") return "`original_subject` must be a string";
  const out: ForwardParams = {
    to: to as string | string[],
    original_subject: raw.original_subject,
  };
  if (typeof raw.cc === "string" || Array.isArray(raw.cc)) out.cc = raw.cc as string | string[];
  if (typeof raw.bcc === "string" || Array.isArray(raw.bcc)) out.bcc = raw.bcc as string | string[];
  if (typeof raw.original_body_text === "string") out.original_body_text = raw.original_body_text;
  if (typeof raw.original_body_html === "string") out.original_body_html = raw.original_body_html;
  if (typeof raw.original_from === "string") out.original_from = raw.original_from;
  if (typeof raw.original_date === "string") out.original_date = raw.original_date;
  if (typeof raw.commentary === "string") out.commentary = raw.commentary;
  if (typeof raw.from === "string") out.from = raw.from;
  return out;
}

async function dispatch(
  state: EmailPluginState,
  wire: Wire,
  frame: RpcRequest,
): Promise<RpcResponse | undefined> {
  const id = frame.id;
  const method = frame.method;

  // Notifications never carry an id. Per JSON-RPC, only missing `id` => notif.
  if (id === undefined) {
    if (method === "exit") {
      setImmediate(() => {
        void shutdownAndExit(state);
      });
      return undefined;
    }
    if (method === "initialized" || method.startsWith("$/")) return undefined;
    return undefined;
  }

  try {
    switch (method) {
      case "initialize": {
        const params = (frame.params ?? {}) as InitializeParams;
        const incompat = validateInitializeParams(params);
        if (incompat) return errorResponse(id, ErrorCode.InvalidRequest, incompat);
        return okResponse(id, buildInitializeResult(IDENTITY, CAPABILITIES));
      }
      case "$/ping":
        return okResponse(id, {});
      case "health/check": {
        // Light check: validate env is loadable. Do NOT attempt a network
        // login here — the host probes this on a short interval.
        try {
          state.loadConfig();
          return okResponse(id, {
            status: "healthy",
            uptime_ms: Math.round(process.uptime() * 1000),
            memory_usage_bytes: process.memoryUsage().rss,
            last_error: null,
          });
        } catch (err) {
          return okResponse(id, {
            status: "unhealthy",
            uptime_ms: Math.round(process.uptime() * 1000),
            memory_usage_bytes: process.memoryUsage().rss,
            last_error: String(err),
          });
        }
      }
      case "shutdown": {
        await shutdownState(state);
        return okResponse(id, {});
      }
      case "exit": {
        setImmediate(() => {
          void shutdownAndExit(state);
        });
        return okResponse(id, {});
      }
      case "trigger/watch":
        return handleTriggerWatch(state, wire, id, (frame.params ?? {}) as Record<string, unknown>);
      case "trigger/ack":
        return handleTriggerAck(state, id, (frame.params ?? {}) as Record<string, unknown>);
      case "trigger/schema":
        return okResponse(id, TRIGGER_SCHEMA);
      case "email/send_reply": {
        const parsed = parseReplyParams((frame.params ?? {}) as Record<string, unknown>);
        if (typeof parsed === "string") return errorResponse(id, ErrorCode.InvalidParams, parsed);
        const result = await sendReply(state.getTransporter(), state.loadConfig(), parsed);
        return okResponse(id, result);
      }
      case "email/send_new": {
        const parsed = parseNewParams((frame.params ?? {}) as Record<string, unknown>);
        if (typeof parsed === "string") return errorResponse(id, ErrorCode.InvalidParams, parsed);
        const result = await sendNew(state.getTransporter(), state.loadConfig(), parsed);
        return okResponse(id, result);
      }
      case "email/forward": {
        const parsed = parseForwardParams((frame.params ?? {}) as Record<string, unknown>);
        if (typeof parsed === "string") return errorResponse(id, ErrorCode.InvalidParams, parsed);
        const result = await forward(state.getTransporter(), state.loadConfig(), parsed);
        return okResponse(id, result);
      }
      default:
        return errorResponse(id, ErrorCode.MethodNotFound, `unknown method '${method}'`);
    }
  } catch (err) {
    return errorResponse(id, ErrorCode.InternalError, `handler error: ${String(err)}`);
  }
}

async function shutdownState(state: EmailPluginState): Promise<void> {
  if (state.watcher) {
    try {
      await state.watcher.stop();
    } catch (err) {
      logger("warn", "watcher.stop threw", { err: String(err) });
    }
    state.watcher = null;
  }
  if (state.transporter) {
    try {
      state.transporter.close();
    } catch {
      // ignore
    }
    state.transporter = null;
  }
}

async function shutdownAndExit(state: EmailPluginState): Promise<void> {
  await shutdownState(state);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--manifest") || args.includes("-m")) {
    await new Promise<void>((resolve, reject) => {
      nodeStdout.write(`${JSON.stringify(MANIFEST)}\n`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    process.exit(0);
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write(
      `${NAME} ${VERSION} - Animus STDIO trigger plugin (email)\n` +
        "Usage:\n" +
        `  ${NAME} --manifest    Print plugin manifest as JSON and exit\n` +
        `  ${NAME}               Run JSON-RPC loop on stdin/stdout\n` +
        `Protocol version: ${PROTOCOL_VERSION}\n`,
    );
    process.exit(0);
  }

  const state = new EmailPluginState();
  const wire: Wire = createWire({});

  const onSignal = (sig: NodeJS.Signals): void => {
    logger("info", "received signal, shutting down", { sig });
    void shutdownAndExit(state);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  await wire.run((frame) => dispatch(state, wire, frame));
  // Stdin closed without a graceful `shutdown`/`exit` (e.g. the daemon died
  // or our supervisor SIGKILLed its parent). Tear down the IMAP watcher so we
  // don't keep a stale socket alive and process duplicate mail when the
  // daemon respawns us.
  logger("info", "stdin closed; tearing down watcher");
  await shutdownAndExit(state);
}

void main().catch((err) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});

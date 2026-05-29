// IMAP IDLE watcher with reconnect-on-disconnect.
//
// imapflow's `mailboxWatcher` (the IDLE loop) terminates when the socket
// drops; Gmail in particular forcibly closes IDLE after ~29 min. We wrap the
// connect-watch lifecycle in an outer loop that reconnects with exponential
// backoff (capped at 60s) until `stop()` is called.

import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";

import type { EmailConfig } from "./config.js";
import { buildInboundEvent, passesSubjectFilter, type InboundEvent } from "./inbound.js";

/** Anything the watcher needs to log; stderr only. Stdout is reserved for
 *  JSON-RPC protocol frames per the SDK contract. */
export type Logger = (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;

export interface WatcherHooks {
  /** Called for every new inbound message (post-filter). */
  onEvent: (event: InboundEvent, uid: number) => Promise<void> | void;
  log: Logger;
}

export interface WatcherHandle {
  /** Resolves once the first IMAP connect+open succeeds (or rejects if it
   *  fails before any reconnect has been scheduled). Lets `trigger/watch`
   *  acknowledge with `{ watching: true }` ONLY when the upstream is usable. */
  ready: Promise<void>;
  /** Trigger a graceful shutdown of the watch loop. */
  stop: () => Promise<void>;
  /** Resolves when the outer loop has fully exited. */
  done: Promise<void>;
  /** Mark a UID as `\Seen` (used by trigger/ack). Queues the request if the
   *  watcher is currently between IMAP connections. */
  markSeen: (uid: number) => Promise<void>;
}

// Exponential-backoff retry delay, capped.
function backoffDelayMs(attempt: number): number {
  const base = 1000;
  const cap = 60_000;
  const exp = Math.min(cap, base * 2 ** Math.min(attempt, 6));
  // Light jitter so a fleet of replicas don't all reconnect on the same tick.
  const jitter = Math.floor(Math.random() * 500);
  return exp + jitter;
}

/**
 * Start watching the configured IMAP folder. Returns a handle that can be
 * `stop()`-ed and a `markSeen(uid)` callback for ack-on-process.
 *
 * On any disconnect, the watcher reconnects with exponential backoff until
 * `stop()` is called.
 */
export function startWatcher(cfg: EmailConfig, hooks: WatcherHooks): WatcherHandle {
  let stopped = false;
  let currentClient: ImapFlow | null = null;
  // Track UIDs we've already emitted in this session so a single STORE \Seen
  // doesn't cause a re-FETCH loop (some servers re-fire `exists`/`mailboxWatcher`
  // after a STORE on the same UID).
  const emittedUids = new Set<number>();
  // UIDs the host has ACKed (mark \Seen) while we were between connections.
  // We drain them on the next successful connect.
  const pendingSeen = new Set<number>();

  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const settleReady = (ok: boolean, err?: Error): void => {
    if (ok && readyResolve) {
      readyResolve();
      readyResolve = null;
      readyReject = null;
    } else if (!ok && readyReject && err) {
      readyReject(err);
      readyResolve = null;
      readyReject = null;
    }
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      // Don't block process exit waiting on the timer.
      t.unref();
    });

  const markSeen = async (uid: number): Promise<void> => {
    const client = currentClient;
    if (!client) {
      // Queue for the next successful connect rather than silently dropping
      // the ACK. Otherwise a restart sweep would re-emit the message.
      pendingSeen.add(uid);
      hooks.log("info", "ACK queued (no active IMAP client); will drain on reconnect", { uid });
      return;
    }
    try {
      await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true });
    } catch (err) {
      // Don't lose the intent if the STORE failed mid-flight.
      pendingSeen.add(uid);
      hooks.log("warn", "failed to mark message \\Seen; queued for retry", { uid, err: String(err) });
    }
  };

  const drainPendingSeen = async (client: ImapFlow): Promise<void> => {
    if (pendingSeen.size === 0) return;
    const uids = Array.from(pendingSeen);
    pendingSeen.clear();
    try {
      await client.messageFlagsAdd({ uid: uids.map(String).join(",") }, ["\\Seen"], { uid: true });
      hooks.log("info", "drained queued ACKs", { count: uids.length });
    } catch (err) {
      // Re-queue so a later reconnect can retry.
      for (const u of uids) pendingSeen.add(u);
      hooks.log("warn", "failed to drain queued ACKs; will retry on next reconnect", { err: String(err) });
    }
  };

  const handleNewMessage = async (client: ImapFlow, uid: number): Promise<void> => {
    if (emittedUids.has(uid)) return;
    let fetched: FetchMessageObject | false;
    try {
      fetched = await client.fetchOne(String(uid), { source: true, uid: true, envelope: true }, { uid: true });
    } catch (err) {
      hooks.log("warn", "fetchOne failed", { uid, err: String(err) });
      return;
    }
    if (!fetched || !fetched.source) {
      hooks.log("warn", "fetched message had no source", { uid });
      return;
    }
    let parsed: ParsedMail;
    try {
      parsed = await simpleParser(fetched.source);
    } catch (err) {
      hooks.log("warn", "mailparser failed", { uid, err: String(err) });
      return;
    }
    if (!passesSubjectFilter(parsed, cfg.inboundFilterSubject)) return;
    emittedUids.add(uid);
    const event = buildInboundEvent(parsed, uid);
    try {
      await hooks.onEvent(event, uid);
    } catch (err) {
      hooks.log("error", "onEvent handler threw", { uid, err: String(err) });
    }
  };

  const runOnce = async (): Promise<void> => {
    const client = new ImapFlow({
      host: cfg.imap.host,
      port: cfg.imap.port,
      secure: cfg.imap.tls,
      auth: { user: cfg.imap.user, pass: cfg.imap.pass },
      logger: false,
    });
    currentClient = client;

    client.on("error", (err: Error) => {
      hooks.log("warn", "imap client error", { err: err.message });
    });

    await client.connect();
    const lock = await client.getMailboxLock(cfg.inboundFolder);
    try {
      hooks.log("info", "imap connected; entering IDLE", { folder: cfg.inboundFolder });
      // First-time readiness is signalled after we hold the lock — anything
      // that depends on "watch is live" (e.g. the `trigger/watch` ack) can
      // resolve now. Subsequent reconnects don't re-fire this.
      settleReady(true);
      // Drain any ACKs the host fired while we were disconnected.
      await drainPendingSeen(client);

      // Attach the `exists` listener BEFORE the initial UNSEEN sweep so a
      // message that arrives mid-sweep still triggers a fetch. handleNewMessage
      // dedupes via `emittedUids`, so it's safe if a UID surfaces both ways.
      // `exists` fires every time the mailbox EXISTS count moves up — i.e. new
      // mail. Use the path event handler to grab the new UID(s).
      client.on("exists", (data: { path: string; count: number; prevCount: number }) => {
        if (stopped) return;
        if (data.path !== cfg.inboundFolder) return;
        if (data.count <= data.prevCount) return;
        // Fetch by sequence range "(prevCount+1):*" using UID lookups.
        const seqRange = `${data.prevCount + 1}:*`;
        (async () => {
          try {
            for await (const msg of client.fetch(seqRange, { uid: true })) {
              if (stopped) break;
              await handleNewMessage(client, msg.uid);
            }
          } catch (err) {
            hooks.log("warn", "exists-handler fetch failed", { err: String(err) });
          }
        })().catch((err) => {
          hooks.log("error", "exists handler async crash", { err: String(err) });
        });
      });

      // Process anything UNSEEN that arrived while we were disconnected (and
      // anything that landed between mailbox open and listener attach above).
      try {
        const unseen = await client.search({ seen: false }, { uid: true });
        if (Array.isArray(unseen)) {
          for (const uid of unseen) {
            if (stopped) break;
            await handleNewMessage(client, uid);
          }
        }
      } catch (err) {
        hooks.log("warn", "initial UNSEEN sweep failed", { err: String(err) });
      }

      // Block here until the connection dies or stop() is invoked. imapflow
      // raises 'close' when the IDLE socket terminates.
      await new Promise<void>((resolve) => {
        // Belt-and-suspenders: if stop() fires while we're holding the lock,
        // wake the waiter so the outer loop can exit cleanly.
        const stopPoll: NodeJS.Timeout = setInterval(() => {
          if (stopped) {
            clearInterval(stopPoll);
            client.removeListener("close", onClose);
            resolve();
          }
        }, 250);
        stopPoll.unref();
        const onClose = (): void => {
          // Clear the poll interval on every exit path — otherwise a Gmail
          // 29-minute IDLE drop would leak one interval per reconnect over
          // the lifetime of the plugin.
          clearInterval(stopPoll);
          client.removeListener("close", onClose);
          resolve();
        };
        client.once("close", onClose);
      });
    } finally {
      lock.release();
      try {
        await client.logout();
      } catch {
        // Ignore — connection is likely already dead.
      }
      if (currentClient === client) currentClient = null;
    }
  };

  const outerLoop = async (): Promise<void> => {
    let attempt = 0;
    while (!stopped) {
      try {
        await runOnce();
        // Clean drop (logout / Gmail 29-min cap). Reset attempt counter.
        attempt = 0;
      } catch (err) {
        attempt += 1;
        const delay = backoffDelayMs(attempt);
        hooks.log("warn", "imap watch errored; will retry", {
          attempt,
          delay_ms: delay,
          err: String(err),
        });
        // If we've never connected and the very first attempt blew up
        // (bad creds / wrong host / missing folder), reject the readiness
        // promise so `trigger/watch` returns a structured error instead of
        // a false-positive `{ watching: true }`. Subsequent retries still
        // happen in the background; they just no longer gate the ack.
        if (attempt === 1) {
          settleReady(false, err instanceof Error ? err : new Error(String(err)));
        }
        if (stopped) break;
        await sleep(delay);
      }
      if (stopped) break;
      // Even on clean drop, wait a moment to avoid pegging the server.
      await sleep(500);
    }
    hooks.log("info", "imap watcher exited");
  };

  const done = outerLoop();

  const stop = async (): Promise<void> => {
    stopped = true;
    const client = currentClient;
    if (client) {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
    await done;
  };

  // Surface unhandled readyReject so an unawaited `ready` doesn't crash on
  // node's --unhandled-rejections=strict default.
  ready.catch(() => undefined);

  return { ready, stop, done, markSeen };
}

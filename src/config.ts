// Environment-driven configuration. The plugin never logs credentials; only
// the redacted view (`describe()`) is suitable for diagnostics.

export interface EmailConfig {
  imap: {
    host: string;
    port: number;
    user: string;
    pass: string;
    tls: boolean;
  };
  smtp: {
    host: string;
    port: number;
    user: string;
    pass: string;
    secure: boolean;
  };
  fromAddress: string;
  inboundFolder: string;
  inboundFilterSubject: RegExp | null;
  markSeenOnAck: boolean;
}

const REQUIRED_ENV = [
  "EMAIL_IMAP_HOST",
  "EMAIL_IMAP_PORT",
  "EMAIL_IMAP_USER",
  "EMAIL_IMAP_PASS",
  "EMAIL_SMTP_HOST",
  "EMAIL_SMTP_PORT",
  "EMAIL_SMTP_USER",
  "EMAIL_SMTP_PASS",
  "EMAIL_FROM_ADDRESS",
] as const;

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

function parsePort(raw: string, name: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`${name} must be an integer port between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const missing: string[] = [];
  for (const key of REQUIRED_ENV) {
    const v = env[key];
    if (v === undefined || v.length === 0) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(`missing required env vars: ${missing.join(", ")}`);
  }

  const imapTls = parseBool(env.EMAIL_IMAP_TLS, true);
  const smtpPort = parsePort(env.EMAIL_SMTP_PORT as string, "EMAIL_SMTP_PORT");
  const imapPort = parsePort(env.EMAIL_IMAP_PORT as string, "EMAIL_IMAP_PORT");

  let subjectRe: RegExp | null = null;
  const rawSubjectRe = env.EMAIL_INBOUND_FILTER_SUBJECT;
  if (rawSubjectRe && rawSubjectRe.length > 0) {
    try {
      subjectRe = new RegExp(rawSubjectRe);
    } catch (err) {
      throw new Error(`EMAIL_INBOUND_FILTER_SUBJECT is not a valid regex: ${String(err)}`);
    }
  }

  return {
    imap: {
      host: env.EMAIL_IMAP_HOST as string,
      port: imapPort,
      user: env.EMAIL_IMAP_USER as string,
      pass: env.EMAIL_IMAP_PASS as string,
      tls: imapTls,
    },
    smtp: {
      host: env.EMAIL_SMTP_HOST as string,
      port: smtpPort,
      user: env.EMAIL_SMTP_USER as string,
      pass: env.EMAIL_SMTP_PASS as string,
      // 465 = implicit TLS; 587 = STARTTLS (secure=false, nodemailer upgrades automatically).
      secure: smtpPort === 465,
    },
    fromAddress: env.EMAIL_FROM_ADDRESS as string,
    inboundFolder: env.EMAIL_INBOUND_FOLDER && env.EMAIL_INBOUND_FOLDER.length > 0 ? env.EMAIL_INBOUND_FOLDER : "INBOX",
    inboundFilterSubject: subjectRe,
    markSeenOnAck: parseBool(env.EMAIL_INBOUND_MARK_SEEN_ON_ACK, true),
  };
}

/** Redacted view for diagnostics; NEVER includes credentials. */
export function describe(cfg: EmailConfig): Record<string, unknown> {
  return {
    imap_host: cfg.imap.host,
    imap_port: cfg.imap.port,
    imap_user: cfg.imap.user,
    imap_tls: cfg.imap.tls,
    smtp_host: cfg.smtp.host,
    smtp_port: cfg.smtp.port,
    smtp_user: cfg.smtp.user,
    from_address: cfg.fromAddress,
    inbound_folder: cfg.inboundFolder,
    inbound_filter_subject: cfg.inboundFilterSubject?.source ?? null,
    mark_seen_on_ack: cfg.markSeenOnAck,
  };
}

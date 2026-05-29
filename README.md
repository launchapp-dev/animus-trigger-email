# animus-trigger-email

Email trigger plugin for [Animus](https://github.com/launchapp-dev/animus-cli).
**IMAP IDLE inbound + SMTP outbound** — works with any mailbox: Gmail, Outlook /
Microsoft 365, iCloud, FastMail, or any custom IMAP server. The operator
configures one mailbox, the plugin watches it for new mail and exposes
threaded-reply / send-new / forward RPCs over JSON-RPC.

- **Inbound:** IMAP IDLE on `INBOX` (or a configurable folder). Each new
  message is parsed via [`mailparser`](https://nodemailer.com/extras/mailparser/)
  and emitted as a `trigger/event` notification with kind `email.received`.
- **Outbound:** Three custom RPCs (`email/send_reply`, `email/send_new`,
  `email/forward`) over [`nodemailer`](https://nodemailer.com/) SMTP. Replies
  set `In-Reply-To` + `References` headers correctly so Gmail/Outlook show
  them as threaded responses.

## Install

```bash
animus plugin install launchapp-dev/animus-trigger-email
```

The daemon discovers the plugin on next start (or reload).

## Environment

Required:

| Var | Notes |
| --- | --- |
| `EMAIL_IMAP_HOST` | e.g. `imap.gmail.com`, `outlook.office365.com`, `imap.mail.me.com` |
| `EMAIL_IMAP_PORT` | typically `993` (TLS) |
| `EMAIL_IMAP_USER` | usually full email address |
| `EMAIL_IMAP_PASS` | **app password** for Gmail / iCloud (see below) |
| `EMAIL_SMTP_HOST` | e.g. `smtp.gmail.com`, `smtp.office365.com`, `smtp.mail.me.com` |
| `EMAIL_SMTP_PORT` | `587` (STARTTLS) or `465` (implicit TLS) |
| `EMAIL_SMTP_USER` | usually full email address |
| `EMAIL_SMTP_PASS` | app password |
| `EMAIL_FROM_ADDRESS` | `Bot Name <bot@example.com>` or just `bot@example.com` |

Optional:

| Var | Default | Notes |
| --- | --- | --- |
| `EMAIL_IMAP_TLS` | `true` | set to `false` only for local-test mailboxes |
| `EMAIL_INBOUND_FOLDER` | `INBOX` | any IMAP folder name |
| `EMAIL_INBOUND_FILTER_SUBJECT` | (none) | JS regex — only matching Subjects emit events |
| `EMAIL_INBOUND_MARK_SEEN_ON_ACK` | `true` | when host calls `trigger/ack`, STORE `\Seen` |

Credentials are never logged. The plugin emits a redacted config view on
startup (host + user only, no passwords).

## Mailbox setup snippets

### Gmail

1. Enable 2FA on the Google account.
2. Create an **app password** at <https://myaccount.google.com/apppasswords>
   (regular account passwords will not authenticate via IMAP/SMTP since 2022).
3. Settings:

```env
EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_IMAP_PORT=993
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=587
EMAIL_IMAP_USER=you@gmail.com
EMAIL_SMTP_USER=you@gmail.com
EMAIL_IMAP_PASS=<16-char-app-password>
EMAIL_SMTP_PASS=<16-char-app-password>
EMAIL_FROM_ADDRESS=Animus Bot <you@gmail.com>
```

> Gmail forcibly drops IMAP IDLE after ~29 minutes. The plugin handles the
> reconnect with exponential backoff (capped at 60s) — no operator action
> needed.

### Outlook / Microsoft 365

1. Ensure IMAP + SMTP AUTH are enabled for the tenant
   (Microsoft 365 admin → org settings → modern auth).
2. Create an app password if your tenant requires MFA. For tenants that
   disable basic auth entirely, use OAuth2 (planned for v0.2).
3. Settings:

```env
EMAIL_IMAP_HOST=outlook.office365.com
EMAIL_IMAP_PORT=993
EMAIL_SMTP_HOST=smtp.office365.com
EMAIL_SMTP_PORT=587
EMAIL_IMAP_USER=you@yourdomain.com
EMAIL_SMTP_USER=you@yourdomain.com
EMAIL_FROM_ADDRESS=Animus Bot <you@yourdomain.com>
```

### iCloud Mail

1. Generate an app-specific password at
   <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords.
2. Settings:

```env
EMAIL_IMAP_HOST=imap.mail.me.com
EMAIL_IMAP_PORT=993
EMAIL_SMTP_HOST=smtp.mail.me.com
EMAIL_SMTP_PORT=587
EMAIL_IMAP_USER=you@icloud.com
EMAIL_SMTP_USER=you@icloud.com
EMAIL_FROM_ADDRESS=Animus Bot <you@icloud.com>
```

### Custom IMAP / SMTP

Drop in any host/port. STARTTLS is auto-negotiated on port 587; implicit TLS
on port 465.

## Inbound event shape

The host receives this as a JSON-RPC notification:
`{ "method": "trigger/event", "params": { "id": <watch-request-id>, "event": <TriggerEvent> } }`.
`params.id` echoes the originating `trigger/watch` request id (per Animus
spec §7.3). The event itself looks like:

```json
{
  "id": "email:CAB+5...example.com",
  "occurred_at": "2026-05-28T10:30:00.000Z",
  "kind": "email.received",
  "subject_id": null,
  "action_hint": "create_task",
  "payload": {
    "from": { "name": "Alice", "address": "alice@example.com" },
    "to":   [{ "address": "bot@example.com" }],
    "cc":   [],
    "subject": "Need a hand with the deploy",
    "body_text": "Hey bot, …",
    "body_html": "<p>Hey bot, …</p>",
    "message_id": "CAB+5...example.com",
    "in_reply_to": null,
    "references": [],
    "date": "2026-05-28T10:30:00.000Z",
    "attachments_meta": [
      { "filename": "deploy.log", "content_type": "text/plain", "size": 4096, "content_id": null }
    ]
  }
}
```

Attachment *bytes* are intentionally not delivered over JSON-RPC — only
metadata. Future versions may store attachments in the host's log/blob store.

## Outbound RPCs

### `email/send_reply`

Threaded reply. The plugin builds `In-Reply-To: <message-id>` plus a
`References` chain that includes the parent message-id and prefixes the
Subject with `Re: ` (only when missing). This is what Gmail / Outlook /
Apple Mail look for to render the message inside the original thread.

Params:

```json
{
  "to": "alice@example.com",
  "cc": ["bob@example.com"],
  "in_reply_to": "CAB+5...example.com",
  "references": ["CAB+1...example.com", "CAB+3...example.com"],
  "original_subject": "Need a hand with the deploy",
  "text": "Looking now — back in 10 min.",
  "html": "<p>Looking now — back in 10 min.</p>"
}
```

### `email/send_new`

Fresh thread, no In-Reply-To.

```json
{
  "to": "alice@example.com",
  "subject": "Daily standup notes",
  "text": "1. ..."
}
```

### `email/forward`

Forwards with optional commentary. Subject is prefixed `Fwd: ` (only when
missing).

```json
{
  "to": "manager@example.com",
  "original_subject": "Need a hand with the deploy",
  "original_from": "Alice <alice@example.com>",
  "original_date": "2026-05-28T10:30:00.000Z",
  "original_body_text": "Hey bot, …",
  "commentary": "FYI — escalating this one to you."
}
```

## Workflow YAML example

A two-phase pipeline that drafts a reply via an agent and then sends it:

```yaml
triggers:
  - kind: email.received
    backend: animus-trigger-email
    when: payload.subject matches "^\\[support\\]"

workflows:
  triage-incoming-email:
    phases:
      - id: draft-reply
        agent: claude-sonnet
        prompt: |
          You received an email:
          From: {{trigger.payload.from.address}}
          Subject: {{trigger.payload.subject}}
          ---
          {{trigger.payload.body_text}}
          ---
          Draft a concise reply. Output ONLY the reply body.
        outputs:
          reply_body: ${stdout}
      - id: send-it
        plugin: animus-trigger-email
        method: email/send_reply
        params:
          to: "{{trigger.payload.from.address}}"
          in_reply_to: "{{trigger.payload.message_id}}"
          references: "{{trigger.payload.references}}"
          original_subject: "{{trigger.payload.subject}}"
          text: "{{phases.draft-reply.outputs.reply_body}}"
```

## Architecture

```text
┌──────────────────────────┐   trigger/event (notify)
│ IMAP IDLE  (imapflow)    ├──────────────────────┐
│   ↓ exists / search      │                      │
│   ↓ fetch + mailparser   │                      ▼
└──────────────────────────┘                ┌─────────────┐
                                            │  Animus     │
┌──────────────────────────┐   email/send_* │  daemon     │
│ SMTP send  (nodemailer)  │◀───────────────│  host       │
└──────────────────────────┘                └─────────────┘
```

- **`imapflow`** rather than `node-imap`: actively maintained, TypeScript-
  native, first-class IDLE support, modern async/await API. `node-imap` is
  unmaintained since 2018 and uses callbacks.
- **`mailparser`** for MIME → JSON. Same author as `nodemailer`.
- **`nodemailer`** for SMTP. De-facto standard; handles STARTTLS upgrade on
  port 587 and implicit TLS on port 465 automatically.

## Not (yet) covered — planned for v0.2

- **OAuth2 (XOAUTH2)** auth for Gmail / Microsoft 365. Today the plugin uses
  password / app-password auth only.
- **Amazon SES webhook events** instead of IMAP IDLE. SES delivers inbound
  via SNS/SQS; a different backend would be cleaner than IMAP.
- **Microsoft Graph push subscriptions** for tenants where IMAP basic-auth
  is disabled.
- **Multi-mailbox watching** — current model is one mailbox per plugin
  instance. Run multiple `animus-trigger-email` processes if you need more.
- **Attachment payloads** — only metadata is delivered today.

## Security

- Credentials are read from the daemon process environment and never logged.
- The plugin's diagnostic output (stderr) emits a redacted config view on
  startup (host + user only).
- All inbound traffic is read-only IMAP until the host explicitly calls
  `trigger/ack` (which optionally STOREs `\Seen` — never deletes).
- Outbound RPCs send from `EMAIL_FROM_ADDRESS` by default. A caller-supplied
  `from` field is honored but SMTP servers will typically refuse mismatched
  envelope-from values, which is the desired default.

## License

[Elastic License 2.0](./LICENSE).

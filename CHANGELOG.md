# Changelog

## 0.1.1 - 2026-05-28

### Fixed

- **Wire shape: `trigger/event` notifications now use the flat `TriggerEvent`
  shape required by the daemon's trigger supervisor.** v0.1.0 emitted a
  nested `{ id, event }` wrapper per the (stale) `spec.md §7.3`, which the
  daemon silently drops because
  `crates/orchestrator-daemon-runtime/src/schedule/trigger_supervisor.rs:289`
  calls `serde_json::from_value::<TriggerEvent>(notification.params)` — so
  `params` IS the `TriggerEvent`, not a wrapper. Events are now emitted with
  the flat top-level fields `event_id`, `trigger_id`, `subject_id`,
  `subject_kind`, `action_hint`, and `payload`, matching the Rust struct in
  `crates/animus-plugin-protocol/src/lib.rs` field-for-field and matching
  the sibling Discord / Telegram / SMS-Twilio plugins. **v0.1.0 will not
  deliver any events at runtime — upgrade is required.**
- `payload.kind` and `payload.occurred_at` are now nested inside the
  TriggerEvent's `payload` (they were previously top-level siblings of the
  removed `id` / `event` wrapper).
- `trigger/watch` now reads `params.trigger_id` (when the host provides it)
  and stamps every emitted event with it.

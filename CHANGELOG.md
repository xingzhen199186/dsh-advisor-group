# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- **Stop → resume (「▶ 继续聊天」)**: after a user stop (or a dsh restart) the card's `⏹ 停止` button becomes `▶ 继续聊天` in the same spot; clicking it calls `POST /advisor-group/resume {sessionId}` and the pipeline continues from the interruption point — a partially-answered round is completed with ONLY the missing advisors (no regenerated deep-question, no re-asking answered advisors), remaining rounds run, and the card closes with a regular `end` + conclusion. Durability: each consultation is snapshotted (advisor ids + messages + status, **never credentials**) to `$DSH_HOME/storages/advisor-group/sessions/<id>.json`; after a restart the service restores interrupted snapshots (status normalized to `cancelled`) and rebuilds the DSH session handle via `ctx.sessions.prepare` + `enter` (log-only events, no agent reactivation; falls back to a detached session and then to SSE+snapshot only). A new `advisor-group/resume` log-only event flips the card back to LIVE; `resume` is rejected while running or once completed; it does not consume a daily consultation.

### Fixed

- **SSE live overlay now buckets deltas by `(advisorId, round)`** instead of `advisorId` alone. Previously a second-round advisor's deltas were applied to the first-round bubble of the same advisor, which made thinking appear in the wrong panel and deferred text until the live buffer outgrew the durable message. With the sequential auto-deepen pipeline (A → B → C relay per round) this now streams exactly in order.
- **User-initiated stop**: the running consultation card shows a `⏹ 停止` button (running state only) that calls `POST /advisor-group/stop` with the consultation `sessionId`; the host aborts the pipeline's combined signal and degrades to a graceful partial summary (`status: cancelled`, card title `STOPPED`, no synthesized conclusion). Refreshing the page still does NOT cancel the run (background completion is preserved), the stop is an explicit user action. `exec.signal` cancellation continues to work as before.
- **Late-round advisor output truncation (e.g. round-3 advisor thinking cut off before the body was generated)**: three mitigations — the transcript sent to each advisor is tightened (`12` most recent non-system messages × `3000` chars each, was `20 × 4000`), the advisor output policy now explicitly instructs concise thinking so the reasoning chain cannot starve the answer body, and `ctx-llm`/direct-http `maxTokens` defaults to `16384` when the advisor does not set an explicit value. Long context + long reasoning could previously exhaust the output budget and leave the message with a truncated thinking chain and no body.
- **Truncation is now visible instead of silent (root cause: the advisor timeout)**: session-log analysis proved every "empty body" message had a delta span of ~117–119s — the 120s advisor timeout cut a long-reasoning stream mid-thinking, and the pipeline swallowed the cut as a normal completion (empty body, no marker). Now: both provider channels classify a timed-out stream as `truncated: {reason: 'timeout', atMs}` (and a mid-stream connection drop as `reason: 'network'`), keeping the partial thinking chain; the durable `advisor-group/message` event carries `truncated`; the retro card shows a red chip (`⏱ 响应超时截断` / `⚠ 流中断`); `formatConversation` prefixes a notice so the main model knows the reply is incomplete; the final summary adds a 风险提示 ("顾问输出被截断…"); a caller-initiated abort now propagates as cancellation on the `ctx.llm` path too (previously the async iterator just ended silently). Default `discussion.advisorTimeoutMs` raised `120000 → 600000` (long-reasoning advisors lose their body under short budgets; 600s = schema maximum); stored user configs are untouched.

## [0.1.1] - 2026-09-04

### Added

- Configurable daily consultation cap: `quota.enabled` (default `true`) and `quota.maxPerDay` (default `50`, 1–100000; ignored while `quota.enabled` is `false`).
- Settings card controls for the daily cap (toggle + number input), with a live "remaining today" line that switches to "cap disabled" when turned off.

### Changed

- The daily quota is now config-driven instead of hard-coded; the counter keeps accumulating for display even when the cap is disabled.

## [0.1.0] - 2026-09-04

### Added

- Initial release: auto-deepen consultation pipeline (`maxRounds` rounds of driver follow-ups + advisor relay + synthesized conclusion), three activation triggers (`@顾问群`, repeated-question escalation, confidence threshold), retro CRT chat cards, 26 provider presets across 11 platforms, Security-first key handling (official `SecretField` semantics, SSRF-guarded diagnostics, per-boot route token) and a daily quota persisted across restarts.

## [0.1.0-alpha] - 2026-09-02

### Added

- Development snapshots leading to the first stable release; history consolidated into the 0.1.0 entry.

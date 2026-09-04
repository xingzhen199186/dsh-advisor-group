# Changelog

All notable changes to this project are documented in this file.

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

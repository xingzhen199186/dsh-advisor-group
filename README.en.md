# dsh-advisor-group

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that lets the main model consult **multiple expert advisor models** in a retro chat-group card — for professional, long-tail world-knowledge, high-risk, or uncertain questions.

[![dsh-plugin](https://img.shields.io/badge/DSH%20plugin-dsh--plugin-3f8cff)](https://github.com/topics/dsh-plugin)

📖 [中文文档 / Chinese: README.zh.md](README.zh.md)

---

<img width="865" height="983" alt="1788679983177" src="https://github.com/user-attachments/assets/dad2f2be-acf6-41d7-b61a-c11596e48408" />

## ✨ Features

- **Auto-deepen consultation pipeline** — one `ask_advisors` call runs up to `maxRounds` rounds automatically: each round is a *driver deep-question → advisor A → advisor B (sees A) → advisor C (sees A+B) → …* sequential relay, closed by a driver-generated synthesis conclusion.
- **Zero-config driver model** — the driver formulation of deep follow-ups reuses the current agent's provider/model, so no extra API key or model setup is needed; it falls back to `discussion.driverModel` when the session header is unavailable.
- **Three ways to activate** — `@顾问群` mention (force-start), same question repeated 3 times without resolution, or main-model self-assessed confidence below the threshold.
- **Optional Jev semantic pre-classification (off by default)** — when `trigger.jev.enabled` is on, a configured Jev model judges non-force-started consultations first (escalation / high-risk / web-search fit, thresholds under `trigger.jev.*`); if Jev is unavailable the local rules-based classifier still decides. With `trigger.jev.useEnglishState`, the judge reads the caller-supplied English gist (`questionEn`) instead of the Chinese question — display and session records stay Chinese.
- **Retro CRT chat cards** — green/amber/blue CRT themes, scanlines, LIVE/DONE headers, auto-expanded thinking panel with auto-scroll; advisor Markdown rendered with a link-protocol whitelist (headings, lists, code, quotes, links, tables).
- **Ask another session (`ask_session`)** — hand one question to another live session — by exact session id, exact title, or a natural partial name such as the workspace name (`极简遥控器`) — and read what that session said between the delivery receipt and its next whole-session idle. The result is explicitly **not** a one-to-one reply, and the asking side renders the exchange in the same retro chat-group card. Guards: hop ≤ 2, no self/subagent target, one wait per session, a 32 KB payload budget; the target's turn is never cancelled.
- **Provider presets (11 platforms · 26 presets)** — DeepSeek, Moonshot Kimi, Kimi Code, Aliyun Bailian, Zhipu AI, OpenAI, Claude, Gemini, SiliconFlow, AIHubMix, OpenRouter (OpenAI/Anthropic-compatible variants included).
- **Security-minded by design** — API keys use official `SecretField` semantics (never returned to the browser; `apiKeysByProvider` key history is server-side only), SSRF-guarded diagnostics (https-only / loopback, no IP literals, no redirects), per-boot token auth on `/advisor-group/*` routes, and an atomic **configurable daily consultation cap** (default 50, can be disabled) persisted across restarts.
- **Runtime toggle** — `toggle_advisor_group` enables/disables the plugin and persists the flag to settings.

## ✅ Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.1.7-rc.2` → `0.2.x` (incl. `0.2.0-rc.1`) |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Platforms | DSH Web and the desktop app (same client bundle) + headless host logic |

## 📦 Installation

```sh
# 1. Install the plugin (one package, everything included)
dsh plugin --profile web add dsh-advisor-group

# 2. Restart DSH web
npx @deepseek-ai/dsh web
```

> **From source (development)**
> ```sh
> npm install --legacy-peer-deps --no-audit --no-fund
> npm run build
> dsh plugin --profile web add ./dsh-advisor-group-<version>.tgz   # after npm pack (version from package.json)
> ```

> **Desktop app**: the desktop app owns its own profile — `dsh plugin --profile desktop …` is refused by design, not by permissions. Install from inside the app instead: **Plugins** in the sidebar → **Add plugin** → enter the package name or the absolute path of a local tarball.

## 🚀 Quick start

<img width="791" height="797" alt="image" src="https://github.com/user-attachments/assets/5fba07bc-8c36-40f1-b423-d206aa495192" />

1. Restart DSH web and hard-refresh the browser (`Ctrl+Shift+R`).
2. Go to **Settings → Plugins → Advisor Group**: configure your advisors (provider route + model; use *获取模型列表* to pull the authoritative model list) and tune `maxRounds`, thresholds, and the UI theme.
3. Just start a conversation:
   - type `@顾问群` in your question to force a consultation, or
   - ask a professional/uncertain question — the plugin escalates automatically when appropriate.

`ask_advisors` tools available to the model: `ask_advisors`, `toggle_advisor_group`, `ask_session`.

## ⚙️ Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable advisor group |
| `discussion.maxRounds` | number | `2` | Total rounds of the auto-deepen pipeline (each round = driver question + all advisors in relay) |
| `discussion.maxAdvisorsPerCall` | number | `3` | Max advisors per call (1–10) |
| `discussion.autoDeepen` | boolean | `true` | Run the auto-deepen pipeline (driver follow-ups + final synthesis) |
| `discussion.driverModel` | object | – | Fallback driver model `{provider, model}` when the session header cannot be read |
| `discussion.advisorTimeoutMs` | number | `600000` | Per-advisor call timeout (ms, 1000–600000), applied to both channels |
| `discussion.driverTimeoutMs` | number | `600000` | Driver generation timeout (deep-question / conclusion; ms, 1000–1200000) |
| `discussion.advisorTools` | string | `'readonly'` | Global default advisor tool scope when an advisor sets no own `tools`: `readonly` / `all` (every session-visible tool incl. writable — elevated risk, see Security) / `off`. Tool calling needs the direct-http (OpenAI/Anthropic) channel. |
| `quota.enabled` | boolean | `true` | Enable the daily new-consultation cap (cost safety valve) |
| `quota.maxPerDay` | number | `50` | Max new consultations per UTC day (1–100000); ignored when `quota.enabled` is `false` |
| `trigger.requireClassifier` | boolean | `true` | Run the pre-classifier before starting |
| `trigger.allowWebFallback` | boolean | `true` | Allow classifier to recommend web search |
| `trigger.confidenceThreshold` | number | `0.6` | Escalate when main-model confidence is below this |
| `trigger.jev.enabled` | boolean | `false` | Use the external Jev model for semantic pre-classification of non-forced consultations; falls back to the local rules-based classifier when Jev is unavailable |
| `trigger.jev.provider` / `trigger.jev.model` | string | `'typesafe'` / `'jev-latest'` | Jev route (`typesafe` or `openrouter`) and model; key via `trigger.jev.apiKey` (secret) or `trigger.jev.apiKeyEnv`; optional `baseURL`, `timeoutMs` (default `10000`) |
| `trigger.jev.confidenceThreshold` | number | `0.6` | Escalate when Jev answers `needsAdvisor` yes (or its 0–1 score reaches this value) |
| `trigger.jev.highRiskThreshold` | number | follows `jev.confidenceThreshold` | Flag high-risk when Jev answers `high_risk` yes (or its 0–1 score reaches this value); unset = follows `trigger.jev.confidenceThreshold` |
| `trigger.jev.useEnglishState` | boolean | `false` | Judge using the caller-supplied English gist (`questionEn`) instead of the Chinese question; display and session records stay Chinese |
| `ui.theme` | string | `retro-green` | Chat card theme (`retro-green` / `retro-amber` / `retro-blue`) |
| `ui.showTimestamps` | boolean | `true` | Show timestamps |
| `ui.autoExpand` | boolean | `true` | Auto-expand card |
| `advisors[].tools` | string | – | Per-advisor tool-scope override (`readonly`/`all`/`off`; unset follows the global default) |
| `advisors` | array | `[]` | Advisor list (provider/model/baseURL/apiKey/apiKeyEnv/protocol…, keys are `role('secret')`) |

> `discussion.parallel` and `discussion.stopOnConsensus` are deprecated leftovers kept only for stored-config compatibility.

## 🧮 Daily quota

The plugin ships a cost safety valve: it counts **new consultations** per UTC calendar day, default cap 50, changeable or switchable on the settings page. Only new consultations count — resuming (「▶ continue」) and follow-ups never consume quota. The check and the increment happen inside one synchronous block, so two consultations cannot slip through the same window; the counter is written atomically to `$DSH_HOME/storages/advisor-group/daily-guard.json`, survives restarts, and resets at the UTC day boundary. When the cap is reached `ask_advisors` does not start and returns a one-line explanation; the settings page shows "today's remaining consultations X / Y", and with the cap off the plugin still counts for display without blocking.

## 💸 Usage and cost

One consultation is not one call but a chain of them. With the defaults (`maxRounds = 2`, at most 3 advisors) a new consultation costs roughly 9 model calls: 2 rounds × (1 driver follow-up + 1 per advisor) + 1 driver synthesis. Advisors that use tools add one more model call per tool round (at most 4 rounds per advisor plus one forced text-only round), so the real count can be noticeably higher than 9.

Billing follows each channel: advisors bill on the route and model you gave them, while the driver bills on the current session's model. To keep costs down, lower `maxRounds`, configure fewer advisors, set `tools: 'off'` for advisors, and pick a daily cap you are comfortable with. Resuming after an interruption ("▶ continue") only asks the advisors that had not finished, so it costs less than starting over.

`ask_session` is outside the consultation quota: it wakes the target session, which answers with one ordinary turn billed on that session's own model, and it never counts as a new consultation.

## 🔒 Security & privacy

- Direct API keys can be stored in the DSH `settings.yaml` (marked secret, never returned to the browser by `describe`); prefer `apiKeyEnv` (env-var mode) if you don't want keys on disk.
- `/advisor-group/*` routes use a per-boot shared token for local single-user use — **not** multi-user auth. Add a reverse-proxy auth layer before LAN exposure.
- Diagnostics endpoints resolve the real key server-side and validate the target URL against an https-only / loopback SSRF guard; DNS-rebinding protection is a documented out-of-scope limitation.
- The daily consultation cap (configurable via `quota.*`; default 50; can be disabled) is persisted to `$DSH_HOME/storages/advisor-group/daily-guard.json` (UTC day key), so restarts don't reset it.
- Classifier shadow mode appends one observation sample per non-forced classification (read-only `/advisor-group/shadow`), used for threshold tuning only — never influences behavior.
- **`advisorTools: 'all'` is an elevated-risk scope.** It exposes every session-visible tool to the advisor models, including writable/execution ones (`pwsh`, `bash`, `write`, config/SSH tools), executed through the official guarded pipeline. Only enable it for advisors you trust (e.g., your own local models), keep them on the direct-http channel, and note that every non-read-only invocation is logged with `console.warn` for audit. Prefer the default `readonly` (read/grep/glob/web_search/web_fetch/scan_discover/list_imported_sessions) or `off`.

## ⚠️ Known limitations

- A hard crash of the DSH host can leave an already-open card showing **LIVE** until the page is refreshed (a disconnect notice now appears); refresh restores the true state from the session log.
- Risk notes are **fact-based, never text-based**: a consultation reports truncation (an advisor stream cut off by timeout or network) and cancellation/stop. Users see them on **stopped or completed** cards and in the session log, and the main model receives them in the `ask_advisors` result. Advisor prose is not scanned for keywords — the earlier text heuristic was removed in 0.1.1 because it also fired on plain negations such as 「没有任何风险」.
- Cross-session asking (`ask_session`) has no settings switch yet, so the tool is visible in every session and relies on its own description to keep use to explicit user requests; two sessions asking each other at the same time is not detected.

## 🛠️ Development

```sh
npm install --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm test        # vitest suite, incl. provider streaming contracts against a local fake LLM server
npm run build   # tsdown; client bundle must NOT be built with minify: true
```

## 📄 License

[Apache License 2.0](LICENSE) © 2026 dsh-advisor-group contributors.

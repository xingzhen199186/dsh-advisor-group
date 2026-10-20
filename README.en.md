# dsh-advisor-group

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that lets one session **borrow wisdom outward and memory sideways**.
>
> For professional, long-tail world-knowledge, high-risk or uncertain questions, the main model consults **multiple expert advisor models** in a retro chat-group card; for something another session already knows, it asks that session instead of re-deriving it from scratch.
>
> To try it: `dsh plugin --profile web add dsh-advisor-group`, restart DSH, and put `@顾问群` in your question.

[![dsh-plugin](https://img.shields.io/badge/DSH%20plugin-dsh--plugin-3f8cff)](https://github.com/topics/dsh-plugin)

📖 [中文文档 / Chinese: README.md](README.md)

---

<img width="865" height="983" alt="1788679983177" src="https://github.com/user-attachments/assets/dad2f2be-acf6-41d7-b61a-c11596e48408" />

## ✨ Features

- **Auto-deepen consultation pipeline** — one `ask_advisors` call runs up to `maxRounds` rounds (1–5, default 2). Round 1 uses your question as-is. Later rounds begin with a deeper follow-up from the driver model, or repeat the question if `autoDeepen` is disabled. Within each round, advisors relay in sequence (A → B sees A → C sees A+B → …). The driver concludes with a synthesis that always generates, regardless of `autoDeepen`.
- **Advisors can call session tools (2026-09-05)** — advisors can invoke tools visible to the session before answering. By default, access is limited to a read-only whitelist (read/grep/glob/web_search/web_fetch…). Tool calls route through the official `ctx.tools` pipeline (scope dispatch, guards, and pre/post policies), capped at 4 tool rounds before the advisor must reply in text. Each invocation appears as a `⛭ tool name · running / done / ⚠ failed` row in the card, expandable to inspect input and output. Switch between all session tools or off in settings.
- **Resume after a stop** — if a user stops the consultation or DSH restarts, the card's 「⏹ 停止」 button changes to 「▶ 继续聊天」 (Resume chat). Clicking it triggers `POST /advisor-group/resume` to continue from the checkpoint: unanswered advisors respond, previously answered ones are not queried again, remaining rounds run, and the final synthesis generates as usual. Session snapshots persist to `storages/advisor-group/sessions/<id>.json` (storing advisor IDs, messages, and statuses without credentials) and recover cleanly across restarts.
- **Zero-config driver model** — the driver model writes deep follow-up questions by reusing the active agent's provider and model. No separate API key or model configuration is required. If session headers are unreadable, it falls back to `discussion.driverModel`.
- **Three ways to activate** — mention `@顾问群` to force start; repeat the same question 3 times without resolution; or let the main model trigger consultation when its confidence drops below the threshold.
- **Optional Jev semantic pre-classification (off by default)** — when `trigger.jev.enabled` is active, the configured Jev model evaluates unforced requests (determining advisor need, high risk, or web-search suitability based on `trigger.jev.*` thresholds). If Jev is unreachable, the local rule-based classifier handles the decision. When `trigger.jev.useEnglishState` is enabled, Jev evaluates the caller-provided English gist (`questionEn`) instead of the Chinese prompt, while UI cards and session logs remain in Chinese.
- **Retro CRT chat cards** — green, amber, and blue themes with scanline effects and LIVE/DONE status badges. The 💭 thinking panel opens by default and expands as streams arrive. Content renders via lightweight Markdown with a strict link-protocol whitelist, supporting headings, lists, code blocks, blockquotes, links, and tables.
- **Ask another session (`ask_session`)** — forwards a question to another live session and wakes it. Use `list_sessions` to browse the roster and `ask_result` to collect asynchronous outputs. Responses represent conversation windows rather than 1-to-1 answers; see **The global swarm** for boundaries, cost, and usage.
- **Provider presets (12 platforms · 28 presets)** — DeepSeek, Moonshot Kimi, Kimi Code, Aliyun Bailian, Zhipu AI, OpenAI, Claude, Gemini, SiliconFlow, AIHubMix, OpenRouter, and **OpenCode Go** (including OpenAI and Anthropic-compatible variants).
- **Security-minded by design** — API keys follow official `SecretField` semantics and are never returned to the browser. The `apiKeysByProvider` credential archive stays strictly server-side. Diagnostic endpoints enforce SSRF protections (HTTPS-only, loopback allowed, rejecting raw IP literals and redirects). All `/advisor-group/*` routes require a per-boot token. You can also enforce a daily limit on new consultations (see **Daily quota**).
- **Runtime toggle** — `toggle_advisor_group` enables or disables the plugin and persists the setting.

## ✅ Compatibility

| Surface | Status |
|---|---|
| Harness | **`0.2.1-rc.2` — the version this release was gated against**; the declared peer range is `>=0.1.7-rc.2 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Platforms | DSH Web and the desktop app (same client bundle) + headless host logic |

> On the lower bound: `0.1.7-rc.2` remains inside the declared peer range, but was not re-verified during this round. Type checks, tests, and build were all completed against `0.2.1-rc.2`. If an older 0.1.x host fails to load the plugin, the issue stems from interface changes rather than bugs in this release.

## 📦 Installation

```sh
# 1. Install the plugin (one package, everything included)
dsh plugin --profile web add dsh-advisor-group

# 2. Restart DSH web
npx @deepseek-ai/dsh web
```

> **About step 2**: `npx @deepseek-ai/dsh web` pulls whichever DSH version is latest at that moment, which can fall outside this plugin's peer range (`>=0.1.7-rc.2 <0.3.0`); the host then refuses to load the plugin. Restart the way you normally do (an existing start script or the desktop app works too) — this exact command is not required.

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
2. Go to **Settings → Plugins → Advisor Group**: configure your advisors (provider route + model; use *获取模型列表* (Fetch model list) to pull the authoritative model list) and tune `maxRounds`, thresholds, and the UI theme.
3. Just start a conversation:
   - type `@顾问群` in your question to force a consultation, or
   - ask a professional/uncertain question — the plugin escalates automatically when appropriate.

Tools available to the model: `ask_advisors`, `toggle_advisor_group`, `ask_session`, `list_sessions`, `ask_result`.

## 🐝 The global swarm: sessions that can ask each other

### One session is an expert with memory

Every session accumulates context: the code it read, the detours it took, the decisions it settled. A session is not a throwaway chat window but a **node with memory** — and re-deriving what another session already knows is both slower and more expensive.

So the plugin does two things: it borrows **wisdom** outward (consulting expert models) and **memory** sideways (asking the session that already knows). Both are opt-in, and neither takes the decision away from you.

### Four principles

1. **Reuse, don't rebuild.** The session that already knows answers better and faster — its context and its cache prefix are warm.
2. **Peers, no root.** Sessions ask each other as equals; nothing dispatches from the centre. No central bottleneck, and no single session that must know everything.
3. **Candidates, never autopilot.** Routing (automatic candidate selection) proposes candidates with reasons; delivery needs you or the model to name one. Better to ask once more than to wake the wrong session.
4. **Task-first, never chatter.** Hop limit, one concurrent wait per session, long runs detached so they never block, silent fallback on every failure. **More nodes is not more intelligence — routing quality is.**

### Three tools

| Tool | What it does |
|---|---|
| `list_sessions` | The roster: title, working directory, age, running state. Read-only — it never wakes anyone. |
| `ask_session` | Hands a question to another session and wakes it; waits by default, or with `detach: true` returns an `askId` immediately. |
| `ask_result` | Reads a detached result (`waiting` / `done` / `timeout` / `error`); the record carries `parentAskId`, so a relay chain can be walked. |

### Finding the one to ask

Without a named target, the plugin scores sessions based on **title + working-directory segments** (with CJK text split into two-character groups). A few hard rules then narrow the candidates: a session's exact name mentioned in your message, a title keyword match, or a directory match.

Sorting evaluates criteria in order: score → title hit over directory-only hit → whether running → sufficient context (log size reaching the 160,380-byte floor) → activity recency (hot/warm/cold) → larger context within the same project → more recent activity → shorter title.

You can optionally add a **Jev** judge (Settings → Plugins → Advisor Group → 全局蜂群 [Global swarm] → 路由方式 [Routing method]). Candidates are passed as a closed option set with a "none of these" fallback; a low-confidence decision keeps the local ranking.

Jev can also evaluate whether a turn should consult another session at all. There are three modes: off, local prefilter + Jev (default), and every turn. The default mode runs a zero-cost clue prefilter first: it only calls Jev when a message clearly points to another session and names no target. Even when Jev recommends a query, it only injects a suggestion line into the next system prompt. Whether to deliver the message remains the main model's choice.

### Practicalities and honest limits

- **Picking the target**: provide an exact session ID, exact title, or a natural short name. The workspace directory name is usually sufficient (for example, refer to a session under `I:\极简遥控器\…` as 「极简遥控器」). A unique match routes immediately. Multiple matches produce a candidate list for you to choose from. The plugin never guesses.
- **What you get back**: everything the target said between the **delivery receipt** and its next **whole-session idle** state. This captures what the session produced during that window, rather than a 1-to-1 reply. A `status` flag (`ok` / `partial` / `failed`) indicates response reliability.
- **What you see**: the sender side opens a chat-group card displaying 「已投递，等待对方回应…」 (Delivered, awaiting response...), followed by the response bubble and a 「📌 投递说明」 (Delivery details) note. If target resolution fails, no card opens and the error is reported directly in the tool row.
- **Guards**: hops are capped at 2, asking oneself or subagents is forbidden, each session allows only one concurrent wait, and the payload budget is 32 KB. Detached results are cleaned up after their TTL expires. Sessions listed under 「不参与路由的会话」 (Sessions excluded from routing) never appear as candidates and reject direct requests. Target sessions are never cancelled midway.
- **Cost**: see **Usage and cost**. Detached results are pruned on read, and every Jev decision is logged to `storages/advisor-group/asks/routing-jev.log`.

In one line: say "ask the 极简遥控器 session how far along it is".

## ⚙️ Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable advisor group |
| `discussion.maxRounds` | number | `2` | Total rounds of the auto-deepen pipeline (1–5; each round = all advisors in relay, with a driver follow-up before every round after the first) |
| `discussion.maxAdvisorsPerCall` | number | `3` | Max advisors per call (1–10) |
| `discussion.autoDeepen` | boolean | `true` | Whether to generate a deeper follow-up between rounds; it does not change the round count — when off, the same question repeats for `maxRounds` rounds and the synthesis is still generated |
| `discussion.driverModel` | object | – | Fallback driver model `{provider, model}` when the session header cannot be read |
| `discussion.advisorTimeoutMs` | number | `600000` | Per-advisor call timeout (ms, 1000–600000), applied to both channels |
| `discussion.driverTimeoutMs` | number | `600000` | Driver generation timeout (deep-question / conclusion; ms, 1000–1200000) |
| `discussion.advisorTools` | string | `'readonly'` | Global default advisor tool scope when an advisor sets no own `tools`: `readonly` / `all` (every session-visible tool incl. writable — elevated risk, see Security) / `off`. Tool calling needs the direct-http (OpenAI/Anthropic) channel (requirements in **Security & privacy**). |
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
| `swarm.enabled` | boolean | `true` | Master switch for cross-session work; off makes `ask_session` / `list_sessions` / `ask_result` refuse instead of failing quietly |
| `swarm.defaultMode` | string | `'wait'` | Default reply mode: `wait` (blocking) or `detach` (deliver and return an `askId`); an explicit argument always wins |
| `swarm.defaultWaitMs` | number | `180000` | Default wait ceiling in ms (1000–600000) |
| `swarm.resultTtlHours` | number | `24` | How long detached results are kept, in hours (1–720); expired records are pruned on read |
| `swarm.rosterIncludeSubagents` | boolean | `false` | List subagent sessions in the roster |
| `swarm.routingEnabled` | boolean | `true` | With no named target, match candidates from the question (candidates only — never delivered automatically) |
| `swarm.routingTopN` | number | `3` | How many candidates to return (1–8) |
| `swarm.routingEngine` | string | `'local'` | `local` scoring, or `jev` which reranks a closed option set and falls back to local on any failure |
| `swarm.routingAsk` | string | `'gated'` | Whether a turn should consult another session: `off`, `gated` (local prefilter + Jev, default), `always` |
| `swarm.routingExclude` | string[] | `[]` | Sessions excluded from routing (a title keyword or an exact sessionId per line); naming one is refused |
| `ui.theme` | string | `retro-green` | Chat card theme (`retro-green` / `retro-amber` / `retro-blue`) |
| `ui.showTimestamps` | boolean | `true` | Show timestamps |
| `ui.autoExpand` | boolean | `true` | Auto-expand card |
| `advisors[].tools` | string | – | Per-advisor tool-scope override (`readonly`/`all`/`off`; unset follows the global default); in the settings card, direct-channel advisors get a dropdown, while built-in-channel advisors are told that the built-in route (DSH credentials) does not support tool calling and that `baseURL` / `apiKey` / `apiKeyEnv` enables it |
| `advisors[].thinking` | string | – | Per-advisor thinking mode: `enabled` / `disabled`; unset = provider default, and `disabled` forces no thinking block (mapped to `reasoningEffort: 'off'` on the built-in channel) |
| `advisors[].reasoningEffort` | string | – | Per-advisor thinking strength: `off` / `low` / `high` / `max`; unset = provider/model default, and `off` disables thinking per request |
| `advisors[].temperature` | number | – | Sampling temperature (0–2); unset = provider default |
| `advisors[].maxTokens` | number | – | Token cap for one answer (≥1); unset = provider default |
| `advisors[].authMode` | string | – | Anthropic direct-channel auth header style: `x-api-key` / `bearer` |
| `advisors[].avatar` | string | – | Short avatar shown on the card (emoji or ASCII) |
| `advisors` | array | `[]` | Advisor list (provider/model/baseURL/apiKey/apiKeyEnv/protocol…, keys are `role('secret')`) |

> `discussion.parallel` and `discussion.stopOnConsensus` are deprecated leftovers kept only for stored-config compatibility.

## 🧮 Daily quota

The plugin includes a cost safety valve. It tracks **new consultations** per UTC calendar day (default cap: 50), which can be adjusted or disabled in settings. The quota applies solely to newly initiated consultations. Resuming conversations via 「▶ 继续聊天」 (Resume chat) and follow-up prompts do not consume quota.

Evaluation and increment occur within a single synchronous block, preventing concurrency race conditions. The counter persists atomically to `$DSH_HOME/storages/advisor-group/daily-guard.json`, survives restarts, and resets at 00:00 UTC. When the quota is reached, `ask_advisors` aborts and returns an explanatory message. The settings page displays "today's remaining consultations X / Y" in real time. Disabling the cap continues tracking counts without blocking requests.

## 💸 Usage and cost

A single consultation consists of a chain of model calls. Under the default configuration (`maxRounds = 2`, up to 3 advisors), launching a new consultation involves **8** model calls: round 1 initiates 3 advisor calls; round 2 includes 1 driver follow-up and 3 advisor calls; finally, the driver generates 1 overall synthesis. If advisors invoke tools, each tool loop adds an extra model call (capped at 4 tool rounds per advisor, plus 1 final text response), so actual usage may exceed 8 calls.

Billing is calculated independently per channel. Advisors bill against their configured routes and models, while the driver model bills against the current session's model. To minimize expenses, you can lower `maxRounds`, reduce the number of advisors, set `tools: 'off'` for advisors, and configure an appropriate limit under **Daily quota**. If a consultation is interrupted, clicking 「▶ 继续聊天」 (Resume chat) only queries pending advisors without restarting the entire run, costing substantially less than a fresh consultation.

`ask_session` does not consume consultation quota. It simply wakes the target session to run a standard response turn billed to that session's own model, and does not count as a new advisor consultation.

## 🔒 Security & privacy

- Direct API keys can be stored in DSH `settings.yaml` (marked as secret, never returned to the browser by `describe`). If you prefer not to store keys on disk, use the `apiKeyEnv` environment variable mode.
- The `/advisor-group/*` routes utilize a per-boot shared token designed for single-user local setups. Add a reverse-proxy authentication layer before exposing ports to a local network or the public internet.
- Diagnostic endpoints resolve keys server-side before contacting providers, applying SSRF validation (HTTPS-only and loopback allowed). DNS rebinding is a known architectural boundary.
- For counting rules, storage paths, and reset schedules regarding the daily quota, see **Daily quota**.
- Classifier shadow mode: when `trigger.requireClassifier` is enabled, all classification samples are appended to the read-only endpoint `/advisor-group/shadow` (including forced triggers like `@顾问群` or repeated-question scenarios, tagged as `provider: 'bypass'`). This data is used exclusively for threshold tuning and never affects runtime logic.
- **`advisorTools: 'all'` is an elevated-risk scope.** It exposes all session-visible tools (including write and command execution tools such as `pwsh`, `bash`, and `write`) to advisor models under official guard pipelines. Enable this only for trusted local models. Tool calling requires the direct-http (OpenAI/Anthropic) channel; the DSH built-in channel reuses host credentials and cannot invoke tools. Configure `baseURL`, `apiKey`, or `apiKeyEnv` for any advisor needing tools. Every non-read-only tool execution triggers a `console.warn` audit log. The default recommendation is `readonly` or `off` (see read-only whitelist in **Features**).

## ⚠️ Known limitations

- If the DSH host crashes abruptly, an active card may continue displaying **LIVE** until refreshed (a disconnection notice is now displayed). Refreshing restores the true state from session logs.
- Risk notices are strictly fact-based rather than text-based. They track truncations (advisor streams interrupted by timeout or network drop) and cancellations (consultation stopped by user). Notices appear in stopped or completed cards and return to the main model via `ask_advisors`. Advisor responses are not scanned for keywords; text-heuristic matching was removed in v0.1.1 to avoid false positives on negative statements like 「没有任何风险」.
- Cross-session queries (`ask_session`) currently lack a per-session tool visibility toggle. When `swarm.enabled` is active, the three session tools remain visible across all sessions, relying on system prompts to limit usage to explicit user instructions. Mutual wait deadlocks between two sessions are not currently detected.

## 🛠️ Development

```sh
npm install --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm test        # vitest suite, incl. provider streaming contracts against a local fake LLM server
npm run build   # tsdown; client bundle must NOT be built with minify: true
```

## 📄 License

[Apache License 2.0](LICENSE) © 2026 dsh-advisor-group contributors.

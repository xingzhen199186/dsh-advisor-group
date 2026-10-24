# dsh-advisor-group

> Let one [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) session **borrow wisdom from other models** and **reuse the memory of other sessions**.

[中文](README.md) · [Installation](#compatibility-and-installation) · [Quick start](#quick-start) · [Core features](#core-features) · [Configuration](#configuration-reference) · [Development](#development)

[![npm version](https://img.shields.io/npm/v/dsh-advisor-group.svg)](https://www.npmjs.com/package/dsh-advisor-group)
[![DSH plugin](https://img.shields.io/badge/DSH%20plugin-dsh--plugin-3f8cff)](https://github.com/topics/dsh-plugin)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

| Capability | What it helps you do |
| --- | --- |
| **Multi-model consultation (Advisor Group)** | For professional, high-risk, or uncertain questions, let expert advisors answer in sequence before a driver model synthesizes their conclusions. |
| **Cross-session collaboration (global swarm)** | Ask another existing session and reuse the code it read, the investigation it completed, and the decisions it settled instead of starting over. |
| **Advisor Corps role cards** | Assign a name and duty to a session. You can then say “ask 小明” without remembering its title or sessionId. |

> **Version boundary**: this page tracks the current `main`. npm `0.1.4` does not yet include Advisor Corps role cards, batch asks through `ask_sessions`, automatic answer copy-back, or the related wait-state improvements. [Install from source](#install-from-source-main) to use those additions. See [Releases](https://github.com/xingzhen199186/dsh-advisor-group/releases) and [CHANGELOG](CHANGELOG.md) for the documentation attached to each published version.

<img width="865" height="983" alt="An Advisor Group consultation card showing actions, thinking, tool calls, and the final response in step order" src="https://github.com/user-attachments/assets/dad2f2be-acf6-41d7-b61a-c11596e48408" />

## Compatibility and installation

| Item | Details |
| --- | --- |
| DSH | The current development baseline is `0.2.1-rc.3`; the declared peer range is `>=0.1.7-rc.2 <0.3.0` |
| Node.js | Required for source builds: `^22.19.0 || >=24.0.0` |
| Applications | DSH Web and the desktop app, sharing the same client bundle |

Earlier versions inside the peer range have not all been re-verified on a live host. Cross-session features also require the host to provide `sessionController`; the related tools report an explicit error when it is unavailable, while multi-model consultation remains unaffected.

### Install from npm

For DSH Web:

```sh
dsh plugin --profile web add dsh-advisor-group
```

Restart DSH Web the way you normally do, then hard-refresh the browser (`Ctrl+Shift+R`).

**Desktop app**: open **Plugins → Add plugin** inside the app and enter `dsh-advisor-group`. The desktop app owns its profile; `dsh plugin --profile desktop …` is refused by design, not because your permissions are insufficient.

### Install from source (main)

```sh
git clone https://github.com/xingzhen199186/dsh-advisor-group.git
cd dsh-advisor-group
npm install --legacy-peer-deps --no-audit --no-fund
npm run build
npm pack

# Use the actual filename printed by npm pack.
# The current package.json version is 0.1.4, producing:
dsh plugin --profile web add ./dsh-advisor-group-0.1.4.tgz
```

For a source-built desktop installation, enter the `.tgz` file's absolute path under **Plugins → Add plugin**. Restart the corresponding DSH application after installation.

## Quick start

### Path 1: consult several models

1. Open **Settings → Plugins → 顾问群 (Advisor Group)**.
2. Add at least one advisor and select its provider route and model. Use **获取模型列表** (Fetch model list) to retrieve the route's model catalogue.
3. Prefix your question with `@顾问群` and include the necessary background. For example:

   ```text
   @顾问群 Review this plugin's cross-session collaboration design.
   Background: DSH Web and desktop share one codebase. The design must never deliver automatically or guess a target session.
   ```

`@顾问群` forces a consultation. The main model can also escalate ordinary professional questions under its routing rules, including when the same unresolved question appears three times or its reported confidence falls below the threshold.

### Path 2: ask another session by role name

1. Open the **顾问团 (Advisor Corps)** tab in any conversation. If the tab bar runs out of space, it may appear under the **…** menu.
2. Fill in **身份姓名** (Role name) and **主要负责** (Main responsibility) for the target session, then click **加入顾问团** (Add to Advisor Corps) or **保存** (Save). Alternatively, click **用主模型生成** (Generate with main model), review the suggestions, and save them individually or through **保存全部更改** (Save all changes).
3. Return to the conversation and ask naturally:

   ```text
   Ask 小明: what changed in the Advisor Corps role cards today?
   ```

   Or ask several members at once:

   ```text
   Ask 小明 and 阿龙: review this design for desktop and Web omissions respectively, then combine both conclusions.
   ```

Generated cards only fill drafts; **they take effect only after you save them, and existing cards are never overwritten**. Session titles, working-directory names, and sessionIds remain valid target spellings.

## Core features

### Multi-model consultation: deepen the discussion automatically

One `ask_advisors` call runs the whole consultation:

```text
Original question
  → Round 1: Advisor A → Advisor B (sees A) → Advisor C (sees A and B)
  → Later rounds: a deeper driver question → the same advisor relay
  → A synthesis from the driver model
```

- **Controlled rounds**: `maxRounds` ranges from 1 to 5 and defaults to 2. With `autoDeepen` disabled, later rounds repeat the original question; the final synthesis is still generated.
- **No separate driver route to configure**: the driver writes follow-ups and the synthesis through the current session's provider and model. It falls back to `discussion.driverModel` when that route cannot be read.
- **Advisors can use session tools**: the default scope is read-only. Calls appear in the card, and after at most four tool rounds the advisor must answer in text. Set the scope globally or override it per advisor.
- **A streaming card that preserves the process**: the green CRT card renders `📋 Action → 💭 Thinking → ⛭ Tool → 📄 Response`. Thinking and tool details start collapsed; the response starts expanded.
- **Resume from the checkpoint**: after a manual stop or host restart, **▶ 继续聊天** (Resume chat) completes only the missing advisors and rounds instead of asking completed advisors again.
- **Optional Jev pre-classification**: off by default. When enabled, Jev can judge whether advisors are needed, whether the request is high-risk, and whether web search is more appropriate. Failures fall back to the local rule-based classifier.
- **28 provider presets across 12 platforms**: DeepSeek, Moonshot Kimi, Kimi Code, Aliyun Bailian, Zhipu AI, OpenAI, Claude, Gemini, SiliconFlow, AIHubMix, OpenRouter, and OpenCode Go.

### Advisor Corps: give each session a durable identity

A session title describes a window, but it may not be a durable way to address that session. Advisor Corps binds a **name and duty** to the session id and stores it locally in `$DSH_HOME/storages/advisor-group/corps.json`; it never renames the session.

- Names are globally unique and case-insensitive, with a 40-character limit. Duties can contain up to 200 characters.
- **Generate with main model** uses the model of the **currently open conversation**. Each pass proposes cards for at most 12 unassigned sessions, fills drafts only, and never saves automatically.
- Edit rows, copy role names, save in batch, or remove cards. Cards whose sessions are archived, excluded, outside every workspace, or no longer present appear under **未挂接** (Unlinked), where you can keep or delete them.
- `list_sessions` includes role names and duties. `ask_session` and `ask_sessions` accept an exact role name, which takes precedence over a session title with the same name.

### Cross-session collaboration: ask one session or a group

- **Single-session asks**: `ask_session` waits synchronously by default. With `detach: true`, it returns an `askId` immediately so you can read the result later through `ask_result`.
- **Batch asks**: `ask_sessions` sends one question to 1–8 explicit targets. `mode: 'all'` waits for every target; `mode: 'any'` returns when the first target settles while the others continue and write their own records.
- **Automatic answer copy-back**: `swarm.deliverBack` is enabled by default. Answers that finish as `done` are copied back into the asking session; timeouts and errors are not. A batch combines all completed answers into one copy-back message.
- **Traceable results**: every delivered target gets its own `askId`. An asynchronous record can be `waiting`, `done`, `timeout`, `error`, or `interrupted`; the last state means a host restart prevented the wait from completing.
- **No guessed targets**: when `ask_session` has no target, routing returns candidates without delivering anything. `ask_sessions` performs no routing; unresolved, ambiguous, or excluded targets are reported in its skipped list with reasons.
- **Explicit collaboration guards**: at most two relay hops; no self or subagent targets; one waiting `ask_session` per asking session; a 32,000-byte combined limit for question and context; and no cancellation of a target turn when the wait times out.

> **What the returned text means**: the tool collects everything the target says between the **delivery receipt** and its next **whole-session idle**. It is not guaranteed to be a one-to-one answer to your question. The `status` field (`ok` / `partial` / `failed`) describes the reliability of that collection.

## Model tool reference

The main model calls these tools inside a conversation. **They are not slash commands, and you do not need to write tool arguments yourself.** Cross-session tools should be used only when you explicitly ask to contact another session or window.

| Tool | Purpose |
| --- | --- |
| `ask_advisors` | Start a multi-model consultation, or append a round with `sessionId + followUp` |
| `ask_session` | Ask one existing session; supports waiting, detached delivery, and candidate routing |
| `ask_sessions` | Ask 1–8 explicit targets in a batch; supports `all` and `any` collection modes |
| `list_sessions` | Read session titles, directories, activity, and Advisor Corps names and duties without waking anyone |
| `ask_result` | Read one asynchronous result by `askId`, or list recent asks started by this session |
| `toggle_advisor_group` | Enable or disable multi-model consultation and persist the setting |

## Configuration reference

For everyday use, these are the settings you are most likely to adjust:

| Key | Default | When to adjust it |
| --- | --- | --- |
| `discussion.maxRounds` | `2` | Lower it to reduce cost, or raise it up to 5 for a deeper discussion |
| `discussion.maxAdvisorsPerCall` | `3` | Control how many advisors join one consultation, from 1 to 10 |
| `discussion.advisorTools` | `'readonly'` | Use `'off'` to disable advisor tools; reserve `'all'` for fully trusted scenarios |
| `quota.enabled` / `quota.maxPerDay` | `true` / `50` | Set the daily new-consultation cap; counts continue when the cap is disabled |
| `swarm.defaultMode` | `'wait'` | Use `'detach'` to make cross-session asks asynchronous by default |
| `swarm.defaultWaitMs` | `180000` | Adjust the default wait ceiling, from 1000 to 600000 ms |
| `swarm.deliverBack` | `true` | Disable it to read completed answers only through `ask_result`, without automatic copy-back |

<details>
<summary><strong>Expand the complete configuration reference</strong></summary>

### Discussion and advisors

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable multi-model consultation |
| `discussion.maxRounds` | number | `2` | Total consultation rounds, 1–5 |
| `discussion.maxAdvisorsPerCall` | number | `3` | Maximum advisors in one consultation, 1–10 |
| `discussion.autoDeepen` | boolean | `true` | Generate a deeper driver question before later rounds; when off, repeat the original question and still synthesize a conclusion |
| `discussion.driverModel` | object | – | Fallback `{ provider, model }` when the current session route cannot be read |
| `discussion.advisorTimeoutMs` | number | `600000` | Per-advisor timeout, 1000–600000 ms |
| `discussion.driverTimeoutMs` | number | `600000` | Timeout for a follow-up or synthesis, 1000–1200000 ms |
| `discussion.advisorTools` | string | `'readonly'` | Default advisor tool scope: `readonly` / `all` / `off` |
| `advisors` | array | `[]` | Advisor list, including `provider`, `model`, `systemPrompt`, and optional `baseURL`, `apiKey`, `apiKeyEnv`, `protocol`, and related fields |
| `advisors[].tools` | string | – | Per-advisor tool scope; unset follows `discussion.advisorTools` |
| `advisors[].thinking` | string | – | `enabled` / `disabled`; unset follows the provider default |
| `advisors[].reasoningEffort` | string | – | `off` / `low` / `high` / `max`; unset follows the provider or model default |
| `advisors[].temperature` | number | – | Sampling temperature, 0–2 |
| `advisors[].maxTokens` | number | – | Token limit for one answer, at least 1 |
| `advisors[].authMode` | string | – | Anthropic direct-channel authentication header: `x-api-key` / `bearer` |
| `advisors[].avatar` | string | – | Short card avatar, using an emoji or ASCII text |

Advisor tool calling is supported only on direct OpenAI / Anthropic channels. The DSH built-in channel can reuse host credentials for ordinary responses, but it does not support this advisor tool loop.

### Triggers and Jev

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `trigger.requireClassifier` | boolean | `true` | Run pre-classification before a non-forced consultation |
| `trigger.allowWebFallback` | boolean | `true` | Return a no-consultation hint when the classifier recommends web search |
| `trigger.confidenceThreshold` | number | `0.6` | Allow escalation below this main-model confidence score, from 0 to 1 |
| `trigger.jev.enabled` | boolean | `false` | Use Jev for semantic pre-classification; failures fall back to local rules |
| `trigger.jev.provider` / `trigger.jev.model` | string | `'typesafe'` / `'jev-latest'` | Jev route and model; the route can also be `openrouter` |
| `trigger.jev.baseURL` | string | – | Optional custom Jev endpoint |
| `trigger.jev.apiKey` / `trigger.jev.apiKeyEnv` | string | – | Jev key or the environment variable containing it; key fields are treated as secrets |
| `trigger.jev.timeoutMs` | number | `10000` | Jev request timeout, 1000–60000 ms |
| `trigger.jev.confidenceThreshold` | number | `0.6` | Threshold for deciding that advisors are needed |
| `trigger.jev.highRiskThreshold` | number | follows the previous setting | High-risk threshold; unset follows `trigger.jev.confidenceThreshold` |
| `trigger.jev.useEnglishState` | boolean | `false` | Let Jev read the caller-provided English gist `questionEn`; cards and session records keep the original question |

### Global swarm

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `swarm.enabled` | boolean | `true` | Cross-session master switch; when off, all four cross-session tools refuse explicitly |
| `swarm.defaultMode` | string | `'wait'` | Default `ask_session` behavior: `wait` / `detach` |
| `swarm.defaultWaitMs` | number | `180000` | Default wait ceiling, 1000–600000 ms |
| `swarm.resultTtlHours` | number | `24` | How long asynchronous results are retained, 1–720 hours |
| `swarm.deliverBack` | boolean | `true` | Copy `done` answers back automatically; never auto-copy `timeout` / `error` |
| `swarm.rosterIncludeSubagents` | boolean | `false` | Show subagents in the roster; delivery tools still refuse subagent targets |
| `swarm.routingEnabled` | boolean | `true` | Suggest candidates when `ask_session` has no target; never deliver automatically |
| `swarm.routingTopN` | number | `3` | Number of candidates, 1–8 |
| `swarm.routingEngine` | string | `'local'` | `local` ordering or `jev` reranking of a closed candidate set; failures fall back to local |
| `swarm.routingAsk` | string | `'gated'` | Whether to suggest a cross-session ask: `off` / `gated` / `always`; a suggestion never delivers |
| `swarm.routingExclude` | string[] | `[]` | Sessions excluded from the swarm, its roster, and its candidates; direct asks are refused too |

### Legacy compatibility fields

`discussion.parallel` and `discussion.stopOnConsensus` are deprecated and retained only so stored configurations remain readable.

`ui.theme`, `ui.showTimestamps`, and `ui.autoExpand` are also legacy fields. The current client does not read them, so changing them has no effect on the card's appearance or expansion behavior. The current card uses a green CRT style; thinking and tool details start collapsed.

</details>

## Usage, quota, and cost

A consultation that completes `R` rounds with `N` advisors and no tool calls normally makes **`R × (N + 1)` model calls**: `R × N` advisor responses, `R - 1` deepening questions, and one final synthesis. With the default `R = 2` and three advisors actually participating, this produces 8 calls.

Actual usage also depends on these behaviors:

- Advisor tool loops add model calls. The driver and every advisor are billed through their respective routes.
- Generating role cards calls the current conversation's model. Jev classification or routing is also billed through its configured route when enabled.
- Cross-session asks do not consume the advisor-consultation quota, but they wake target sessions and consume each target's own model quota. Batch asks are accounted for per target.

The daily quota counts **new consultations per UTC calendar day**, with a default cap of 50. Resumes, follow-up rounds, and cross-session asks do not consume this quota. The counter lives in `$DSH_HOME/storages/advisor-group/daily-guard.json`; disabling the cap keeps counting without blocking requests. To control cost, reduce rounds or advisors, disable advisor tools, and set a daily cap.

## Security and privacy

- **Keys are not returned to the browser**: direct API keys are stored in the local DSH configuration under `SecretField` semantics. Use `apiKeyEnv` if you prefer not to write a key into that configuration.
- **Local routes require a token**: `/advisor-group/*` uses a shared token generated at startup and is designed for a local single-user setup. Add reverse-proxy authentication before exposing it to a LAN or the public internet.
- **Diagnostic requests are constrained**: model-list and connection-test calls run server-side and validate the target URL, protocol, and redirects. DNS rebinding remains a known architectural boundary.
- **Use `advisorTools: 'all'` with care**: it exposes every session-visible tool to advisors, including file writes and command execution. Calls still pass through DSH's tool pipeline and permission guards. Keep `readonly` or `off` for everyday use; non-read-only tool calls emit warning logs.
- **Cross-session content leaves a record**: questions and context are permanently recorded in target session logs, so send only what is necessary. Role-card generation sends session titles, working directories, and activity hints to the current main model. The cards themselves are stored locally and contain no API keys.
- **Local state is centralized**: consultation snapshots, asynchronous ask records, role cards, and quota data live under `$DSH_HOME/storages/advisor-group/`. Classifier shadow logs are used only for threshold tuning and do not influence runtime decisions.

## Known limitations

- After an abrupt DSH host crash, an unrefreshed card may still display **LIVE**. Refreshing restores its actual state from the persisted session log; the client already shows a disconnection notice.
- Risk notices are based on objective events: truncation caused by timeout or network interruption, and cancellation caused by a manual stop. The plugin no longer guesses risk by scanning advisor prose for words such as “risk” or “uncertain”.
- Cross-session tools have no per-session visibility switch. When `swarm.enabled` is on, all four tools are visible to sessions; when off, calls are refused explicitly. Mutual waits between two sessions are not specifically detected as deadlocks.
- The Advisor Corps panel displays at most 50 visible sessions. Automatic generation handles at most 12 unassigned sessions per pass; run it again to continue filling the roster.

## Development

```sh
npm install --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The Vitest suite covers provider streaming contracts, cross-session delivery and waits, role cards, settings redaction, and recovery boundaries. Builds use tsdown. The client bundle **must not use `minify: true`**, because minification breaks the plugin-id form required by the startup guard.

- [Changelog](CHANGELOG.md)
- [Issue tracker](https://github.com/xingzhen199186/dsh-advisor-group/issues)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## License

[Apache License 2.0](LICENSE) © 2026 dsh-advisor-group contributors.

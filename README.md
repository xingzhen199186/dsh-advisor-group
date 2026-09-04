# dsh-advisor-group

A DeepSeek Harness (DSH) plugin that lets the main model consult expert advisor models in a retro chat-group card when the question is professional, long-tail world knowledge, high-risk, or uncertain. It also force-activates when the user `@顾问群`-mentions the group or repeats the same question three times without resolution.

Advisor responses stream in real time (thinking chain + Markdown body). The main model drives cross-round discussion through `sessionId + followUp`; `maxRounds` caps the total number of rounds.

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.1.2-rc.1` (adapted from `0.1.1-rc.2`) |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | DSH Web (client bundle); host logic runs in headless too |

## What it does

- `ask_advisors`: starts a consultation and runs the **auto-deepen pipeline** (2026-09-05): up to `maxRounds` rounds of `[driver deep-question → advisor A → advisor B (sees A) → advisor C (sees A+B) → …]` in sequential relay, closed by a driver-generated conclusion. Each advisor sees the project background + the main question + every prior answer in the same round; the driver reuses the current agent's provider/model (session `request/header`, fallback `discussion.driverModel`).
- `toggle_advisor_group`: enables/disables the plugin at runtime and persists the flag to settings.
- Triggers: `@顾问群` mention, same-question-repeated-3-times escalation, or main-model `confidence` below threshold.
- Dual streaming path: DSH `ctx.llm` and direct HTTP (OpenAI/Anthropic/Gemini) both publish incremental deltas to SSE and the durable session log.
- SSE stream `/advisor-group/stream` with `eventId`/`bootId`, a 500-frame / 5-minute replay buffer, and `resync` events on restart or gap.
- Retro CRT chat card: thinking panel expanded by default with auto-scroll; advisor Markdown rendering (headings, lists, code blocks, quotes, links, **tables**).
- Settings tab: Settings → Plugins → Advisor Group — a collapsible plugin card (header + chevron, registered into the `settings.plugin.item` keyed slot keyed by the `advisor-group` namespace), at the same level as the built-in Web Search / Bash cards.
- Security/cost: masked API keys on read, token-auth on `/advisor-group/*` routes, atomic 50-consultations/day guard.

## 0.1.2-rc.1 migration notes

The client bundle was migrated to the 0.1.2-rc.1 conversation contract:

- `@deepseek-ai/dsh-client-runtime` no longer exists at `0.1.2-rc.1`; conversation types (`ConversationNodeDefinition`, `ConversationLocation`, `ConversationStepDataMap`) now come from `@deepseek-ai/dsh-client-ui-conversation/client`, chat renderer types (`ChatNodeDataMap`, `ChatNodeViewProps`) from `@deepseek-ai/dsh-client-ui-chat/client`, and the `slots` service declaration from `@deepseek-ai/dsh-client-ui-renderer/client`.
- Node registration moved from `ctx.conversationEvents.register(...)` to `ctx.uiConversation.events.register(definition)` (`inject` is now `['uiConversation', 'slots', 'locale']`).
- The settings card slot changed from `settings.plugins.tab` (list slot, `id`/`order`/`label`) to the keyed `settings.plugin.item` slot (`key: 'advisor-group'`), declared by `@deepseek-ai/dsh-client-ui-settings-plugins`.
- Host: `settingsNamespace()` was removed — pass the `'advisor-group'` literal (branded as `SettingsNamespace`) directly; `Session.events` was replaced by `Session.snapshotEvents()`.
- Durable plugin events keep mutating `KNOWN_SESSION_EVENT_TYPES` (see `src/session-events-host.ts`): 0.1.2-rc.1's official mechanism is the `SessionEvent.ignorable` envelope marker, which `Session.append()` still does not expose to plugin writers.

## Install

```sh
npm run build
npm pack --pack-destination .
dsh plugin --profile web remove dsh-advisor-group  # if an old version is installed
dsh plugin --profile web add ./dsh-advisor-group-0.1.0.tgz
```

Restart DSH web and hard refresh the browser (`Ctrl+Shift+R`) after install.

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable advisor group |
| `discussion.maxRounds` | number | `2` | **Total rounds of the auto-deepen pipeline** (each round = driver deep-question + all advisors in relay) |
| `discussion.maxAdvisorsPerCall` | number | `3` | Max advisors per call (1-10) |
| `discussion.parallel` | boolean | `true` | **Deprecated** (2026-09-05): rounds are a sequential relay; kept for stored-config compatibility, no longer rendered |
| `discussion.autoDeepen` | boolean | `true` | Run the auto-deepen pipeline: after each round the driver model asks a deeper follow-up; a final conclusion closes the consultation |
| `discussion.driverModel` | object | – | Fallback driver model `{provider, model}` used when the session header cannot be read |
| `discussion.stopOnConsensus` | boolean | `false` | **Deprecated** (2026-09-05): dormant under the auto-deepen pipeline; kept in schema only for stored-config compatibility |
| `discussion.advisorTimeoutMs` | number | `120000` | Per-advisor call timeout (ms, 1000-600000), applied to both ctx.llm and direct-http |
| `trigger.requireClassifier` | boolean | `true` | Run the pre-classifier before starting |
| `trigger.allowWebFallback` | boolean | `true` | Allow classifier to recommend web search |
| `trigger.confidenceThreshold` | number | `0.6` | Escalate when main-model confidence is below this |
| `ui.theme` | string | `retro-green` | Chat card theme |
| `ui.showTimestamps` | boolean | `true` | Show timestamps |
| `ui.autoExpand` | boolean | `true` | Auto-expand card |
| `advisors` | array | `[]` | Advisor list (provider/model/baseURL/apiKey/apiKeyEnv/protocol…) |

Configuration is validated by the Schemastery `Config` schema in `src/config.ts` and persisted through `ctx.settings`.

## Development

```sh
npm install --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

Note: the client bundle must NOT be built with `minify: true`; otherwise `dsh-startup-guard` may mis-detect the bundle registration and auto-disable the plugin. See `开发注意事项.md`.

## Verification

- `typecheck` / `build` pass
- `vitest`: 64 tests — classifier 4, client round matching 3, Markdown link/table/XSS 5, SSE replay/resync 3, settings API key reconcile 21 (incl. SecretField semantics), diagnostic key resolution 5, diagnostic SSRF guard 6, settings secret redaction 5, session event registration 1, **provider contract 10** (OpenAI/Anthropic/Gemini streaming + faults against a local fake LLM server, configurable timeout, non-stream path, ctx.llm adapter), model validation 2, shadow samples 3, **driver model + relay prompts 5** (auto-deepen pipeline)
- End-to-end RPC: `start → delta → message(round=1) → end`; after follow-up `main follow-up → message(round=2) → end`
- Route auth: 401 without token, 200 with the token injected into the index, config key masked

## Security notes

- Direct API keys are stored **in plain text** in the DSH `settings.yaml` (or via `apiKeyEnv` on the host environment). Prefer `apiKeyEnv`; never commit or sync the DSH profile with direct keys inside.
- The `/advisor-group/*` routes use a per-boot shared token for local single-user use — **not** multi-user auth; add a reverse-proxy auth layer before LAN exposure.
- Diagnostics endpoints (`/advisor-group/models`, `/advisor-group/test-connection`) resolve the real key server-side, validate the target base URL against an https-only / loopback SSRF guard (no IP literals, no cloud metadata hosts, no redirects), and return only status + count. DNS-rebinding protection is a documented out-of-scope limitation.
- The daily consultation counter is persisted (UTC day key) to `$DSH_HOME/storages/advisor-group/daily-guard.json`, so a restart no longer resets the quota. The counter's atomicity remains a single synchronous check-and-increment in the host process.
- **Classifier shadow mode**: every non-forced `ask_advisors` classification appends one sample (question truncated to 200 chars, self-assessed confidence, verdict, reason) to `$DSH_HOME/storages/advisor-group/classifier-shadow.jsonl` for threshold tuning — read-only overview via `GET /advisor-group/shadow` (token-auth: last 200 samples + totals). It never influences behavior.

## Known limitations

- Disconnecting the SSE stream does not abort in-flight advisor calls (per-advisor timeout — configurable via `discussion.advisorTimeoutMs`, default 120s — is the fallback; refreshing keeps the consultation completing in the background so the durable card comes back complete).
- Lightweight Markdown renderer does not support nested lists, inline HTML, or complex tables.
- Provider preset default model lists are near-value best guesses from the local knowledge base, NOT verified against each platform's current catalog — `ask_advisors` refuses to start (with a precise reason) while any advisor has an empty model, and the settings card marks such a field red; use "获取模型列表" to pull the authoritative list.

## License

[Apache License 2.0](LICENSE) © 2026 dsh-advisor-group contributors.

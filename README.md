# dsh-advisor-group

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that lets the main model consult **multiple expert advisor models** in a retro chat-group card — for professional, long-tail world-knowledge, high-risk, or uncertain questions.
>
> Advisor responses stream in real time (dual channel: DSH `ctx.llm` with a direct-http fallback) and survive disconnects via resumable SSE replay.

[![dsh-plugin](https://img.shields.io/badge/DSH%20plugin-dsh--plugin-3f8cff)](https://github.com/topics/dsh-plugin)

📖 [中文文档 / Chinese: README.zh.md](README.zh.md)

---

## ✨ Features

- **Auto-deepen consultation pipeline** — one `ask_advisors` call runs up to `maxRounds` rounds automatically: each round is a *driver deep-question → advisor A → advisor B (sees A) → advisor C (sees A+B) → …* sequential relay, closed by a driver-generated synthesis conclusion.
- **Zero-config driver model** — the driver formulation of deep follow-ups reuses the current agent's provider/model, so no extra API key or model setup is needed; it falls back to `discussion.driverModel` when the session header is unavailable.
- **Three ways to activate** — `@顾问群` mention (force-start), same question repeated 3 times without resolution, or main-model self-assessed confidence below the threshold.
- **Retro CRT chat cards** — green/amber/blue CRT themes, scanlines, LIVE/DONE headers, auto-expanded thinking panel with auto-scroll; advisor Markdown rendered with a link-protocol whitelist (headings, lists, code, quotes, links, tables).
- **Provider presets (11 platforms · 26 presets)** — DeepSeek, Moonshot Kimi, Kimi Code, Aliyun Bailian, Zhipu AI, OpenAI, Claude, Gemini, SiliconFlow, AIHubMix, OpenRouter (OpenAI/Anthropic-compatible variants included).
- **Security-minded by design** — API keys use official `SecretField` semantics (never returned to the browser; `apiKeysByProvider` key history is server-side only), SSRF-guarded diagnostics (https-only / loopback, no IP literals, no redirects), per-boot token auth on `/advisor-group/*` routes, and an atomic 50 consultations/day quota persisted across restarts.
- **Runtime toggle** — `toggle_advisor_group` enables/disables the plugin and persists the flag to settings.

## ✅ Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.1.2-rc.1` |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Platforms | DSH Web (client bundle) + headless host logic |

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
> dsh plugin --profile web add ./dsh-advisor-group-0.1.0.tgz   # after npm pack
> ```

## 🚀 Quick start

1. Restart DSH web and hard-refresh the browser (`Ctrl+Shift+R`).
2. Go to **Settings → Plugins → Advisor Group**: configure your advisors (provider route + model; use *获取模型列表* to pull the authoritative model list) and tune `maxRounds`, thresholds, and the UI theme.
3. Just start a conversation:
   - type `@顾问群` in your question to force a consultation, or
   - ask a professional/uncertain question — the plugin escalates automatically when appropriate.

`ask_advisors` tools available to the model: `ask_advisors`, `toggle_advisor_group`.

## ⚙️ Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable advisor group |
| `discussion.maxRounds` | number | `2` | Total rounds of the auto-deepen pipeline (each round = driver question + all advisors in relay) |
| `discussion.maxAdvisorsPerCall` | number | `3` | Max advisors per call (1–10) |
| `discussion.autoDeepen` | boolean | `true` | Run the auto-deepen pipeline (driver follow-ups + final synthesis) |
| `discussion.driverModel` | object | – | Fallback driver model `{provider, model}` when the session header cannot be read |
| `discussion.advisorTimeoutMs` | number | `120000` | Per-advisor call timeout (ms, 1000–600000), applied to both channels |
| `trigger.requireClassifier` | boolean | `true` | Run the pre-classifier before starting |
| `trigger.allowWebFallback` | boolean | `true` | Allow classifier to recommend web search |
| `trigger.confidenceThreshold` | number | `0.6` | Escalate when main-model confidence is below this |
| `ui.theme` | string | `retro-green` | Chat card theme (`retro-green` / `retro-amber` / `retro-blue`) |
| `ui.showTimestamps` | boolean | `true` | Show timestamps |
| `ui.autoExpand` | boolean | `true` | Auto-expand card |
| `advisors` | array | `[]` | Advisor list (provider/model/baseURL/apiKey/apiKeyEnv/protocol…, keys are `role('secret')`) |

> `discussion.parallel` and `discussion.stopOnConsensus` are deprecated leftovers kept only for stored-config compatibility.

## 🔒 Security & privacy

- Direct API keys can be stored in the DSH `settings.yaml` (marked secret, never returned to the browser by `describe`); prefer `apiKeyEnv` (env-var mode) if you don't want keys on disk.
- `/advisor-group/*` routes use a per-boot shared token for local single-user use — **not** multi-user auth. Add a reverse-proxy auth layer before LAN exposure.
- Diagnostics endpoints resolve the real key server-side and validate the target URL against an https-only / loopback SSRF guard; DNS-rebinding protection is a documented out-of-scope limitation.
- Daily quota (50 new consultations) is persisted to `$DSH_HOME/storages/advisor-group/daily-guard.json` (UTC day key), so restarts don't reset it.
- Classifier shadow mode appends one observation sample per non-forced classification (read-only `/advisor-group/shadow`), used for threshold tuning only — never influences behavior.

## 🛠️ Development

```sh
npm install --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm test        # 64 tests, incl. provider streaming contracts against a local fake LLM server
npm run build   # tsdown; client bundle must NOT be built with minify: true
```

## 📄 License

[Apache License 2.0](LICENSE) © 2026 dsh-advisor-group contributors.

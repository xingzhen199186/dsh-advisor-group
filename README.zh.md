# dsh-advisor-group

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：主模型在遇到**专业、长尾世界知识、高风险或不确定**的问题时，召集多位**专家顾问模型**，在复古 CRT 聊天组卡片中真流式对话。

[![dsh-plugin](https://img.shields.io/badge/DSH%20plugin-dsh--plugin-3f8cff)](https://github.com/topics/dsh-plugin)

[English: README.md](README.md)

---

<img width="865" height="983" alt="1788679983177" src="https://github.com/user-attachments/assets/5660ce94-70f0-42ed-84e4-9f926d1e2c64" />

## ✨ 功能特性

- **自动深挖咨询流水线**：一次 `ask_advisors` 自动跑满 `maxRounds` 轮——每轮 = *驱动模型深挖追问 → 顾问 A → 顾问 B（看到 A）→ 顾问 C（看到 A+B）→ …* 顺序接力，最后驱动模型产出**综合结论**。
- **顾问可调用会话工具（2026-09-05）**：顾问模型回答前可调用**当前 DSH 会话可见的工具**（默认只读白名单：read/grep/glob/web_search/web_fetch…）——走官方 `ctx.tools` 完整管线（作用域分发、守卫、前置/后置策略），循环上限 4 轮后强制文字作答；每次调用在卡片 💭 面板实时播报（`🔧 模型请求调用工具…`+结果摘要）。可在设置中切到「全部会话工具」或「关闭」。
- **停止后可继续**：用户停止或 dsh 重启后，卡片「⏹ 停止」原位变为「▶ 继续聊天」→ `POST /advisor-group/resume` → 从断点续跑（本轮未答的顾问补答、已答的不重问、剩余轮次照常、最终照常生成综合结论）；会话快照持久化到 `storages/advisor-group/sessions/<id>.json`（仅存顾问 id/消息/状态，不含任何凭据），跨重启自动恢复。
- **驱动模型零配置复用**：深挖追问由驱动模型生成，直接复用会话当前 agent 的 provider/model——无需额外配 Key 或模型；会话头不可读时回退 `discussion.driverModel`。
- **三种触发方式**：`@顾问群` 提及（强制启动）、同一问题重复 3 次未解决、主模型自评置信度低于阈值。
- **Jev 语义前置分类（可选，默认关闭）**：开启 `trigger.jev.enabled` 后，未强制启动的咨询先由配置的 Jev 模型语义判断（是否该找顾问 / 是否高风险 / 是否更适合联网，阈值在 `trigger.jev.*`）；Jev 不可用时仍由本地规则分类器判定。`trigger.jev.useEnglishState` 开启后，判定改读主模型附带的英文概要（`questionEn`），展示与会话记录仍用中文。
- **复古 CRT 聊天组卡片**：绿/琥珀/蓝三主题、扫描线、LIVE/DONE 标题、💭 思考面板默认展开自动滚底；顾问正文走轻量 Markdown 渲染（链接协议白名单，支持标题/列表/代码/引用/链接/表格）。
- **供应商预设（11 平台 · 26 预设）**：DeepSeek、月之暗面 Kimi、Kimi Code、阿里云百炼、智谱 AI、OpenAI、Claude、Gemini、硅基流动、AIHubMix、OpenRouter（含 OpenAI / Anthropic 兼容变体）。
- **注重安全**：API Key 采用官方 `SecretField` 语义（浏览器永不回显；`apiKeysByProvider` 供应商密钥档案仅存服务端）；诊断端点 SSRF 加固（仅 https/loopback、拒绝 IP 字面量与重定向）；`/advisor-group/*` 路由启动期 token 鉴权；每日新咨询**可配置原子配额**（默认 50，可关闭），持久化跨重启。
- **运行时开关**：`toggle_advisor_group` 启停插件并持久化到设置。

## ✅ 兼容性

| 项目 | 状态 |
|---|---|
| Harness | DeepSeek Harness `0.1.7-rc.2` → `0.2.x`（含 `0.2.0-rc.1`） |
| Node | `^22.19.0 \|\| >=24.0.0` |
| 平台 | DSH Web 与桌面端（共用同一份客户端 bundle）+ headless 宿主逻辑 |

## 📦 安装

```sh
# 1. 安装插件（一个包全都有）
dsh plugin --profile web add dsh-advisor-group

# 2. 重启 dsh web
npx @deepseek-ai/dsh web
```

> **从源码开发安装**
> ```sh
> npm install --legacy-peer-deps --no-audit --no-fund
> npm run build
> dsh plugin --profile web add ./dsh-advisor-group-<版本>.tgz   # 先 npm pack（版本号见 package.json）
> ```

> **桌面端**：桌面端应用的配置清单由应用自己管理，命令行 `dsh plugin --profile desktop …` 会被拒绝（这是官方设计，不是权限问题）。请在桌面端里安装：侧栏 **Plugins** → **Add plugin**，填入包名或本地 tarball 的绝对路径。

## 🚀 快速开始

<img width="791" height="797" alt="2026_09_06_15_35_31" src="https://github.com/user-attachments/assets/52a5b9fe-1ee9-4980-9b97-73bf616f36eb" />


1. 重启 dsh web 并硬刷新浏览器（`Ctrl+Shift+R`）。
2. 打开 **设置 → 插件 → 顾问群**：配置顾问（提供商路由 + 模型，用「获取模型列表」拉取权威清单），按需调整 `maxRounds`、阈值与 UI 主题。
3. 直接开聊：
   - 提问时带 `@顾问群` 强制发起咨询，或
   - 直接提专业/不确定的问题——插件会按需自动升级。

模型可用工具：`ask_advisors`、`toggle_advisor_group`。

## ⚙️ 配置项

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 启用顾问群 |
| `discussion.maxRounds` | number | `2` | 自动深挖流水线总轮数（每轮 = 驱动追问 + 全体顾问接力） |
| `discussion.maxAdvisorsPerCall` | number | `3` | 单次咨询最大顾问数（1–10） |
| `discussion.autoDeepen` | boolean | `true` | 启用自动深挖流水线（驱动追问 + 综合结论） |
| `discussion.driverModel` | object | – | 兜底驱动模型 `{provider, model}`（会话头信息不可读时） |
| `discussion.advisorTimeoutMs` | number | `600000` | 单顾问调用超时（毫秒，1000–600000），双通道均生效 |
| `discussion.driverTimeoutMs` | number | `600000` | 驱动模型生成超时（深挖追问/综合结论；毫秒，1000–1200000） |
| `discussion.advisorTools` | string | `'readonly'` | **未单独设置时的全局默认**顾问工具调用范围：`readonly`（只读白名单 read/grep/glob/web_search/web_fetch…）｜`all`（全部会话可见工具，含可写，慎用）｜`off`（关闭）。仅直连通道（OpenAI/Anthropic）支持工具调用，DSH 内置通道的顾问需配 `baseURL`/`apiKey`/`apiKeyEnv` 直连（详情见「功能特性」）。 |
| `advisors[].tools` | string | – | 每个顾问的**单独**工具调用范围覆盖（`readonly`/`all`/`off`；未设置时跟随全局默认）；设置卡片上：可直连的顾问显示下拉，DSH 内置通道顾问显示“不可配置”。 |
| `quota.enabled` | boolean | `true` | 启用每日咨询上限（成本安全阀） |
| `quota.maxPerDay` | number | `50` | 每日 UTC 日周期内最多新咨询次数（1–100000）；`quota.enabled=false` 时不生效 |
| `trigger.requireClassifier` | boolean | `true` | 发起前先跑前置分类器 |
| `trigger.allowWebFallback` | boolean | `true` | 分类器建议联网搜索时返回该提示 |
| `trigger.confidenceThreshold` | number | `0.6` | 主模型置信度低于该值时升级 |
| `trigger.jev.enabled` | boolean | `false` | 用外部 Jev 模型对非强制咨询做语义前置分类；Jev 不可用时回退本地规则分类器 |
| `trigger.jev.provider` / `trigger.jev.model` | string | `'typesafe'` / `'jev-latest'` | Jev 路由（`typesafe` 或 `openrouter`）与模型；密钥用 `trigger.jev.apiKey`（secret）或 `trigger.jev.apiKeyEnv`；可选 `baseURL`、`timeoutMs`（默认 `10000`） |
| `trigger.jev.confidenceThreshold` | number | `0.6` | Jev 判「该找顾问」为是（或 0–1 分数达到该值）时升级 |
| `trigger.jev.highRiskThreshold` | number | 跟随 `jev.confidenceThreshold` | Jev 判「高风险」为是（或 0–1 分数达到该值）时标记高风险；未设置则跟随 `trigger.jev.confidenceThreshold` |
| `trigger.jev.useEnglishState` | boolean | `false` | 判定改用主模型附带的英文概要（`questionEn`）而非中文原问；展示与会话记录仍为中文 |
| `ui.theme` | string | `retro-green` | 卡片主题（retro-green / retro-amber / retro-blue） |
| `ui.showTimestamps` | boolean | `true` | 显示时间戳 |
| `ui.autoExpand` | boolean | `true` | 自动展开卡片 |
| `advisors` | array | `[]` | 顾问列表（provider/model/baseURL/apiKey/apiKeyEnv/protocol…，key 均标 `role('secret')`） |

> `discussion.parallel` 与 `discussion.stopOnConsensus` 为弃用遗留项，仅保留以兼容已存配置。

## 🧮 每日配额

插件自带一个成本安全阀：按 UTC 日历日统计**新咨询**次数，默认上限 50，可在设置页改数字或者直接关掉。它只拦新咨询——「▶ 继续聊天」续跑与追问都不计数。判断与自增在同一个同步块内完成，所以两个会话不可能同时挤过窗口；计数原子落盘在 `$DSH_HOME/storages/advisor-group/daily-guard.json`，重启不归零，UTC 日切自动清零。额度用尽时 `ask_advisors` 不启动，只返回一行说明；设置页实时显示「今日剩余咨询次数 X / Y」，关掉上限后仍然计数，只是不拦截。

## 💸 用量与成本

一次咨询不是「一次调用」，而是一串调用。默认配置（`maxRounds = 2`、最多 3 位顾问）下，一次新咨询约 9 次模型调用：2 轮 ×（1 次驱动模型追问 + 3 位顾问各 1 次）+ 1 次驱动模型综合结论。顾问若使用工具，每次工具往返还会再加一次模型调用（单个顾问上限 4 轮，另加一次强制文字作答），实际次数可能明显高于 9。

费用分别结算：顾问按你给它们配的通道与模型计费，驱动模型按当前会话的模型计费。想控成本，可以降 `maxRounds`、减少顾问数、给顾问设 `tools: 'off'`，再把每日上限设成你能接受的数字。中断后用「▶ 继续聊天」续跑只补问没答完的顾问，不会整场重来，代价低于重开一次。

## 🔒 安全与隐私

- 直连 API Key 可存于 DSH `settings.yaml`（标 secret，官方 `describe` 绝不回传浏览器）；不想落盘请用 `apiKeyEnv` 环境变量模式。
- `/advisor-group/*` 路由为**单机共享 token**（本地单用户使用），不是多用户鉴权；暴露局域网必须外层加反代鉴权。
- 诊断端点服务端按存档 key 解析真实值再打供应商，并对目标 URL 做 https-only/loopback SSRF 校验；DNS rebinding 记为文档化已知边界。
- 每日咨询上限（`quota.*` 可配置，默认 50、可关闭）持久化在 `$DSH_HOME/storages/advisor-group/daily-guard.json`（UTC 日切），重启不再归零。
- 分类器影子模式：每次非强制分类追加一条观测样本（只读 `/advisor-group/shadow`），仅用于阈值调优，绝不干预行为。
- **`advisorTools: 'all'` 属于高风险作用域**：会把会话可见的**全部工具**（含 `pwsh`/`bash`/`write`、配置/SSH 等可写/执行类）暴露给顾问模型（经官方守卫管线执行）。仅建议为可信的本地模型启用，并保证走 direct-http 通道；每次**非只读**工具调用都会以 `console.warn` 留审计痕迹。默认请用 `readonly`（read/grep/glob/web_search/web_fetch/scan_discover/list_imported_sessions）或 `off`。

## ⚠️ 已知限制

- DSH 宿主进程硬崩溃时，已打开的卡片在刷新前可能仍显示 **LIVE**（现在会先出现断线提示）；刷新后按会话日志恢复真实状态。
- 风险提示**只看事实、不看措辞**：截断（顾问输出被超时或网络中断）与取消（本轮咨询被停止）两种。用户可在**已停止或已完成**的卡片与会话日志中看到，主模型随 `ask_advisors` 返回收到。顾问正文不做关键词扫描——早期那套「凭字眼猜有没有保留意见」的启发式已在 0.1.1 移除，原因是它连「没有任何风险」这样的否定句也会当成风险提示（盲测里 4 条纯否定句全部误报）。

## 🛠️ 开发

```sh
npm install --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm test        # vitest 单测（含本地假 LLM 服务器上的供应商流式契约）
npm run build   # tsdown；客户端 bundle 禁用 minify: true
```

## 📄 许可证

[Apache License 2.0](LICENSE) © 2026 dsh-advisor-group contributors.

# AGENT.md — dsh-advisor-group 开发规范

> 本文件是 `I:\DSH\dsh-advisor-group` 的仓库级开发约束，供后续 agent / 工程师在修改本插件前阅读。
>
> **权威知识库**：`D:\X\X\23-DSH\开发指南和架构文档\`
> 该目录下是 DeepSeek Harness 官方开发指南与架构文档的本地副本（Cordis 入门、架构、Capability Seam、Tools/Session/SystemPrompt/LLM 子系统、工具 Cookbook、Agent 生命周期等）。
> 本文件是“本插件专属的落地规则”，如果与知识库中的官方原文冲突，以 `D:\X\X\23-DSH\开发指南和架构文档\` 为准。

---

## 0. 项目快照

- **仓库**：`I:\DSH\dsh-advisor-group`
- **主包（唯一包）**：`dsh-advisor-group`
  - 版本：`0.1.0`
  - Host 主入口：`lib/index.mjs`（`package.json#main`）
  - Client bundle：`lib/client.js`（`exports["./client"]`）
  - Bundle patch：`cordis.patch.yml`（`dsh.bundle.patch`）
  - License：Apache-2.0
- **目标环境**：DeepSeek Harness `0.1.2-rc.1`（2026-09 从 `0.1.1-rc.2` 适配），Node `^22.19.0 || >=24.0.0`，DSH Web + host/headless
- **发布状态**：自研、未发布 npm、无 GitHub 远端、**目录下没有 `.git`**（因此没有 commit 级迭代历史；历史依据文档与 TODO 重建）
- **一句话职责**：主模型遇到专业/长尾世界知识/高风险/不确定内容，或用户 `@顾问群`、同一问题重复 3 次仍未解决时，通过 `ask_advisors` 召集多个顾问模型，以真实流式返回思维链与 Markdown 正文，并在对话流中展示复古 CRT 聊天群卡片；主模型可用 `sessionId + followUp` 继续追问，`maxRounds` 封顶总轮数。

---

## 1. 必读知识库文件（按此顺序）

| 顺序 | 文件 | 用途 |
|---|---|---|
| 1 | `DeepSeek Harness 架构.md` | 插件扩展点总览、Profile/Bundle 分层、事件域、Capability Seam |
| 2 | `DeepSeek Harness 开发指南.md` | 构建/类型/CI/文档同步、TODO 标记规范 |
| 3 | `DeepSeek Harness 扩展 Cookbook.md` | 工具/钩子/UI/协议驱动插件形态与 feature→mechanism 映射 |
| 4 | `DeepSeek Harness Cookbook 新增工具.md` | `defineTool`、`execute` 契约、后台任务、展示呈现、策略扩展点 |
| 5 | `DeepSeek Harness Cookbook 新增设置卡片.md` | 设置命名空间、Host/Client 配对、`settingsScope`、打包要求 |
| 6 | `DeepSeek Harness Cookbook 新增包.md` | 包拓扑、命名、README 规范、验证流程 |
| 7 | `DeepSeek Harness 工具执行管线.md` | `tools/pre-execute` → guard → `tools/execute` → `tools/post-execute` → `tools/result` 顺序 |
| 8 | `DeepSeek Harness Agent 生命周期.md` | turn/step 生命周期、`agent/*` 与 `session/*` 的分工 |
| 9 | `DeepSeek Harness Agent Note Session Projection 强制缝.md` | 会话投影读取必须显式失败，禁止默认缺失值 |
| 10 | `DeepSeek Harness 子系统 Session.md` | `SessionEventMap`、durable 契约、插件贡献 log-only 事件 |
| 11 | `DeepSeek Harness 子系统 Tools.md` | `ToolDefinition`、统一 JSON Schema DSL、工具 UI 词汇 |
| 12 | `DeepSeek Harness 子系统 系统提示词.md` | `ctx.systemPrompt.section()`、`system-prompt/assemble` |
| 13 | `DeepSeek Harness 子系统 LLM 流式.md` | `ctx.llm` 适配器接缝、StreamChunk 协议 |
| 14 | `DeepSeek Harness 事件生产者消费者.md` | 事件域、mode、producers/consumers 矩阵 |

---

## 2. 本插件架构与文件导航

### Host（Node 侧）
- `src/index.ts` — 插件入口：`name = 'dsh-advisor-group'`、`inject = ['tools', 'llm', 'systemPrompt']`，装配服务、工具、路由、系统提示词段。
- `src/service.ts` — 核心 `AdvisorGroupService`：会话状态、轮次/`maxRounds`、重复问题检测、每日 50 次原子护栏、并行/串行顾问调用、摘要。
- `src/tools.ts` — `ask_advisors`、`toggle_advisor_group`。
- `src/classifier.ts` — 前置分类器（风险/世界知识/置信度/联网搜索/`@顾问群`）。
- `src/config.ts` — Schemastery `Config` schema。
- `src/events.ts` — 本插件的 Cordis 事件声明（`advisor-group/*`）。
- `src/session-events.ts` / `src/session-events-host.ts` — durable session 事件类型 + `KNOWN_SESSION_EVENT_TYPES` workaround。
- `src/session-log.ts` — 把本插件事件追加进 durable session log，并推导 `turn/step`。
- `src/stream-channel.ts` — SSE 发布/回放/`resync`。
- `src/settings-api.ts` — `/advisor-group/*` 路由、配置读写、token 鉴权、API key 掩码、模型列表/连接测试。
- `src/providers/` — `ctx-llm.ts`（主通道）、`direct-http.ts`（OpenAI/Anthropic/Gemini 兜底）、`presets.ts`、`timeout.ts`、`advisor-prompt.ts`。
- `src/prompt.ts` — 注入主模型的“顾问群使用边界”。

### Client（Browser 侧）
- `src/client/index.ts` — `ConversationNodeDefinition`（`advisor-group`，`target: 'chat'`）+ 复古 CRT 卡片渲染器 + `settings.plugin.item` 设置卡片。
- `src/client/markdown.ts` — 轻量 Markdown 渲染器，仅 React 文本节点，链接协议白名单。

> 0.1.2-rc.1 契约：`@deepseek-ai/dsh-client-runtime` 已不存在；Conversation 类型来自 `@deepseek-ai/dsh-client-ui-conversation/client`，chat 渲染类型来自 `@deepseek-ai/dsh-client-ui-chat/client`，`slots` 服务声明来自 `@deepseek-ai/dsh-client-ui-renderer/client`。注册改用 `ctx.uiConversation.events.register(definition)`，卡片槽位改为 keyed `settings.plugin.item`（key = settings namespace），节点渲染器槽位仍是 keyed `conversation.chat.node`（key = ChatNodeKind）。

### 工程
- `tasks/todo.md` — 任务清单。
- `工程说明文件.md` — 中文完整说明/背景/已知限制。
- `开发注意事项.md` — 修改前必读的坑与铁律。
- `tests/` — 24 个单测（分类器、客户端 round 匹配、Markdown/XSS、SSE 回放/resync、设置 API key reconcile）。

### 主数据流
```
用户/主模型触发
  → classify / @顾问群 / 重复3次
  → ask_advisors
  → AdvisorGroupService.createSession()
  → runOneRoundAndSummarize()  （每次 ask 只跑一轮）
      → 每个 advisor 通过 ctx.llm 或 direct-http 真流式
      → publish() 到 SSE + 200ms 节流 appendAdvisorDelta()
      → appendAdvisorMessage() / appendAdvisorEnd()
  → 返回 sessionId + advice 给主模型
  → 主模型可再调 ask_advisors(sessionId, followUp)
  → Client 由 durable events + SSE live 覆盖层渲染卡片
```

---

## 3. DSH 插件红线（必须 / 不得）

以下规则来自知识库官方文档，修改本插件时必须遵守：

### 3.1 插件契约
- 插件模块必须导出 `name` + `apply(ctx, config)`（可选 `inject`）。本插件已导出 `name`、`apply`，且 `inject = ['tools', 'llm', 'systemPrompt']`。
- **注册即 effect**：所有贡献走 `ctx.effect()` / `ctx.on()` / 服务 `register()`，返回 disposer；绝不手动 `removeListener` / `clearInterval` 式收尾。插件卸载时由 Cordis 自动回滚。
- `waterfall` 监听器必须调用 `next()` 才能放行；不调 `next()` = 故意短路（拦截语义）。`emit` / `waterfall` / `parallel` / `serial` / `bail` 语义以知识库为准。
- **配置必须用 Schemastery schema**；本插件用 `src/config.ts` 的 `Config`。不得把可调参数硬编码（判断标准：`cordis.yml` 能不能改）。当前 `MAX_DAILY_CONSULTATIONS = 50` 是代码内硬编码，后续若要可配置应迁入 schema。
- 不要为了“以后可能”提前抽象；单用途插件保持一个包。

### 3.2 模型可见 ⟺ 已记录
- **任何进入模型请求的内容必须能从 session log 重建。**
- 新增模型可见输入必须新增 `SessionEventMap` 合并声明（declaration merging）并写在 `src/session-events.ts`。
- `Session.append()` 强制 lossless JSON、`seq` 连续、禁止 `undefined` 字段。`src/session-log.ts` 必须显式构造对象、只放有值字段。
- 本插件的 `advisor-group/start|message|delta|end` 是 **log-only** 事件：不携带 `surfaceOp`，不进入 `deriveMessages()`，不能出现在模型派生历史里。
- 如果未来 DSH 提供官方插件事件注册面，立即替换 `src/session-events-host.ts` 的 `KNOWN_SESSION_EVENT_TYPES` mutation workaround。

### 3.3 会话投影（如将来使用）
- 读取 `ctx.sessionProjections` 的状态时，必须把它当**必需的 reader seam**：缺失注册表或必需 key 时显式抛错，**禁止用默认值伪装缺失状态**。
- 官方组合会让 `sessionProjections` 在插件前挂载；本插件目前没有读投影，但若新增此类依赖要遵守该规则。

### 3.4 工具
- 用 `defineTool`；`execute` 只返回 `output.schema` 声明的规范 JSON 值。
- 参数由框架自动校验，但 DSL 无法表达的约束（如 `confidence` 0–1、非空字符串）必须在 `execute` 内手检。
- 不要返回 content blocks / 让调用者解析 prose；人类可读内容放 `output.render`。
- 尊重 `exec.signal`：取消在途工作。本插件的 `ask_advisors` 已将 `exec.signal` 透传给 `runOneRoundAndSummarize` / `callAdvisor`。
- 工具注册时不得在注册后修改 schema 或替换回调；需要替换应卸载旧 effect 再注册新工具。
- `presentCall`/`presentResult`（若将来添加）必须是**纯函数**：不能 I/O、不能读 session 状态、不能读时钟/随机；必须既能 live 又能 replay。
- 本插件当前没有自定义 `presentCall`/`presentResult`，工具结果以 `render` 文本形式展示，符合“无 UI 展示则 fallback generic card”的规则。

### 3.5 Client
- Client bundle 是浏览器半区；**禁止跨插件 value import**。只可 `import type` 别包 client 类型。
- 不能把 Host 实现 import 进 browser bundle。
- 不修改主仓库；所有改动都在本插件内。
- 渲染 LLM 内容时不得使用 `dangerouslySetInnerHTML`；本插件的 `renderMarkdown` 全部走 React 文本节点，链接做协议白名单。

---

## 4. 本插件使用的扩展点（当前实现）

| 目标 | 本插件用法 | 对应官方扩展点 |
|---|---|---|
| 添加模型可调用能力 | `ctx.tools.register(ask_advisors)`、`ctx.tools.register(toggle_advisor_group)` | `ctx.tools` |
| 注入主模型上下文 | `systemPrompt.section({ name: 'advisor-group-boundary', order: 150, text })`，`text` 每次 assembly 重新求值 | `ctx.systemPrompt.section()` |
| 观察用户重复提问 | `ctx.on('session/event', ...)` 统计相同 `user/message` | `session/event` |
| 自定义 durable 会话记录 | `SessionEventMap` 合并声明 + `log.append()` | Session log / 插件贡献 log-only events |
| 宿主设置命名空间 | `'advisor-group' as SettingsNamespace` + `settings.register` / `replace` / `watch` | `ctx.settings` / 设置卡片 |
| Web 业务节点 | `uiConversation.events.register(advisorGroupDefinition)` + `slots.register('conversation.chat.node', ...)` | Conversation subsystem |
| 设置页卡片 | `slots.inject('settings.plugin.item', ...)`（keyed, key=命名空间） | Settings card slot |
| 复用 LLM 适配器 | `ctx.llm.stream()` / `listProviders()` / `listModels()` | `ctx.llm` |
| 服务端 HTTP 路由/鉴权 | `webServer.register()` / `webServer.tapIndex()` | WebServer / index-inject |
| 后台/长任务边界 | `exec.signal` + 单顾问 120s timeout；未用 `ctx.jobs` | （如需真正后台任务再挂 `ctx.jobs`） |

---

## 5. 本插件的工具契约细节

### `ask_advisors`
- `parameters`：`question`、`context`、`sessionId`、`followUp`、`advisorIds`、`confidence`。
- `output.schema`：`{ sessionId, advice, skipped?, reason? }`。
- `execute` 规则：
  1. 校验 `confidence` 0–1；
  2. 检查 `enabled`、`advisors.length`；
  3. 已有 `sessionId` → follow-up 分支，校验 `followUp`、session 存在、未达 `maxRounds`；
  4. 新会话 → 分类器（`@顾问群`/重复 3 次可绕过）、指定顾问校验、每日护栏原子递增；
  5. 创建 session 并**只跑一轮**；
  6. 返回 `advice` = 格式化对话 + 是否可继续提示。
- 重要：**绝不回到“顾问连续自答多轮”**。跨轮讨论由主模型再调 `ask_advisors(sessionId, followUp)` 驱动；`maxRounds` 是总会话轮数上限。
- `confidence` 注：当前 `dsh-tools` 参数 schema DSL 不支持 `minimum/maximum`，所以范围必须在 `execute` 内校验。

### `toggle_advisor_group`
- 参数可省略；省略时取反当前状态。
- 调用 `service.toggleEnabled()` 同时更新内存并持久化到 settings；失败不抛错（保留内存态）。

---

## 6. Session / 流式 / SSE 规范

- **事件家族稳定 ID**：`advisor-group/start|message|delta|end` 都携带同一 `sessionId`，Client 才能按 `(advisorId, round)` 分桶、跨刷新/重连不串泡。
- **delta 事件剔除 undefined**：`appendAdvisorDelta` 必须显式构造对象，只包含有值字段；否则 `Session.append` 抛错。
- **turn/step**：`ToolRunContext` 不暴露 turn/step；`src/session-log.ts` 从 session log 尾部最近的 `step/start` / `turn/start` 推导，找不到回退 `{turn:0, step:0}`。
- **SSE**：
  - 每条帧带 `id: <BOOT_ID>:<seq>`，JSON 含 `eventId`/`bootId`。
  - 回放缓冲：每会话最近 500 条、5 分钟 TTL。
  - `bootId` 失配 → `event: resync`（重启）；`lastEventId` 缺口 → `event: resync`；否则回放 `id > lastEventId`。
  - 客户端按 `eventId` 去重，收到 `resync` 后重置 live 覆盖层。
  - 修改回放逻辑后必须跑 `tests/stream-channel.test.ts`。
- **断连语义**：当前 SSE 断连不会取消在途顾问调用，靠 120s 超时兜底；这是已知限制，不要声称已取消。

---

## 7. Provider 与模型调用

- **主通道**：优先复用 DSH `ctx.llm` / `llm-pi-ai` 已配置的 Provider 与凭据；用 `ctx.llm.stream()` 并处理 `text-delta` / `reasoning-delta`。
- **兜底通道**：`src/providers/direct-http.ts`，支持 OpenAI 兼容 / Anthropic / Gemini；AIHubMix、OpenRouter、硅基流动、阿里云百炼等提供单独的 Anthropic 兼容预设。
- **两条通道都必须真流式**：`callViaCtxLlm` 和 `streamDirectHttp` 统一通过 `onDelta` 吐增量；`service.callAdvisor` 负责 `publish`（SSE）+ 200ms 节流落盘。
- 判断走哪条通道：`ctx.llm.listProviders()` 命中该 provider 且没有 `baseURL`/`apiKey`/`apiKeyEnv` → 走 ctx.llm；否则走 direct-http。
- **direct-http 读原始 key**：绝不能读 `sanitizeConfig` 后的掩码配置。
- Provider 预设中的默认模型是占位值，真实接入需按平台最新模型修正；修改 `presets.ts` 时必须同步校验 `ALLOWED_API_KEY_ENVS` 与 `validateSecurity`。

---

## 8. Settings / 路由 / 安全

- 设置命名空间：`advisor-group`，Host 侧与 Client 侧必须同名。
- 配置持久化：`settings.replace(namespace, reconciled, expectedRevision)`；先持久化成功再更新内存；`SettingsConflictError` → 409。
- `scope.watch` 监听配置变更，同步 `service.setConfig()`。
- `toggle_advisor_group` 通过 `service.setPersistEnabled` 持久化，不要只在内存改。
- **路由 token**：`/advisor-group/*` 走启动期共享 token（`randomUUID` + `webServer.tapIndex` 注入 `globalThis.__ADVISOR_GROUP_TOKEN__`）。它是单机共享 token，**不是多用户鉴权**；若暴露局域网必须在外层加反代鉴权。
- **API key 协议（SecretField 收敛，2026-09-05）**：读回配置**不返回任何 key 材料**（`apiKey` 恒为空串），只返回 `apiKeyMetaByProvider`（每供应商 `configured/last4` 事实）用于「已配置/未配置」徽章；POST 采用 SecretField 语义——留空=保留、新明文=覆盖并入档、`clearApiKey: true`=显式清除（含该供应商存档删除），旧「精确掩码」回传仅作防御保留。服务端维护 `apiKeysByProvider`（不返回浏览器），切换供应商归档旧 key、切回自动恢复；**客户端无任何 key 记忆**（keyMemory 已删除）。schema 中 `apiKey` 与 **`apiKeysByProvider` 均标 `role('secret')`**（官方 describe 红线，`tests/settings-redact.test.ts` 5 用例锁定）。
- **baseURL 安全**：仅允许 `https://` 或 `http://127.0.0.1` / `http://localhost`；诊断端点另有 `assertSafeDiagnosticBase`（禁 IP 字面量/云元数据，fetch `redirect:'error'`，DNS rebinding 为已知边界）。
- **每日护栏**：`service.tryStartConsultation()` 必须保持“检查 + 递增”在一个同步块（无 await），防止并发穿透。已持久化到 `$DSH_HOME/storages/advisor-group/daily-guard.json`（UTC 日切、重启不归零、写失败仅 warn）。

---

## 9. Client UI 规范

- 卡片状态优先来自 durable events；SSE `live` 覆盖层只在比 durable 内容更长时采用，避免重连后用截断 live 覆盖完整 durable。
- 思考面板默认展开（`useState(false)` 表示折叠状态），流式时自动滚底。
- 顾问正文用 `renderMarkdown`；**所有文本一律走 React 文本节点**，禁止 `dangerouslySetInnerHTML`。
- 链接必须过 `sanitizeLinkUrl`（http/https/mailto/相对路径；拒绝 javascript:/data:/vbscript:）。
- 表格支持管道表格；复杂表格/嵌套列表/内联 HTML 属已知限制。
- 设置页输入框不要用 `var(--card)` / `var(--card-foreground)` 作背景/文字色，避免黑底黑字；参考 `开发注意事项.md` 中的透明背景 + `var(--dsh-color-border)` / `var(--dsh-color-muted)` 写法。
- **client bundle 禁止 `minify: true`**：压缩器会把 banner 里的 `id: "dsh-advisor-group"` 改成反引号，导致 `dsh-startup-guard` 正则匹配不到而自动禁用插件。构建后必须检查 `lib/client.js` 含 `id: "dsh-advisor-group"`（双引号）。

---

## 10. 构建 / 安装 / 发布

```sh
# 开发环境（当前项目用 npm，不要用 pnpm install —— rc 依赖范围会失败）
npm install --legacy-peer-deps --no-audit --no-fund

# 常态验证
npm run typecheck
npm test
npm run build          # tsdown + postbuild check-client-id

# 安装到 web profile
npm pack --pack-destination .
dsh plugin --profile web remove dsh-advisor-group   # 如果已有旧版
dsh plugin --profile web add .\dsh-advisor-group-0.1.0.tgz
```

- **不要用 `link:` 安装到 profile**：`link:` 会让 Node 从 `I:\DSH\dsh-advisor-group` 物理目录解析依赖，本插件 `node_modules` 的 rc 版 peer 依赖不完整，会出现 `ERR_MODULE_NOT_FOUND`。必须走 tarball。
- 涉及 client 或 `dsh.client.inject` 改动后，必须重启 DSH web 并硬刷新浏览器（`Ctrl+Shift+R`）。
- 构建产物：`lib/index.mjs` + `lib/client.js`；`postbuild` 校验 client id 双引号。
- 若后续要发布，注意 `package.json#files` 只包含 `lib` 与 `cordis.patch.yml`；`dsh.client` 需声明 `platform: "web"` 与 `inject`。

---

## 11. 修改流程与验证清单

1. **改前必读**：
   - `开发注意事项.md`
   - `工程说明文件.md`
   - `tasks/todo.md`
   - 涉及 DSH 规范时先查 `D:\X\X\23-DSH\开发指南和架构文档\`
2. **先计划**：非琐碎改动写简短计划；确认是否涉及公开 API/文档/模型行为。
3. **最小修改**：只改与目标直接相关的内容；不要顺手重构相邻代码；不要删除已有死代码，除非任务要求。
4. **修改后验证**（每次都做，涉及对应区域时全做）：
   ```sh
   npm run typecheck
   npm test
   npm run build
   grep -n 'id: "dsh-advisor-group"' lib/client.js
   ```
5. **涉及 client 或配置页**：重新 `npm pack` → remove/add → 重启 DSH web → 硬刷新。
6. **涉及 SSE/回放**：跑 `tests/stream-channel.test.ts`；涉及 Markdown/XSS：跑 `tests/markdown.test.ts`；涉及轮次/工具：跑 `tests/index.test.ts`、`tests/client-round.test.ts`。
7. **记录**：完成时更新 `tasks/todo.md` (Review 段)；被用户纠正后更新 `tasks/lessons.md`（若存在；不存在则创建）。涉及新坑时同步写进 `开发注意事项.md`。

---

## 12. 已知历史坑 / 当前未完成（修改时勿破坏）

### 历史坑
- **client bundle 禁止 minify**（见 §9）。
- **0.1.2-rc.1 适配落点（勿回退）**：
  - `@deepseek-ai/dsh-client-runtime` 在 0.1.2-rc.1 已不存在（npm 最高 `0.1.1-rc.2`）；client 类型改从 `dsh-client-ui-conversation/client`、`dsh-client-ui-chat/client`、`dsh-client-ui-renderer/client`、`dsh-client-ui-settings-plugins/client` 导入。
  - 节点注册：`ctx.conversationEvents.register(...)` → `ctx.uiConversation.events.register(...)`；`inject = ['uiConversation', 'slots', 'locale']`。
  - 设置卡片：`settings.plugins.tab`（list，id/order/label）→ keyed `settings.plugin.item`（key = settings 命名空间 `advisor-group`）。
  - Host：`settingsNamespace()` 函数已删除 → 直接 `'advisor-group' as SettingsNamespace`；`Session.events` getter 删除 → `Session.snapshotEvents()`。
  - 依赖范围必须用 `>=0.1.2-rc.1 <0.2.0`（semver 预发布规则：`>=0.1.0-rc.8 <0.2.0` 匹配不到 0.1.2-rc.1，见《踩坑手册》坑 02）。
- **`KNOWN_SESSION_EVENT_TYPES` mutation 是 rc workaround**：0.1.2-rc.1 官方机制是 `SessionEvent.ignorable: true` 标记（持久化读路径 `KNOWN.has(type) || event.ignorable === true` 放行），但 `Session.append()` 只对 surface 事件开放 opts，插件自定义事件目前无法打标记；若 append 暴露 ignorable 或出现官方注册面，替换 `src/session-events-host.ts`。
- **不要用 `link:` 安装**；用 `npm pack` tarball。
- **`pnpm install` 会失败**；用 `npm install --legacy-peer-deps`。
- **delta 事件剔除 undefined**：历史上出现过源码回退/线上手改，已合并，但修改 `session-log.ts` 时仍要小心。
- **轮次语义（2026-09-05 自动深挖流水线）**：一次 `ask_advisors` 跑完整流水线——`runAutoPipeline` 循环到 `maxRounds` 轮；每轮 =（第 2 轮起）驱动模型生成深入追问（main 消息展示）+ 顾问按配置顺序接力（A→B 看到 A→C 看到 A+B；`runOneRound` 内 for...of 逐位重建 transcript，**勿回退 Promise.all 并行**）；完成后驱动模型产出综合结论（summary.conclusion → end 事件 + 卡片）。驱动来源：会话 `requestHeader()` 的 provider/model → 回退 `discussion.driverModel` → 静态文本（`src/driver.ts`，永不中断）。`sessionId+followUp` 保留为手动单轮追加（受 maxRounds 封顶）。`stopOnConsensus` 与 `parallel` 均已弃用（schema 兼容、UI 不展示）；改动后跑 `tests/driver.test.ts`。勿回退为“每 ask 一轮 / 主模型驱动”。
- **单顾问超时可配置**：`discussion.advisorTimeoutMs`（默认 120000），service 传入两条通道；providers 内全部用 `withTimeout(timeoutMs ?? ADVISOR_CALL_TIMEOUT_MS, signal)`，勿回退硬编码。
- **direct-http 必须读原始 key**：不能读掩码配置副本。

### 当前未完成
- 知识库 X 留档已完成（2026-09-04：插件条目 + 总览均已更新，含 0.1.2-rc.1 适配记录）。
- 分类器阈值 `0.6` 尚未用真实数据调优（影子样本已开始积累）。
- Provider 预设默认模型清单需按各平台最新模型修正。
- 路由 token 非多用户鉴权；每日计数内存态；SSE 断连不取消在途调用；Markdown 不支持嵌套列表/内联 HTML/复杂表格。

---

## 13. 红线总结（一句话版）

> 不改 agent loop；一切注册都走 effect；工具返回规范 JSON、渲染走 render；模型可见必记日志；SSE/client 先看 `开发注意事项.md`；client bundle 不要 minify；改动后 typecheck + test + build + pack 实测。

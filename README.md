# dsh-advisor-group

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：让一个会话**既能向其他模型借智慧，也能向其他会话借记忆**。
>
> 遇到专业、长尾世界知识、高风险或不确定的问题，主模型召集多位**专家顾问模型**，在复古 CRT 聊天组卡片中进行会诊；遇到别的会话已经知道的事，跨会话去问，复用已有上下文，无需从头再查。
>

[![dsh-plugin](https://img.shields.io/badge/DSH%20plugin-dsh--plugin-3f8cff)](https://github.com/topics/dsh-plugin)

[English: README.en.md](README.en.md)

---

<img width="865" height="983" alt="1788679983177" src="https://github.com/user-attachments/assets/5660ce94-70f0-42ed-84e4-9f926d1e2c64" />

## ✨ 功能特性

- **自动深挖咨询流水线**：一次 `ask_advisors` 跑满 `maxRounds` 轮（1–5，默认 2）。首轮直接用原问题，后续各轮先由驱动模型生成更深入的追问（`autoDeepen` 关闭时改用原问题）。顾问按 A → B（见 A）→ C（见 A+B）接力应答，最后由驱动模型生成综合结论（总会生成，不受 `autoDeepen` 影响）。
- **顾问可调用会话工具（2026-09-05）**：顾问回答前可调用当前会话工具，默认仅放行只读白名单（read/grep/glob/web_search/web_fetch 等）。调用走官方 `ctx.tools` 完整管线，最多 4 轮后强制用文字作答。每次调用在卡片展示 `⛭ 工具名 · 调用中 / 调用完成 / ⚠ 失败`，展开可看输入输出。可在设置中切换为「全部会话工具」或「关闭」。
- **停止后可继续**：人工停止或 DSH 重启后，卡片「⏹ 停止」按钮变成「▶ 继续聊天」。点击调用 `POST /advisor-group/resume` 从断点续跑：未答顾问补答，已答顾问不重问，剩余轮次与最终综合结论照常生成。会话快照持久化保存在 `storages/advisor-group/sessions/<id>.json`（仅存顾问 id、消息和状态，不含凭据），重启后自动恢复。
- **驱动模型零配置复用**：驱动模型负责生成深挖追问，直接复用当前会话的 provider 和 model。你不需要额外配置密钥或模型；会话头信息不可读时，自动回退到 `discussion.driverModel`。
- **三种触发方式**：在提问中带 `@顾问群`（强制启动）；同一问题重复提问 3 次未解决；主模型自评置信度低于预设阈值。
- **Jev 语义前置分类（可选，默认关闭）**：开启 `trigger.jev.enabled` 后，未强制启动的咨询先由配置的 Jev 模型做语义判断（是否该找顾问、是否高风险、是否适合联网，阈值见 `trigger.jev.*`）。Jev 不可用时，由本地规则分类器接管。开启 `trigger.jev.useEnglishState` 后，Jev 改读主模型给出的英文概要（`questionEn`），卡片展示与会话记录仍保持中文。
- **复古 CRT 聊天组卡片**：提供绿、琥珀、蓝三种主题，带扫描线和 LIVE/DONE 状态标。💭 思考面板默认展开并随流式内容滚动。正文采用轻量 Markdown 渲染，设有限制协议白名单，支持标题、列表、代码、引用、链接与表格。
- **全局蜂群（跨会话提问）**：`ask_session` 把问题交给另一个活着的会话并唤醒它，`list_sessions` 查看名录，`ask_result` 获取异步结果。拿回的不是逐条问答，详情见「🐝 全局蜂群」。
- **供应商预设（12 平台 · 28 预设）**：DeepSeek、月之暗面 Kimi、Kimi Code、阿里云百炼、智谱 AI、OpenAI、Claude、Gemini、硅基流动、AIHubMix、OpenRouter、**OpenCode Go**（含 OpenAI 与 Anthropic 兼容变体）。
- **注重安全**：API Key 遵循官方 `SecretField` 语义，浏览器永不回显，供应商密钥档案 `apiKeysByProvider` 仅保存在服务端。诊断端点经过 SSRF 加固（仅限 https 与 loopback，拒绝 IP 字面量和重定向）。`/advisor-group/*` 路由在启动期生成 token 进行鉴权。支持每日新咨询上限（见「🧮 每日配额」）。
- **运行时开关**：调用 `toggle_advisor_group` 启停插件，状态自动持久化到设置。

## ✅ 兼容性

| 项目 | 状态 |
|---|---|
| Harness | **`0.2.1-rc.3`（实测运行版本，本版门禁即对着它跑）**；声明的 peer 区间为 `>=0.1.7-rc.2 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.0.0` |
| 平台 | DSH Web 与桌面端（共用同一份客户端 bundle）+ headless 宿主逻辑 |

> 关于下限：`0.1.7-rc.2` 仍在声明的 peer 区间内，但本轮没有重新实装验证。类型检查、测试与构建均对着 `0.2.1-rc.3` 完成。如果在更早的 0.1.x 宿主上遇到加载失败，多半是因接口变动，而非当前版本代码缺陷。

## 📦 安装

```sh
# 1. 安装插件（一个包全都有）
dsh plugin --profile web add dsh-advisor-group

# 2. 重启 dsh web
npx @deepseek-ai/dsh web
```

> **第 2 步提醒**：`npx @deepseek-ai/dsh web` 拉取的是当时的最新版 DSH，可能跨出本插件的 peer 区间（`>=0.1.7-rc.2 <0.3.0`），宿主会因此拒绝加载插件。按你平时的方式重启即可（已有的启动脚本、桌面端都可以），不必非用这条命令。

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

模型可用工具：`ask_advisors`、`toggle_advisor_group`、`ask_session`、`list_sessions`、`ask_result`。

## 🐝 全局蜂群：让会话互相提问

### 一个会话，就是一个有记忆的专家

DSH 里每个会话都在积累上下文：读过的代码、走过的弯路、定下的约定、否掉的方案。它们不是一次性的聊天窗口，而是**带着记忆的节点**——同一个问题在别处早已查清，从零再问一遍既慢又贵。

所以这个插件做两件事：**向外借智慧**——召集专家顾问模型；**向旁边借记忆**——问那个已经知道的会话。

### 四条原则

1. **复用，而不是重造。** 让知道答案的会话来回答，比让新会话从头查更准、也更快——它的上下文与缓存前缀都是热的。
2. **对等，没有根节点。** 会话之间平级互相提问，不存在"总控 Agent"派发一切。没有中心，就没有单点瓶颈，也不需要一个知道全部事情的会话。
3. **只提候选，绝不代发。** 路由（自动挑选候选会话）只给候选与理由，投递必须由你或主模型点名。宁可多问一句，也不猜错打扰。
4. **任务导向，不为通信而通信。** 跳数（一次提问最多经几个会话中转）上限、同一时刻每会话只等一个、长任务走异步不阻塞、失败一律静默降级。**节点多不等于聪明，路由质量才是。**

### 三个工具

| 工具 | 作用 |
|---|---|
| `list_sessions` | 会话名录：标题、工作目录、活跃度、是否运行中。只读，不唤醒任何人 |
| `ask_session` | 把问题交给另一个会话并唤醒它；可同步等，也可 `detach` 异步投递，投递即返回 `askId` |
| `ask_result` | 取异步结果（等待中 / 已完成 / 超时 / 出错）；记录里带 `parentAskId`，可顺着链条往上追 |

### 怎么找到"该问的那一个"

没点名时，插件按**标题 + 工作目录**给会话打分。中文按两字组切分。随后用硬规则收敛：消息里出现某会话名称、标题命中关键词，或目录命中项目名。排序时依次比较：综合分数 → 标题命中优先于目录命中 → 是否运行中 → 上下文是否足够（日志体积达到 160,380 字节门槛）→ 活跃时段（热/温/冷）→ 同项目上下文更大 → 最近活跃时间 → 标题长度（越短越前）。

可选再叠加一层 Jev 判断（设置 → 插件 → 顾问群 → 全局蜂群 → 路由方式）。把候选作为闭合选项交给 Jev，若置信度不足则保持本地排序。

它还能判断当前轮次是否需要向其他会话提问，分为三档：关、本地预过滤 + Jev（默认）、每轮都问。默认档先做零成本规则初筛：只有当用户消息暗示需要外援且未指定目标时，才会发起 Jev 调用。即便判定为真，也只在下轮系统提示中注入一行建议，最终仍由主模型自主决定是否发问。

### 边界与诚实

- **区间语义**：获取的内容是「从投递回执到目标会话下一次空闲」之间的全部发言，并非逐条问答。结果附带 `status`（`ok` / `partial` / `failed`）标明可靠性。
- **成本护栏**：限制中转跳数 ≤ 2，禁止向自身或子会话发问，同一会话同一时刻只等一个请求，载荷上限 32 KB。异步结果超时自动清理。可在「不参与路由的会话」中排除特定会话。插件永不强行中断对方的回合。
- **失败即沉默**：遇到 Jev 超时、响应异常或候选超出名录时，静默退回本地规则判定，不打扰用户、不误投递、不乱报错。
- **可追溯**：每次 Jev 判定都会在 `storages/advisor-group/asks/routing-jev.log` 写入一行日志，方便事后审计。

### 实操细节

- **怎么指定目标**：支持完整会话 ID、精准标题或自然简称。通常输入工作目录名即可（例如目录为 `I:\极简遥控器\…` 的会话，直接说「极简遥控器」）。唯一匹配直接投递；命中多个时列出候选供你挑选；匹配不确定时绝不盲猜。
- **界面上看到什么**：提问侧弹出聊天组卡片。先显示「已投递，等待对方回应…」，随后呈现对方回答气泡与「📌 投递说明」（标明通道与截止时间）。若目标定位失败则不弹卡片，仅在工具调用行输出报错。
- **不想等怎么办**：默认同步等待（180 秒，可配置）。超时仅返回已收到的部分内容，不打断对方执行。需要并行处理时传入 `detach`，投递后立即返回 `askId`，后续通过 `ask_result` 查询。
- **成本**：详见「💸 用量与成本」。

一句话用法：直接说「问一下极简遥控器那个会话：进度到哪了」。

## ⚙️ 配置项

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 启用顾问群 |
| `discussion.maxRounds` | number | `2` | 自动深挖流水线总轮数（1–5；每轮 = 全体顾问接力，第 2 轮起先由驱动模型追问） |
| `discussion.maxAdvisorsPerCall` | number | `3` | 单次咨询最大顾问数（1–10） |
| `discussion.autoDeepen` | boolean | `true` | 是否在轮与轮之间生成更深追问；不影响轮数——关掉后仍按 `maxRounds` 重复提问，综合结论照常生成 |
| `discussion.driverModel` | object | – | 兜底驱动模型 `{provider, model}`（会话头信息不可读时） |
| `discussion.advisorTimeoutMs` | number | `600000` | 单顾问调用超时（毫秒，1000–600000），双通道均生效 |
| `discussion.driverTimeoutMs` | number | `600000` | 驱动模型生成超时（深挖追问/综合结论；毫秒，1000–1200000） |
| `discussion.advisorTools` | string | `'readonly'` | 全局默认顾问工具调用范围（未单独设置时）：`readonly`（只读白名单 read/grep/glob/web_search/web_fetch…）｜`all`（全部会话可见工具，含可写，慎用）｜`off`（关闭）。仅直连通道（OpenAI/Anthropic）支持工具调用（要求见「🔒 安全与隐私」）。 |
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
| `swarm.enabled` | boolean | `true` | 跨会话功能总开关；关闭后 `ask_session` / `list_sessions` / `ask_result` 明确拒绝，不静默失效 |
| `swarm.defaultMode` | string | `'wait'` | 默认应答方式：`wait` 同步等待｜`detach` 异步投递（显式传参永远优先） |
| `swarm.defaultWaitMs` | number | `180000` | 默认等待上限（毫秒，1000–600000） |
| `swarm.resultTtlHours` | number | `24` | 异步结果保留时长（小时，1–720；取结果时顺带清理过期记录） |
| `swarm.rosterIncludeSubagents` | boolean | `false` | 会话名录是否列出子代理会话 |
| `swarm.routingEnabled` | boolean | `true` | 没点名目标时，按问题匹配候选（只提候选，绝不自动投递） |
| `swarm.routingTopN` | number | `3` | 返回的候选个数（1–8） |
| `swarm.routingEngine` | string | `'local'` | 路由方式：`local` 本地打分｜`jev` 交 Jev 排序（闭合选项，失败自动回落本地） |
| `swarm.routingAsk` | string | `'gated'` | 是否该问别的会话：`off`｜`gated` 本地预过滤 + Jev（默认）｜`always` 每轮都问 |
| `swarm.routingExclude` | string[] | `[]` | 不参与路由的会话（标题关键词或完整 sessionId，一行一个）；被点名时拒绝投递 |
| `ui.theme` | string | `retro-green` | 卡片主题（retro-green / retro-amber / retro-blue） |
| `ui.showTimestamps` | boolean | `true` | 显示时间戳 |
| `ui.autoExpand` | boolean | `true` | 自动展开卡片 |
| `advisors[].tools` | string | – | 每个顾问的**单独**工具调用范围覆盖（`readonly`/`all`/`off`；未设置时跟随全局默认）；设置卡片上：可直连的顾问显示下拉，DSH 内置通道的顾问会提示「当前为 DSH 内置通道（复用 DSH 凭据），不支持工具调用」——为其配置 `baseURL`/`apiKey`/`apiKeyEnv` 走直连通道后即可启用。 |
| `advisors[].thinking` | string | – | 单顾问思考模式：`enabled` / `disabled`；未设置为供应商默认，`disabled` 强制不带思考块（内置通道映射为 `reasoningEffort: 'off'`） |
| `advisors[].reasoningEffort` | string | – | 单顾问思考强度：`off` / `low` / `high` / `max`；未设置为供应商/模型默认，`off` 在每次请求中关闭思考 |
| `advisors[].temperature` | number | – | 采样温度（0–2）；未设置为供应商默认 |
| `advisors[].maxTokens` | number | – | 单次回答的 token 上限（≥1）；未设置为供应商默认 |
| `advisors[].authMode` | string | – | Anthropic 直连通道的鉴权头风格：`x-api-key` / `bearer` |
| `advisors[].avatar` | string | – | 卡片上的短头像（emoji 或 ASCII） |
| `advisors` | array | `[]` | 顾问列表（provider/model/baseURL/apiKey/apiKeyEnv/protocol…，key 均标 `role('secret')`） |

> `discussion.parallel` 与 `discussion.stopOnConsensus` 为弃用遗留项，仅保留以兼容已存配置。

## 🧮 每日配额

插件内置成本安全阀。它按 UTC 日历日统计新咨询次数，默认上限为 50 次，支持在设置页调整或直接关闭。配额仅限制新发起的咨询，通过「▶ 继续聊天」续跑及后续追问均不计入。

判断与自增在同一同步块内完成，避免并发穿透。计数结果原子落盘于 `$DSH_HOME/storages/advisor-group/daily-guard.json`，重启不丢失，并在 UTC 零点自动重置。额度耗尽时，`ask_advisors` 会拒绝启动并返回说明。设置页实时显示「今日剩余咨询次数 X / Y」；关闭上限开关后仅统计数据，不执行拦截。

## 💸 用量与成本

一次咨询由一连串模型调用组成。在默认配置（`maxRounds = 2`、最多 3 位顾问）下，发起一次新咨询共包含 **8 次**模型调用：第 1 轮 3 位顾问各调用 1 次；第 2 轮驱动模型追问 1 次，随后 3 位顾问各调用 1 次；最后由驱动模型生成综合结论 1 次。若顾问启用了工具调用，每轮工具往返会额外增加调用（单顾问上限 4 轮工具交互，外加 1 次最终文字作答），实际消耗会高于 8 次。

费用按渠道独立结算：顾问按各自配置的渠道与模型计费，驱动模型按当前会话的模型计费。若需控制成本，可调低 `maxRounds`、减少顾问人数、将顾问工具设为 `tools: 'off'`，并在「🧮 每日配额」中设定合理的每日上限。咨询中断后，点击「▶ 继续聊天」仅为未完成的顾问补答，无需重跑整场流程，成本显著低于新建咨询。

`ask_session` 不占用咨询配额。它仅唤醒目标会话并触发一次常规应答，费用记入目标会话自身模型，不视作新发起的顾问咨询。

## 🔒 安全与隐私

- 直连 API Key 存于 DSH `settings.yaml`（标注为 secret 字段，官方 `describe` 不向前端回传）。若不希望密钥落盘，可使用 `apiKeyEnv` 环境变量模式。
- `/advisor-group/*` 路由采用单机共享 token 机制，面向本地单用户场景。若需暴露到局域网或公网，必须在外层前置反向代理鉴权。
- 诊断端点在服务端解出真实密钥后请求服务商，并对目标 URL 执行 https-only 与 loopback 的 SSRF 校验。DNS rebinding 属于已知的架构边界。
- 每日咨询上限的计数机制、持久化文件与重置规则详见「🧮 每日配额」。
- 分类器影子模式：开启 `trigger.requireClassifier` 时，所有判定样本均会记录到只读端点 `/advisor-group/shadow`（包含 `@顾问群` 与重复 3 次等跳过分类器的场景，标记为 `provider: 'bypass'`），仅用于阈值调优，不影响运行逻辑。
- **`advisorTools: 'all'` 属于高风险作用域**：该模式会将当前会话所有可见工具（包括 `pwsh`/`bash`/`write` 等写操作与命令执行类）暴露给顾问模型，并由官方守卫管线执行。建议仅对受信任的本地模型开启。工具调用仅支持直连通道（OpenAI/Anthropic）；DSH 内置通道复用宿主凭据，不支持工具调用，如需使用请为顾问配置 `baseURL`/`apiKey`/`apiKeyEnv` 直连。所有非只读工具调用均输出 `console.warn` 留存审计日志。日常建议配置为 `readonly` 或 `off`（只读白名单见「✨ 功能特性」）。

## ⚠️ 已知限制

- DSH 宿主进程崩溃时，未刷新的卡片可能仍保持 **LIVE** 标识（目前前端已加入断线提示）。页面刷新后会按会话持久化日志恢复真实状态。
- 风险提示基于客观运行事实生成，包括超时/网络中断引起的截断，以及手动停止导致的取消。提示会展示在已停止或已完成的卡片中，并随 `ask_advisors` 返回主模型。插件不扫描顾问回复的关键词；早期版本那套"凭字眼猜立场"的启发式已在 0.1.1 移除，原因是它连「没有任何风险」这样的否定句也会当成风险提示——盲测里 4 条纯否定句全部误报。
- 跨会话提问（`ask_session`）目前未提供针对单会话隐藏工具的独立开关。`swarm.enabled` 作为全局总开关，开启后三个工具在所有会话中均可见，依靠提示词约束仅在明确要求时调用。暂不支持检测两个会话循环互相等待的死锁情况。

## 🛠️ 开发

```sh
npm install --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm test        # vitest 单测（含本地假 LLM 服务器上的供应商流式契约）
npm run build   # tsdown；客户端 bundle 禁用 minify: true
```

## 📄 许可证

[Apache License 2.0](LICENSE) © 2026 dsh-advisor-group contributors.

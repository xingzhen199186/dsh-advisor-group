# dsh-advisor-group

> 让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的一个会话，既能**向其他模型借智慧**，也能**向其他会话借记忆**。

[English](README.en.md) · [安装](#兼容性与安装) · [快速开始](#快速开始) · [核心功能](#核心功能) · [配置参考](#配置参考) · [开发](#开发)

[![npm version](https://img.shields.io/npm/v/dsh-advisor-group.svg)](https://www.npmjs.com/package/dsh-advisor-group)
[![DSH plugin](https://img.shields.io/badge/DSH%20plugin-dsh--plugin-3f8cff)](https://github.com/topics/dsh-plugin)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

| 能力 | 它帮你做什么 |
| --- | --- |
| **多模型会诊（顾问群）** | 面对专业、高风险或没有把握的问题，让多位专家模型接力回答，再由驱动模型汇总结论。 |
| **跨会话协作（全局蜂群）** | 直接询问另一个已有会话，复用它读过的代码、做过的排查和定下的约定，不必从零再来。 在本会话子代理功能之外，提供模型跨项目写作的能力。|
| **顾问团角色卡** | 给会话分配姓名和职责。之后直接说“去问小明”，不必记会话标题或 sessionId。 |

> **版本边界**：本页对应当前 `main`。npm `0.1.4` 尚未包含顾问团角色卡、批量提问 `ask_sessions`、答案自动回送及相关的等待状态改进；使用这些新能力请按[源码安装](#从源码安装-main)构建。各发布版本的说明见 [Releases](https://github.com/xingzhen199186/dsh-advisor-group/releases) 与 [CHANGELOG](CHANGELOG.md)。

## 兼容性与安装

| 项目 | 说明 |
| --- | --- |
| DSH | 当前开发基线为 `0.2.1-rc.3`；声明可安装的版本范围（peer）为 `>=0.1.7-rc.2 <0.3.0` |
| Node.js | 从源码构建时需要 `^22.19.0 || >=24.0.0` |
| 使用端 | DSH Web 与桌面端，共用同一份客户端代码包 |

声明范围内的更早版本没有逐一实装验证。跨会话功能还需要宿主提供会话控制服务 `sessionController`；缺少该服务时，相关工具会明确报错，多模型会诊不受影响。

### 安装 npm 发布版

DSH Web：

```sh
dsh plugin --profile web add dsh-advisor-group
```

安装后按你原来的方式重启 DSH Web，并硬刷新浏览器（`Ctrl+Shift+R`）。

**桌面端**：在应用内打开 **Plugins → Add plugin**，输入 `dsh-advisor-group`。桌面端的配置清单由应用管理，`dsh plugin --profile desktop …` 会被官方拒绝，这不是权限不足。

### 从源码安装 main

```sh
git clone https://github.com/xingzhen199186/dsh-advisor-group.git
cd dsh-advisor-group
npm install --legacy-peer-deps --no-audit --no-fund
npm run build
npm pack

# 以 npm pack 实际生成的文件名为准
# 当前 package.json 版本为 0.1.4，因此文件名如下：
dsh plugin --profile web add ./dsh-advisor-group-0.1.4.tgz
```

桌面端安装源码包时，在 **Plugins → Add plugin** 中填写这个 `.tgz` 文件的绝对路径。安装后重启相应的 DSH 端。

## 快速开始

### 路径一：让多位模型一起会诊

1. 打开 **设置 → 插件 → 顾问群**。
2. 至少添加一位顾问，选择供应商路由和模型；可用「获取模型列表」读取该线路的模型清单。
3. 在问题前加上 `@顾问群`，并交代必要背景。例如：

   ```text
   @顾问群 请评审这个插件的跨会话协作方案。
   背景：DSH Web 与桌面端共用一份代码，要求不自动投递、不猜测目标会话。
   ```

`@顾问群` 会强制发起会诊。普通专业问题也可以由主模型按规则升级；同一问题连续三次未解决，或主模型给出的置信度低于阈值，也会触发会诊。

<img width="720" alt="顾问群设置页：按使用路径分为启用与每日配额、顾问列表、会诊行为、触发与分类、全局蜂群和高级，默认全部折叠" src="https://raw.githubusercontent.com/xingzhen199186/dsh-advisor-group/main/docs/images/advisor-group-settings.png" />

设置页按使用路径分区，默认全部折叠；展开哪一节，就在那一节底部保存。

### 路径二：按名字询问另一个会话

1. 打开任意会话里的 **「顾问团」**标签页；标签栏空间不足时，它可能位于「…」菜单中。
2. 给目标会话填写「身份姓名」和「主要负责」，再点「加入顾问团」或「保存」。也可以点「用主模型生成」，检查建议后逐条保存，或用「保存全部更改」一次提交。
3. 回到对话，直接说：

   ```text
   去问一下小明：顾问团角色卡今天完成了哪些改动？
   ```

   也可以一次问多位成员：

   ```text
   同时问小明和阿龙：分别检查这个方案在桌面端和 Web 端有没有遗漏，并汇总两边结论。
   ```

自动生成的内容只会填入草稿；**保存后才生效，已有卡不会被覆盖**。原来的会话标题、目录名和 sessionId 仍然可用。

## 核心功能

### 多模型会诊：自动深挖，而不是只问一遍

一次 `ask_advisors` 会完成整场讨论：

```text
原问题
  → 第 1 轮：顾问 A → 顾问 B（看过 A）→ 顾问 C（看过 A、B）
  → 后续轮：驱动模型提出更深追问 → 顾问按同样顺序接力
  → 驱动模型生成综合结论
```

<img width="865" height="983" alt="顾问群会诊卡片：按行动、思考、工具调用和正文逐步展示顾问回答" src="https://github.com/user-attachments/assets/5660ce94-70f0-42ed-84e4-9f926d1e2c64" />

- **讨论轮数可控**：`maxRounds` 为 1–5，默认 2。关闭 `autoDeepen` 后，后续轮次重复使用原问题，综合结论仍会生成。
- **驱动模型复用当前会话线路**：负责深挖追问与综合结论，不需要另配一套模型；无法读取当前线路时使用 `discussion.driverModel` 兜底。
- **顾问可以使用会话工具**：默认只允许只读工具，调用过程进入卡片；最多 4 轮工具交互后必须用文字作答。工具范围可全局设置，也可按顾问覆盖。
- **流式卡片保留过程**：绿色 CRT 卡片按 `📋 行动 → 💭 思考 → ⛭ 工具 → 📄 正文`展示。思考和工具详情默认折叠，正文默认展开。
- **停止后可以从断点继续**：人工停止或宿主重启后，「▶ 继续聊天」只补未完成的顾问和轮次，不重新询问已经完成的顾问。
- **可选 Jev 前置判断**：默认关闭。开启后可判断是否该找顾问、是否高风险、是否更适合联网；Jev 不可用时回退到本地规则分类器。
- **12 个平台、28 个供应商预设**：DeepSeek、月之暗面 Kimi、Kimi Code、阿里云百炼、智谱 AI、OpenAI、Claude、Gemini、硅基流动、AIHubMix、OpenRouter、OpenCode Go。

### 顾问团：给会话一个稳定身份

会话标题适合描述窗口，却不一定适合长期称呼。顾问团把「姓名 + 职责」绑定到会话 id，并保存在本机 `$DSH_HOME/storages/advisor-group/corps.json`；它不会改写会话标题。

<img width="760" alt="顾问团面板：每个可见会话一行，显示角色姓名、职责、复制姓名和保存按钮" src="https://raw.githubusercontent.com/xingzhen199186/dsh-advisor-group/main/docs/images/advisor-corps-panel.png" />

- 姓名全局唯一，不区分大小写；最长 40 个字符。职责最长 200 个字符。
- 「用主模型生成」使用**当前打开会话的模型**，每次最多为 12 个未分配会话生成建议，只填草稿，不自动保存。
- 可逐条修改、复制姓名、批量保存或移除。已归档、被排除、离开工作区或已不存在的会话，其角色卡会归入「未挂接」，可保留或删除。
- `list_sessions` 会显示角色姓名和职责；`ask_session`、`ask_sessions` 可以直接使用这个角色名，精确角色名优先于同名会话标题。

### 跨会话协作：问一个，也可以问一组

- **单人会话提问**：`ask_session` 默认同步等待，也可用 `detach: true` 立即返回 `askId`，稍后通过 `ask_result` 读取。
- **批量提问**：`ask_sessions` 一次向 1–8 个明确目标发送同一个问题。`mode: 'all'` 等全部目标结束；`mode: 'any'` 在首个目标结束后返回，其余目标继续完成并写入各自记录。
- **答案自动回送**：`swarm.deliverBack` 默认开启。完成（`done`）的答案会回送到提问会话；超时和出错不会自动回送。批量提问把完成答案合并为一条回送消息。
- **结果可追查**：每个被投递的目标都有独立 `askId`。异步记录可能是 `waiting`、`done`、`timeout`、`error` 或 `interrupted`；最后一个状态表示宿主重启使等待未能完成。
- **不猜目标**：`ask_session` 未点名时，路由只返回候选，不自动投递。`ask_sessions` 不做路由；无法解析、同名歧义或被排除的目标会列出跳过原因。
- **有明确的协作护栏**：最多 2 跳中转；不能问自己或子代理会话；同一提问会话同时只等待一个 `ask_session` 请求；问题和背景合计上限 32,000 字节；等待超时不会取消目标会话的回合。

> **返回内容的准确含义**：工具取得的是目标会话从「投递回执」到「下一次整体空闲」之间说过的全部内容，不保证是逐条对应你那个问题的一段答案。结果中的 `status`（`ok` / `partial` / `failed`）用于说明这次收集的可靠性。

## 模型工具参考

这些工具由主模型在会话中调用，**不是斜杠命令，也不需要你手写工具参数**。跨会话工具只应在你明确要求询问其他会话或窗口时使用。

| 工具 | 用途 |
| --- | --- |
| `ask_advisors` | 发起多模型会诊，或用 `sessionId + followUp` 追加一轮讨论 |
| `ask_session` | 询问一个已有会话；支持同步等待、异步投递和候选路由 |
| `ask_sessions` | 向 1–8 个明确目标批量提问；支持 `all` / `any` 两种收集方式 |
| `list_sessions` | 只读列出会话标题、目录、活跃状态及顾问团姓名和职责；不唤醒会话 |
| `ask_result` | 按 `askId` 读取异步结果，或查看当前会话最近发起的提问 |
| `toggle_advisor_group` | 启停多模型会诊功能，并持久化开关状态 |

## 配置参考

日常使用时，通常只需要调整以下几项：

| 配置键 | 默认值 | 什么时候调整 |
| --- | --- | --- |
| `discussion.maxRounds` | `2` | 想减少成本时调低；想讨论更深时调高，最高 5 |
| `discussion.maxAdvisorsPerCall` | `3` | 控制每次参与会诊的顾问人数，范围 1–10 |
| `discussion.advisorTools` | `'readonly'` | 改为 `'off'` 禁止顾问用工具；`'all'` 仅用于充分信任的场景 |
| `quota.enabled` / `quota.maxPerDay` | `true` / `50` | 设置每日新会诊上限；关闭上限后仍统计次数 |
| `swarm.defaultMode` | `'wait'` | 改为 `'detach'`，让跨会话提问默认异步投递 |
| `swarm.defaultWaitMs` | `180000` | 调整默认等待上限，范围 1000–600000 毫秒 |
| `swarm.deliverBack` | `true` | 关闭后，完成答案只通过 `ask_result` 读取，不自动回送 |

<details>
<summary><strong>展开完整配置键参考</strong></summary>

### 讨论与顾问

| 配置键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 启用多模型会诊 |
| `discussion.maxRounds` | number | `2` | 会诊总轮数，1–5 |
| `discussion.maxAdvisorsPerCall` | number | `3` | 单次会诊最大顾问数，1–10 |
| `discussion.autoDeepen` | boolean | `true` | 后续轮次是否由驱动模型生成更深追问；关闭后重复原问题，结论仍生成 |
| `discussion.driverModel` | object | – | 当前会话线路不可读时使用的 `{ provider, model }` |
| `discussion.advisorTimeoutMs` | number | `600000` | 单顾问超时，1000–600000 毫秒 |
| `discussion.driverTimeoutMs` | number | `600000` | 深挖追问或综合结论的超时，1000–1200000 毫秒 |
| `discussion.advisorTools` | string | `'readonly'` | 顾问工具默认范围：`readonly` / `all` / `off` |
| `advisors` | array | `[]` | 顾问列表；包含 `provider`、`model`、`systemPrompt`，以及可选的 `baseURL`、`apiKey`、`apiKeyEnv`、`protocol` 等 |
| `advisors[].tools` | string | – | 单顾问工具范围，覆盖全局默认；未设置时跟随 `discussion.advisorTools` |
| `advisors[].thinking` | string | – | `enabled` / `disabled`；未设置时跟随供应商默认 |
| `advisors[].reasoningEffort` | string | – | `off` / `low` / `high` / `max`；未设置时跟随供应商或模型默认 |
| `advisors[].temperature` | number | – | 采样温度，0–2 |
| `advisors[].maxTokens` | number | – | 单次回答的 token 上限，至少 1 |
| `advisors[].authMode` | string | – | Anthropic 直连的鉴权头：`x-api-key` / `bearer` |
| `advisors[].avatar` | string | – | 卡片上的短头像，可使用 emoji 或 ASCII |

顾问工具调用仅直连的 OpenAI / Anthropic 通道支持。DSH 内置通道可复用宿主凭据进行普通回答，但不支持这里的顾问工具循环。

### 触发判断与 Jev

| 配置键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `trigger.requireClassifier` | boolean | `true` | 非强制会诊发起前先进行前置分类 |
| `trigger.allowWebFallback` | boolean | `true` | 分类器认为更适合联网时，返回不启动会诊的提示 |
| `trigger.confidenceThreshold` | number | `0.6` | 主模型置信度低于此值时允许升级，范围 0–1 |
| `trigger.jev.enabled` | boolean | `false` | 使用 Jev 做语义前置分类；失败时回退本地规则 |
| `trigger.jev.provider` / `trigger.jev.model` | string | `'typesafe'` / `'jev-latest'` | Jev 线路与模型；线路也可设为 `openrouter` |
| `trigger.jev.baseURL` | string | – | 可选自定义 Jev 地址 |
| `trigger.jev.apiKey` / `trigger.jev.apiKeyEnv` | string | – | Jev 密钥或保存密钥的环境变量名；密钥字段按 secret 处理 |
| `trigger.jev.timeoutMs` | number | `10000` | Jev 请求超时，1000–60000 毫秒 |
| `trigger.jev.confidenceThreshold` | number | `0.6` | 判定需要顾问的阈值 |
| `trigger.jev.highRiskThreshold` | number | 跟随上一项 | 高风险判定阈值；未设置时跟随 `trigger.jev.confidenceThreshold` |
| `trigger.jev.useEnglishState` | boolean | `false` | 开启后，Jev 使用调用方提供的英文概要 `questionEn`；卡片和会话记录仍保留原始问题 |

### 全局蜂群

| 配置键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `swarm.enabled` | boolean | `true` | 跨会话总开关；关闭后四个跨会话工具会明确拒绝调用 |
| `swarm.defaultMode` | string | `'wait'` | `ask_session` 默认同步等待或异步投递：`wait` / `detach` |
| `swarm.defaultWaitMs` | number | `180000` | 默认等待上限，1000–600000 毫秒 |
| `swarm.resultTtlHours` | number | `24` | 异步结果保留时间，1–720 小时 |
| `swarm.deliverBack` | boolean | `true` | 自动回送 `done` 答案；`timeout` / `error` 不自动回送 |
| `swarm.rosterIncludeSubagents` | boolean | `false` | 名录是否显示子代理；这不改变投递工具禁止以子代理为目标的规则 |
| `swarm.routingEnabled` | boolean | `true` | `ask_session` 未点名时是否按问题给出候选；只给候选，不自动投递 |
| `swarm.routingTopN` | number | `3` | 候选数量，1–8 |
| `swarm.routingEngine` | string | `'local'` | `local` 本地排序，或 `jev` 重排闭合候选；Jev 失败时回退本地 |
| `swarm.routingAsk` | string | `'gated'` | 是否建议跨会话提问：`off` / `gated` / `always`；建议不等于投递 |
| `swarm.routingExclude` | string[] | `[]` | 不参与蜂群的会话；不出现在名录或候选中，被点名也会拒绝 |

### 历史兼容项

`discussion.parallel` 与 `discussion.stopOnConsensus` 已弃用，只为读取旧配置保留。

`ui.theme`、`ui.showTimestamps`、`ui.autoExpand` 同样是历史配置字段；当前客户端没有读取它们，修改这些值不会改变卡片外观或展开行为。当前卡片为绿色 CRT 样式，思考与工具详情默认折叠。

</details>

## 用量、配额与成本

完成 `R` 轮讨论、每轮有 `N` 位顾问且没有工具调用时，一场会诊通常包含 **`R × (N + 1)` 次模型调用**：`R × N` 次顾问回答、`R - 1` 次深挖追问，以及 1 次综合结论。按默认轮数 `R = 2`、每场实际有 3 位顾问参与计算时为 8 次。

实际费用还取决于以下行为：

- 顾问的工具往返会增加模型调用；驱动模型与各位顾问按各自线路分别计费。
- 「用主模型生成」角色卡会对当前会话模型发起调用；Jev 分类或路由开启后也按相应线路计费。
- 跨会话提问不占用顾问会诊配额，但会唤醒目标会话，消耗目标会话自己的模型额度。批量提问按各个目标分别计算。

每日配额按 **UTC 日历日**统计新发起的会诊，默认 50 次。续跑、后续追问和跨会话提问不占用这项配额。计数保存在 `$DSH_HOME/storages/advisor-group/daily-guard.json`；关闭上限后仍计数，但不拦截。需要控制成本时，可减少轮数或顾问人数、关闭顾问工具，并设置每日上限。

## 安全与隐私

- **密钥不回显**：直连 API Key 保存在本机 DSH 配置中，按 `SecretField` 语义处理，不返回浏览器。不希望密钥写入配置时，可使用 `apiKeyEnv`。
- **本地路由有令牌**：`/advisor-group/*` 使用每次启动生成的共享 token，面向本地单用户场景。需要暴露到局域网或公网时，必须在外层增加反向代理鉴权。
- **诊断请求有限制**：模型列表和连接测试在服务端请求供应商，并校验目标 URL、协议和重定向。DNS rebinding 仍是已知的架构边界。
- **谨慎使用 `advisorTools: 'all'`**：它会把当前会话所有可见工具交给顾问，包括写文件和执行命令；调用仍经过 DSH 的工具管线与权限守卫。日常使用建议保持 `readonly` 或 `off`，非只读工具调用会写入警告日志。
- **跨会话内容会留痕**：问题和背景会永久写入目标会话日志，因此只发送必要信息。角色卡生成会把会话标题、工作目录和活跃提示交给当前主模型；角色卡本身保存在本机，不包含 API Key。
- **本地状态集中保存**：会诊快照、异步提问记录、角色卡和配额数据位于 `$DSH_HOME/storages/advisor-group/`。分类器影子日志仅用于阈值调优，不参与运行决策。

## 已知限制

- DSH 宿主突然崩溃时，未刷新的卡片可能仍显示 **LIVE**；页面刷新后会根据持久化日志恢复真实状态。前端已有断线提示。
- 风险提示只根据客观状态生成：超时或网络中断造成的截断，以及人工停止造成的取消。插件不再通过扫描顾问正文里的“风险”“不确定”等词来猜测风险。
- 跨会话工具目前没有按单个会话独立隐藏的开关。`swarm.enabled` 开启时四个工具对会话可见，关闭后调用会明确拒绝；两个会话互相等待的死锁目前也不会被专门检测。
- 角色卡面板最多显示 50 个可见会话；自动生成每次最多处理 12 个未分配会话，可以再次生成以继续补齐。

## 开发

```sh
npm install --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试使用 Vitest，包含供应商流式协议、跨会话投递与等待、角色卡、设置脱敏和恢复边界。构建使用 tsdown；客户端 bundle **不能使用 `minify: true`**，否则会破坏启动守卫所依赖的插件 id 形式。

- [更新记录](CHANGELOG.md)
- [问题反馈](https://github.com/xingzhen199186/dsh-advisor-group/issues)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## 许可证

[Apache License 2.0](LICENSE) © 2026 dsh-advisor-group contributors.

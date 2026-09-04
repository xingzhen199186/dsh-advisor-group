# dsh-advisor-group

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：主模型在遇到**专业、长尾世界知识、高风险或不确定**的问题时，召集多位**专家顾问模型**，在复古 CRT 聊天组卡片中真流式对话。

[![dsh-plugin](https://img.shields.io/badge/DSH%20plugin-dsh--plugin-3f8cff)](https://github.com/topics/dsh-plugin)

[English: README.md](README.md)

---

## ✨ 功能特性

- **自动深挖咨询流水线**：一次 `ask_advisors` 自动跑满 `maxRounds` 轮——每轮 = *驱动模型深挖追问 → 顾问 A → 顾问 B（看到 A）→ 顾问 C（看到 A+B）→ …* 顺序接力，最后驱动模型产出**综合结论**。
- **驱动模型零配置复用**：深挖追问由驱动模型生成，直接复用会话当前 agent 的 provider/model——无需额外配 Key 或模型；会话头不可读时回退 `discussion.driverModel`。
- **三种触发方式**：`@顾问群` 提及（强制启动）、同一问题重复 3 次未解决、主模型自评置信度低于阈值。
- **复古 CRT 聊天组卡片**：绿/琥珀/蓝三主题、扫描线、LIVE/DONE 标题、💭 思考面板默认展开自动滚底；顾问正文走轻量 Markdown 渲染（链接协议白名单，支持标题/列表/代码/引用/链接/表格）。
- **供应商预设（11 平台 · 26 预设）**：DeepSeek、月之暗面 Kimi、Kimi Code、阿里云百炼、智谱 AI、OpenAI、Claude、Gemini、硅基流动、AIHubMix、OpenRouter（含 OpenAI / Anthropic 兼容变体）。
- **注重安全**：API Key 采用官方 `SecretField` 语义（浏览器永不回显；`apiKeysByProvider` 供应商密钥档案仅存服务端）；诊断端点 SSRF 加固（仅 https/loopback、拒绝 IP 字面量与重定向）；`/advisor-group/*` 路由启动期 token 鉴权；每日新咨询**可配置原子配额**（默认 50，可关闭），持久化跨重启。
- **运行时开关**：`toggle_advisor_group` 启停插件并持久化到设置。

## ✅ 兼容性

| 项目 | 状态 |
|---|---|
| Harness | DeepSeek Harness `0.1.2-rc.1` |
| Node | `^22.19.0 \|\| >=24.0.0` |
| 平台 | DSH Web（客户端 bundle）+ headless 宿主逻辑 |

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
> dsh plugin --profile web add ./dsh-advisor-group-0.1.0.tgz   # 先 npm pack
> ```

## 🚀 快速开始

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
| `discussion.advisorTimeoutMs` | number | `120000` | 单顾问调用超时（毫秒，1000–600000），双通道均生效 |
| `quota.enabled` | boolean | `true` | 启用每日咨询上限（成本安全阀） |
| `quota.maxPerDay` | number | `50` | 每日 UTC 日周期内最多新咨询次数（1–100000）；`quota.enabled=false` 时不生效 |
| `trigger.requireClassifier` | boolean | `true` | 发起前先跑前置分类器 |
| `trigger.allowWebFallback` | boolean | `true` | 分类器建议联网搜索时返回该提示 |
| `trigger.confidenceThreshold` | number | `0.6` | 主模型置信度低于该值时升级 |
| `ui.theme` | string | `retro-green` | 卡片主题（retro-green / retro-amber / retro-blue） |
| `ui.showTimestamps` | boolean | `true` | 显示时间戳 |
| `ui.autoExpand` | boolean | `true` | 自动展开卡片 |
| `advisors` | array | `[]` | 顾问列表（provider/model/baseURL/apiKey/apiKeyEnv/protocol…，key 均标 `role('secret')`） |

> `discussion.parallel` 与 `discussion.stopOnConsensus` 为弃用遗留项，仅保留以兼容已存配置。

## 🔒 安全与隐私

- 直连 API Key 可存于 DSH `settings.yaml`（标 secret，官方 `describe` 绝不回传浏览器）；不想落盘请用 `apiKeyEnv` 环境变量模式。
- `/advisor-group/*` 路由为**单机共享 token**（本地单用户使用），不是多用户鉴权；暴露局域网必须外层加反代鉴权。
- 诊断端点服务端按存档 key 解析真实值再打供应商，并对目标 URL 做 https-only/loopback SSRF 校验；DNS rebinding 记为文档化已知边界。
- 每日咨询上限（`quota.*` 可配置，默认 50、可关闭）持久化在 `$DSH_HOME/storages/advisor-group/daily-guard.json`（UTC 日切），重启不再归零。
- 分类器影子模式：每次非强制分类追加一条观测样本（只读 `/advisor-group/shadow`），仅用于阈值调优，绝不干预行为。

## 🛠️ 开发

```sh
npm install --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm test        # 64 单测（含本地假 LLM 服务器上的供应商流式契约）
npm run build   # tsdown；客户端 bundle 禁用 minify: true
```

## 📄 许可证

[Apache License 2.0](LICENSE) © 2026 dsh-advisor-group contributors.

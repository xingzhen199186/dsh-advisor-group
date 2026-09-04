# dsh-advisor-group

DeepSeek Harness（DSH）插件：主模型遇到专业、长尾世界知识、高风险或不确定问题时（或用户 `@顾问群`、同一问题重复 3 次仍未解决时），调用 `ask_advisors` 启动“顾问群”。顾问模型以**真实流式**返回思考过程与 Markdown 正文，在对话流中展示复古 CRT 聊天群卡片；主模型可通过 `sessionId + followUp` 继续追问，`maxRounds` 封顶总轮数。

## Compatibility

| 项目 | 状态 |
|---|---|
| Harness | DeepSeek Harness `0.1.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| 平台 | DSH Web（含 client bundle）；host 逻辑可在 headless 运行 |

## What it does

- `ask_advisors`：创建顾问会话，每次调用只跑**一轮**（主模型问 → 顾问答一次）；跨轮讨论由主模型用 `sessionId + followUp` 驱动。
- `toggle_advisor_group`：运行时启用/禁用，并持久化到 settings。
- 触发机制：
  - 用户消息 `@顾问群` / 点名“顾问群” → 绕过分类器强制启动；
  - 同一问题重复 3 次仍未解决 → 强制升级；
  - 主模型自评 `confidence`（0–1）低于阈值（默认 0.6）→ 分类器升级。
- 双通道流式：DSH `ctx.llm` 与 direct-http（OpenAI/Anthropic/Gemini）统一逐 delta 推送 + 200ms 节流落盘。
- SSE 流：`/advisor-group/stream`，带 `eventId`/`bootId`、500 条 5 分钟回放缓冲、重启/缺口 `resync` 通知。
- 复古 CRT 聊天群卡片：思考面板默认展开并自动滚底；顾问正文支持 Markdown（标题/列表/代码块/引用/链接/**表格**）。
- 可视化设置页：设置 → 插件 → 顾问群。
- 安全：API key 读回掩码、`/advisor-group/*` 路由 token 鉴权、每日 50 次新咨询护栏（原子计数）。

## Install

```sh
npm run build
npm pack --pack-destination .
dsh plugin --profile web remove dsh-advisor-group  # 如果已安装旧版
dsh plugin --profile web add ./dsh-advisor-group-0.1.0.tgz
```

安装后重启 DSH web 并硬刷新浏览器（`Ctrl+Shift+R`）。

## Configuration

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否启用顾问群 |
| `discussion.maxRounds` | number | `2` | **会话总轮数上限**（每次 ask 一轮，追问计入） |
| `discussion.maxAdvisorsPerCall` | number | `3` | 单次最多顾问数（1-10） |
| `discussion.parallel` | boolean | `true` | 同一轮是否并行调用顾问 |
| `discussion.stopOnConsensus` | boolean | `false` | （暂悬空：轮次语义已改为每 ask 一轮） |
| `trigger.requireClassifier` | boolean | `true` | 调用前是否通过前置分类器 |
| `trigger.allowWebFallback` | boolean | `true` | 分类器建议联网时是否返回搜索提示 |
| `trigger.confidenceThreshold` | number | `0.6` | 主模型置信度低于该值时升级 |
| `ui.theme` | string | `retro-green` | 聊天卡片主题 |
| `ui.showTimestamps` | boolean | `true` | 是否显示时间戳 |
| `ui.autoExpand` | boolean | `true` | 是否自动展开卡片 |
| `advisors` | array | `[]` | 顾问列表（provider/model/baseURL/apiKey/apiKeyEnv/protocol 等） |

配置由 `src/config.ts` 中的 Schemastery `Config` 模式校验；可通过设置页或 `ctx.settings` 持久化。

## Development

```sh
npm install --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

注意：client bundle 禁止开启 `minify: true`，否则 `dsh-startup-guard` 会误判并自动禁用插件。详见 `开发注意事项.md`。

## Verification

- `typecheck` / `build` 通过
- `vitest`：24 个单测（分类器 4、客户端 round 匹配 3、Markdown 链接/表格/XSS 5、SSE 回放/resync 3、设置 API key reconcile 9）
- 端到端 RPC：`start → delta → message(round=1) → end`；追问后 `main 追问 → message(round=2) → end`
- 路由鉴权：无 token 401，index 注入 token 200，配置 key 掩码

## Known limitations

- 路由 token 是单机共享 token，非多用户鉴权；局域网暴露需外层反代鉴权。
- 每日计数为内存态，重启归零。
- SSE 断连不会取消在途顾问调用（当前靠 120s 单顾问超时兜底）。
- 轻量 Markdown 不支持嵌套列表/内联 HTML/复杂表格。

## License

[Apache License 2.0](LICENSE) © 2026 dsh-advisor-group contributors.

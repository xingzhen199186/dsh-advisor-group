# dsh-advisor-group TODO

## 进行中
- [x] 完成顾问群插件完整设计方案
- [x] 从知识 X 提取 9 个 Provider API 接入参数与模型清单
- [x] 验证 DSH ctx.llm / llm-pi-ai 复用方案
- [x] 生成插件骨架（host + client bundle）
- [x] 实现顾问会话服务（多顾问、讨论轮次、轮数上限、状态管理）
- [x] 实现 ask_advisors 与 toggle_advisor_group 工具
- [x] 实现 classify_request 前置分类器
- [x] 实现复古聊天群 UI 卡片（对话流中、实时消息、CRT 风格）
- [x] 实现“设置 → 插件 → 顾问群”可视化配置页与配置持久化
- [x] 本地 DSH 冒烟验证 + 用户实机验证（client bundle 200、UI 完整加载）
- [x] 同步知识库 X 留档（插件条目 + DSH 总览）——2026-09-04 更新 `D:\X\X\23-DSH\plugins\dsh-advisor-group\dsh-advisor-group.md` 与 `dsh-plugins 总览.md`（0.1.2-rc.1 适配记录 + 语义修正）

## Review
- **2026-09-05 自动深挖流水线（核心语义变更，用户需求）**：一次 `ask_advisors` 自动跑满 `maxRounds` 轮——每轮 =（第 2 轮起）**驱动模型**（`src/driver.ts`：session `requestHeader().config` 取当前 Agent provider/model → 回退 `discussion.driverModel` → 静态文本，永不中断）生成深入追问（main 消息入列+落盘+SSE）→ 顾问按配置顺序**接力**（`runOneRound` 改 for...of 逐位重建 transcript；`advisorJoinPrompt` 告诉后接入者给独立见解、明示与前序差异；`discussion.parallel` 同步弃用）；最后驱动模型生成**综合结论**（`ConsultSummary.conclusion` → `advisor-group/end` → 卡片「📌 综合结论」段）。设置页：parallel 复选框 → **autoDeepen** 复选框；`sessionId+followUp` 保留为手动单轮追加（受封顶）。工具描述/主模型边界 prompt 同步更新。新增 `tests/driver.test.ts`（5 用例），**64/64**；typecheck/build 通过；已打包重装 + 重启（待实机验证 A→B→C 接力 + 自动追问 + 综合结论）。
- **2026-09-05 实机回归三点全过（用户确认卡片渲染正常）**：① 多轮+封顶（maxRounds=3 配置下第 4 次 followUp 被拒）；② 分类器（普通问题拦截 / 专业问题升级真跑）+ 影子样本 launched:false/true 双条落盘 + daily-guard 仅计真实咨询；③ 复古 CRT 卡片正常。
- **2026-09-05 产物性完成（影子模式——任务池清零）**：新增 `src/shadow.ts`（JSONL 追加 `$DSH_HOME/storages/advisor-group/classifier-shadow.jsonl`，问题截断 200 字符；`readShadowSamples` 只读统计）+ `GET /advisor-group/shadow`（token 鉴权：最近 200 条 + total/escalated/launched/avgConfidence）+ `tests/shadow.test.ts`（3 用例）；接入点：`ask_advisors` 每次**非强制**分类判定后 fire-and-forget 追加（纯观测，不改行为）。单测 **57/57**。**任务池全部完成**（0.1.2-rc.1 适配/卡片收敛/P0 安全四项/SecretField 官方化/settingsScope 评估/P1 四项/产物性两项）。
- **（未来观察项）**：积累足够影子样本后调优 `confidenceThreshold`（目前 0.6 无真实数据支撑）；如需正式"触发记录面板"再扩展 `GET /advisor-group/shadow` 前端展示。
- **2026-09-05 P1 第 3 批（占位/缺失模型校验——P1 清零）**：新增 `src/model-validation.ts`（`advisorsMissingModel`，纯函数）+ `tests/model-validation.test.ts`（2 用例）；`ask_advisors` 在任何顾问模型为空/纯空白时**快败返回** `{skipped:true, reason:'advisor-model-missing'}` + 列名提示（新增/追问两条路径均生效，位于 no-advisors 检查之后）；设置卡片模型输入框在该状态下**红框 + 「⚠️ 模型未配置，ask_advisors 将跳过整轮咨询」**提示。预设 defaultModels 清单为知识库近似值、非各平台实测——README 已知限制明确"用 获取模型列表 拉取权威清单"。单测 **54/54**。**P1 全部完成。**
- **2026-09-05 P1 第 2 批（双通道契约测试）**：新增 `tests/providers-direct-http.test.ts`（10 用例，本地 fake LLM server 于 127.0.0.1 随机端口）——OpenAI SSE（text+reasoning 增量与顺序/[DONE] 收尾）、**中途断流保留部分内容且不抛**（顺带修复：两处流式循环 `reader.read()` 原先无保护，断流即抛错丢内容；现断流=保留部分内容，仅 abort/超时传播）、空流（仅 [DONE]）、非 2xx 抛错且**不回显 API key**、Anthropic thinking+text delta、Gemini generateContent、非流式 callDirectHttp、**可配置超时**（timeoutMs=80ms 中止 800ms 慢响应）、坏 SSE 帧忽略、ctx-llm 适配器契约（provider/model/system/messages/signal 透传 + delta 聚合）。单测 **52/52**，typecheck/build 通过，已打包重装 + 重启。server fixture 仅在测试内，无对外端口。
- **2026-09-05 P1 第 1 批（超时可配置 + stopOnConsensus 处置）**：① 核实取消链路**已贯通**（`exec.signal`→service→ctx-llm/direct-http 各协议 fetch 均有 signal 透传；`stream-channel` 断连清理完备）——据此**刻意不做**「SSE 断连即取消」（会破坏刷新后完整结果，保留后台完成 + durable 重建，README 已记录决策）；② **超时可配置**：新增 `discussion.advisorTimeoutMs`（默认 120000，1000-600000），service 读取并透传两条通道，providers 全部改为 `withTimeout(timeoutMs ?? ADVISOR_CALL_TIMEOUT_MS, signal)`；③ **`stopOnConsensus` 已处置**：设置页复选框移除、schema 保留但标 deprecated（存量兼容），README/注意事项更新。42/42 单测、typecheck/build 通过。
- **2026-09-05 任务池第 1 项「settingsScope 通路迁移」完成（附工程结论）**：只读验证官方 `settingsScope`（bind → snapshot value/base/user/revision + `set/unset/mutate` path-ops）后确认——**全量迁移结构性不适用**：官方快照不携带服务端私有事实（`apiKeysByProvider` 历史/meta/诊断解析），官方卡片模式只覆盖顶层标量配置，redacted 快照无法承载"按供应商恢复/清除"语义（迁移即丢失已实现的协议）。因此执行**官方化增量**：① 发现并修复真实红线漏洞——`apiKeysByProvider` 未标 `role('secret')`，官方 `describe`/导出/同步面会原样泄出全部历史 key → 已补标（与 `apiKey` 同）；② 新增 `tests/settings-redact.test.ts` 5 个用例锁定红线契约（含数组索引路径、未设槽位、非 secret 字段保留）。单测 **42/42**。
- **2026-09-05 SecretField 收敛（规范迁移）**：废弃掩码回传协议——`sanitizeConfig` 不再返回任何 key 材料（`apiKey:''` + `apiKeyMetaByProvider`={configured,last4}）；`reconcileApiKeys` 改 SecretField 语义（留空=保留、明文=覆盖、`clearApiKey:true`=显式清除含存档、掩码回传仅防御保留、`clearApiKey`/`apiKeyMetaByProvider` 均不落盘）；schema 的 `apiKey` 已标 `role('secret')`、新增瞬态 `clearApiKey`；客户端**删除 keyMemory**，API Key 输入改「已配置 ••••last4 / 未配置」徽章 + 留空保持 + 清除按钮。行为收益：A→B→切回 A 的 key 显示与保存天然正确（服务端历史保证），表单不再接触任何 key 形态。单测 37/37（新增 2 个语义用例）。
- **2026-09-04 P0 安全清单执行（顾问群评审后）**：① 诊断端点 SSRF 加固——`assertSafeDiagnosticBase`（https-only/本机 loopback；https 下拒 IP 字面量与云元数据主机名）+ 三处 fetch `redirect:'error'`（DNS rebinding 记为已知边界）；② 每日护栏持久化——`$DSH_HOME/storages/advisor-group/daily-guard.json`（构造加载、串行原子写 tmp+rename、失败仅 warn），重启不再归零；③ 密钥卫生审计——全源码无任何 console/log key 泄漏（仅持久化失败一条 warn 无 key），README 增加明文 key 存储警告与安全说明；④ 事件注册隔离测试——新增 `tests/session-events-host.test.ts` 锁定 KNOWN mutation（Set 冻结即 fail-loud），devDeps 增加 `dsh-scope`。新增 7 个单测（SSRF 6 + 事件注册 1），共 **36/36**；typecheck/build/client-id 通过；已打包重装 + 重启。
- **2026-09-04 修复「切换供应商后测试连接 HTTP 401」（`新顾问 连接失败：HTTP 401`）**：诊断端点（models / test-connection）此前把客户端表单里的 apiKey 直接拿去打真实供应商，而切供应商后表单里只有掩码/空值 → 401。修复：客户端两个诊断 POST 改带 `advisorId`；服务端新增 `resolveDiagnosticApiKey`（按 advisor id + 当前 credential scope 解析：入参为掩码或空串时回退 `advisor.apiKey` / `apiKeysByProvider` 存档值，新键入明文永远优先）；新增 5 个单测（共 29 个）。不要回退该端点的直接透传行为。
- **2026-09-04 修复「供应商 A→B→切回 A 时 API KEY 消失」**：根因在客户端——切供应商时 `apiKey` 被置空且无按供应商记忆，切回后表单显示空白；若此时保存还会把「A+空key」发给服务端，服务端按同供应商主动清空处理（key 仍在 `apiKeysByProvider` 历史里，服务端留档/恢复逻辑本身正确，9 个 reconcile 单测覆盖）。修复：客户端新增 `keyMemory`（顾问×供应商→最后一次看到的掩码/键入值），reload/save 从服务端响应刷新，apiKey 输入框记录键入值，切供应商时回填记忆值（无则空串）；服务端只接受当前 scope 的掩码，跨供应商回传掩码走 history 恢复，安全性不变。
- **2026-09-04 设置卡片改为可收起/展开面板**：镜像官方 `settings.plugin.item` 卡片外壳（标题+描述+箭头、`aria-expanded`、「未保存」标记、放弃更改/保存设置底部栏），与内置「网页搜索 / Bash」卡片同层；因 client bundle 禁止跨插件 value import，外壳为自实现（同款 `--dsw-alias-*` CSS 变量）；已打包重装 web profile 并触发重启（安装后 bundle 哈希与构建产物一致）。
- **2026-09-04 适配 DSH 0.1.2-rc.1**（从 0.1.1-rc.2）：依赖范围全部升到 `>=0.1.2-rc.1 <0.2.0`；`dsh-client-runtime` 包在该版本已不存在，client 改为引用 `dsh-client-ui-conversation/client` + `dsh-client-ui-chat/client` + `dsh-client-ui-renderer/client` + `dsh-client-ui-settings-plugins/client`；节点注册 `ctx.conversationEvents.register` → `ctx.uiConversation.events.register`；设置卡片 `settings.plugins.tab` → keyed `settings.plugin.item`（key=命名空间）；host 的 `settingsNamespace()` 已删除（直接用命名空间字面量）、`Session.events` → `Session.snapshotEvents()`。typecheck / 24 单测 / build / client-id 双引号全部通过。
- `KNOWN_SESSION_EVENT_TYPES` mutation 是 rc workaround：0.1.2-rc.1 官方机制为 `SessionEvent.ignorable` 标记，但 `Session.append()` 仍未对插件开放该标记，故变异继续保持；关注后续官方注册面。
- `dsh-plugin-dev check` 有一个已知失败：client 子路径导入被 checker 误报为缺 peerDependency，实际 peerDependencies 已声明根包。
- **client bundle 禁止开 minify**：`minify: true` 会把 banner 的 `id: "..."` 压成反引号，导致 `dsh-startup-guard` 误判并自动禁用插件。构建后检查 `lib/client.js` 的 id 为双引号格式。
- Provider 预设中的默认模型清单需要在真实接入时按各平台最新模型修正。
- 直连 HTTP 兜底目前只做了最简协议，后续可补充流式、错误分类、超时。
- 讨论轮次目前是“每轮把全部历史发给顾问”，后续可做摘要压缩，避免上下文膨胀。
- `KNOWN_SESSION_EVENT_TYPES` mutation 是 rc workaround，后续关注官方注册面。
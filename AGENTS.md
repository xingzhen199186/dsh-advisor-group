# AGENTS.md — dsh-advisor-group

> 本文件供 AI agent 在本仓库工作时读取。**发布/上架完整流程**见 `I:\DSH\AGENTS.md` §5.8 与知识库 X `DSH 插件开发发布市场全流程.md`（`D:\X\X\16-DSH\开发指南和架构文档\`），此处只放本仓库结论与约定。

## 这是什么

- **DSH 插件**：主模型可调用 `ask_advisors` 召集多个专家顾问模型。一次调用自动跑满自动深挖流水线（驱动模型追问 → 顾问 A/B/C 接力 → 综合结论），SSE 真流式 + 复古 CRT 聊天组卡片（`📋行动·N → 💭思考·N → ⛭工具行 → 📄正文`），26 个供应商预设，可配置每日配额、停止/继续、顾问工具调用（`readonly`/`all`/`off`）。
- **发布现状**：npm `dsh-advisor-group@0.0.1`（latest，2026-09-06 发布）；GitHub 公开 `xingzhen199186/dsh-advisor-group`（topics：`dsh-plugin`/`dsh`/`deepseek-harness`/`cordis-plugin`/`agent-preset`/`dsh-skill`）；市场 PR：#358（1024 Store 已合并 ✅）、#4456（awesome-dsh-plugin）、#409（Dominic789654）、#4（hackerFish）——后三个 OPEN 等人工/CI。

## 开发

- 环境：Node `^22.19.0 || >=24.0.0`；包管理器 pnpm `11.7.0`（本机另存 `package-lock.json`）。
- 常用命令：
  ```sh
  npm install --legacy-peer-deps --no-audit --no-fund
  npm run typecheck      # tsc --noEmit
  npm test               # vitest run（20 文件 145+ 测试）
  npm run build          # tsdown → lib/index.mjs + lib/client.js + lib/index.d.mts；postbuild 校验 client id 双引号
  npm pack --dry-run     # 发布前审计：只应有 LICENSE/README×2/cordis.patch.yml/lib 三件/package.json
  ```
- ⚠️ **client bundle 禁止 `minify: true`**（破坏 `id: "dsh-advisor-group"` 双引号 → `dsh-startup-guard` 误判禁用）。
- 依赖红线：`@deepseek-ai/*` / DSH 宿主接口包**只进 `peerDependencies`**，`devDependencies` 放构建/测试；`dsh` 字段必须含 `bundle.patch: "./cordis.patch.yml"`（只有 `dsh.client` 不算可安装）。

## 本机安装与验收（web profile）

```powershell
dsh plugin --profile web remove dsh-advisor-group --config.minimum-release-age=0
dsh plugin --profile web add dsh-advisor-group --config.minimum-release-age=0   # npm latest = 0.0.1
schtasks /run /tn DSHWebRestart
```

- `--config.minimum-release-age=0` 仅当次命令一次性放行（pnpm v11 供应链冷静期），**勿持久改配置**。
- 冒烟：首页带 boot token 200 + `dsh-advisor-group/client.js` 注入 + `__ADVISOR_GROUP_TOKEN__`；无 token `/advisor-group/config` **401**；带注入 token **200** + `dailyGuard`。
- 改本地 `file:` tarball 重装时，`dsh plugin install` 只刷 lockfile 不解包，须 `remove` + `add ./x.tgz` 才生效。

## 发布与上架（速查）

1. **版本统一**：`package.json`/`package-lock.json`/`CHANGELOG.md` 同步 bump（semver；市场用 version 做更新检测）。
2. **GitHub**：仓库公开 + topics（至少 `dsh-plugin`）+ `repository/homepage/keywords`；审计无内部文档/凭据（`tasks/`、`*.tgz.bak-*` 不上传）；推 main + `v<x.y.z>` tag（本机 remote 用 `ssh://` 前缀）。
3. **npm**：`npm publish --tag latest`（版本低于 registry 已发布版本必须显式 `--tag`；2FA 浏览器授权或 `--otp`；不要用 `| Select-Object -First N` 截断，EPIPE 会中断发布）。
4. **市场**：`dsh-plugin` topic 自动收录（`dsh-plugin-marketplace` 2h / dshplugin.org / AdamPlatin123 8h）；人工提交见知识库全流程文档（1024 Store JSON / awesome-dsh-plugin YAML / Dominic 双 README / hackerFish YAML+≥10 commits / AdamPlatin 登记 / oa1mgo issue）。
5. **验证**：`gh pr view <n> --repo <market> --json state,mergedAt`；合并后拉上游 raw 文件实锤；`npm view dsh-advisor-group version dist-tags`。

## 仓库约定

- 与项目发布无关的本地文件**不提交**：`tasks/`、`dsh-advisor-group-*.tgz.bak-*`、`DELIVERY-EVIDENCE.md`。
- 提交前：`npm run typecheck` + `npm test` + `npm run build` 全绿。
- 版本/发布事件同步 Obsidian：`16-DSH\plugins\dsh-advisor-group\dsh-advisor-group.md` + `dsh-plugins 总览.md`（规则见 `I:\DSH\AGENTS.md` §3.4）。

# 仓库蓝图与生成顺序

> 规范性文档。生成器应按这里创建文件边界，再按其他规范填充实现。

## 1. 技术基线

- GitHub 仓库元数据必须包含 `dsh` 与 `dsh-plugin` 两个 Topics，对应产品约定中的 `#dsh` 与 `@dsh-plugin`；Topic 值本身不接受 `#` 或 `@` 前缀，便于 DSH 与 DSH Plugin 生态检索；
- 仓库及全部 workspace package 统一使用 BSD-3-Clause License；根目录必须保留标准三条款 `LICENSE` 文件，package manifest 的 `license` 必须为 `BSD-3-Clause`，README 许可链接与发布元数据必须一致，禁止回退到 MIT 或出现混合声明；第三方 MIT/Apache/LPPL 等材料仍按各自 notice 与义务单独保留。
- 根 README 必须给出当前未发布阶段从本地源码安装 Agent 插件到 DSH profile 的可执行命令、安装验证和卸载命令；registry 安装命令必须标记为发布后使用，不能暗示当前已经发布；
- 根 README 的产品介绍必须嵌入一张由当前 standalone 构建生成的中文首页截图；截图使用全新浏览器 profile、显式 `dsh.locale=zh`，不得包含访问 token、私密项目资料、调试覆盖层或伪造 UI，界面发生结构性变化后应重新采集；
- Node.js 24、TypeScript 5.9、pnpm 11、ESM；
- workspace：packages/*、workers/*、apps/*；
- Zod 3、Vitest、node:sqlite、原生 fetch/http；
- 完整科研浏览器 UI、BFF 与状态实现只有 standalone 一份，可以使用 React 或原生 DOM，但必须满足同一接口、i18n 和测试；DSH client half 提供配置卡及 Host 原生会话 `dsh Scholar` session workspace，完整 standalone 只在新页面启动，不嵌入或复制业务实现；
- Plugin config 可经 loopback-only、固定 `0600` 文件、零回显 seam 显式复制 standalone access token；Kernel、Runner、Provider、SSH 等其他 secret 永不可复制；
- browser bundle 使用 tsdown 输出 classic-script handoff；根配置卡使用 `dsh.client`，禁止 legacy `dshClient` 字段；
- 所有包 strict TypeScript，不使用 skipLibCheck 掩盖本项目错误。

## 2. 目标文件树

~~~text
dsh-scholar/
  apps/
    research-bff/
    research-standalone/
  packages/
    research-schemas/
    research-kernel/
    research-client/
    research-authz/
    research-cas/
    research-config/
    research-onboarding/
    workspace-runtime/
    trajectory-projection/
    scholar-connectors/
    dsh-research-plugin/
    dsh-research-ui/
    evidence-engine/
    manuscript-builder/
    release-bundle/
  workers/
    runner-gateway/
    analysis-worker/
    research-orchestrator/
    clean-room-verifier/
    remote-runner-agent/
  skills/
    research-core/
    domain-machine-learning/
    domain-data-science/
    venue-templates/
  plugins/research-core/.dsh-plugin/
  configs/
    research-web.cordis.yml
    research-headless.cordis.yml
    research-dev-selfmod.cordis.yml
    runner-profiles/
  migrations/
  tests/
    unit/
    contract/
    integration/
    security/
    recovery/
    ui/
    golden-path-v2/
  evals/
  scripts/
  docs/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.config.ts
~~~

现有仓库可以逐步迁移，不要求一次物理移动所有包；模块接口和依赖方向必须先收敛。

## 3. 包责任与依赖方向

| 包 | 负责 | 允许依赖 |
|---|---|---|
| research-schemas | Zod、类型、状态机常量、错误 code | zod |
| research-cas | Blob put/read/has/GC | Node fs/crypto |
| research-kernel | 业务事务与 projection | schemas、cas |
| research-client | HTTP/Binary/SSE adapter | schemas |
| research-authz | Principal、membership、policy | schemas |
| research-config | canonical Config Schema、layer resolver、SecretRef | schemas、authz |
| research-onboarding | intake/staging/scanner/grill/proposal/adoption | schemas、cas、config |
| workspace-runtime | 通用文件/CAS/revision/search/watch/snapshot | schemas、cas、authz |
| trajectory-projection | Outbox/Session safe projection、tree/history/SSE/redaction | schemas、client、authz |
| scholar-connectors | 外部论文 adapter | schemas |
| evidence-engine | Metric/RunSet/Analysis/Claim verify | schemas |
| manuscript-builder | Ledger→TeX workspace、review、diagnostics parser | schemas |
| release-bundle | 自包含 bundle layout/verify | schemas |
| dsh-research-plugin | DSH Agent 工具/命令/Skill、Session 关联 | client、connectors、authz |
| dsh-research-ui | standalone client/BFF/sidecar、i18n、Terminal、TeX UI | browser-safe schemas/client types、kernel executable |
| runner-gateway | snapshot materialize、Docker、terminal、sign | client、schemas |
| remote-runner-agent | mTLS、ExecutionPlan、CAS transfer、remote Docker/PTY、spool | client、schemas |
| analysis-worker | evidence-engine CLI/internal adapter | evidence-engine、client |
| orchestrator | durable actions/state planning | client、connectors |
| clean-room | bundle verify and rerun | client、release-bundle |
| apps/research-bff | 组装 Kernel client、AuthZ、standalone HTTP routes | client、authz、UI static assets |
| apps/research-standalone | loopback server、local Principal、sidecar、共享 UI | research-bff、UI、kernel executable |

Kernel 不依赖 DSH、UI、Runner 或 Connector。browser client 不导入 Node-only 模块。Worker 不导入 Kernel Store。dsh-research-plugin 不导入或托管 browser implementation；standalone app/BFF 负责唯一的浏览器运行时组装，不拥有业务逻辑。

## 4. 关键实现文件

### research-schemas

- project.ts：Brief、Project、Status、Transition；
- governance.ts：Gate、Decision、Principal；
- corpus.ts、idea.ts、experiment.ts、evidence.ts；
- artifact.ts、job.ts、terminal.ts、pty.ts、workspace.ts、config.ts、intake.ts、trajectory.ts、tex.ts、events.ts；
- ids.ts、errors.ts、index.ts。

### research-kernel

- kernel.ts：深模块外部接口；
- workspace-module.ts：Workspace/TeX 双 backend 的 project-scoped 解析、CAS 读写、搜索、历史与 snapshot 协调；Kernel 仅保留一行级 façade；
- runner-environment-readiness.ts：projection 与 submit 共用的 profile/target/SecretRef/heartbeat/capability readiness；
- sidecar-lifecycle.ts：插件与 standalone 共用的 sidecar 启停、身份握手、token、endpoint ownership；两端只保留默认目录/日志 adapter；
- store/schema.ts、store/migrations.ts、store/queries/*；
- transactions/*：Gate、complete、budget、Workspace/TeX save/build、Adoption、Config patch；
- server/router.ts、server/json.ts、server/artifact.ts、server/sse.ts；
- projections/*：Project/NextAction/Trajectory/Intake；
- bin/kernel.ts。

### dsh-research-ui

- client/app.tsx 或 app.ts：共享应用入口；
- client/pages/{start,chat,overview,workspace,approvals,runs,run-terminal,interactive-terminal,trajectory,artifacts,evidence,manuscript,budget,settings}；
- client/components/{NextActionCard,UploadIntake,GrillQuestions,FileExplorer,Editor,TerminalBlock,PtyTerminal,TrajectoryTree,TrajectoryTimeline,TexEditor,PdfPreview,Diagnostics,Modal,Toast}；
- client/i18n/{service,format,locales/*}；
- client/state/{api,preferences,streams}；
- standalone/server.ts、standalone/security.ts、standalone/sidecar.ts、standalone/bootstrap.ts；
- client.tsdown.config.ts。

不得再次形成单个 7,000+ 行 client 文件；页面模块只通过共享 state/interface 交互。ResearchKernel 新增 Workspace、Runner、sidecar 等领域行为时必须先落入对应深模块，Kernel class 只协调事务与稳定外部接口；禁止在 plugin/standalone 复制生命周期实现。

## 5. 根脚本

~~~json
{
  "build": "build all packages, workers, browser bundles and copied skills",
  "typecheck": "tsc -b or equivalent strict check",
  "test": "vitest unit and contract",
  "test:ui": "browser/jsdom + accessibility + i18n",
  "test:security": "blocking security suites",
  "test:dsh-private": "private-registry install + real DSH host lifecycle (manual/secret-gated)",
  "test:docker": "real container eval",
  "test:golden": "deterministic golden path",
  "test:all": "all blocking suites including TeX and clean-room",
  "verify:bundles": "client handoff and no innerHTML",
  "verify:skills": "prepared skill assets and installed package",
  "verify:docs": "links, fences, contract snapshots and docs-change policy"
}
~~~

build 先 schemas/cas，再 kernel/client/connectors/evidence/manuscript，后 workers/plugin/UI，最后 bundle/skill verification。禁止依赖未跟踪 lib 产物运行测试。

`test:security`、`test:docker`、`test:ui` 和 `test:all` 的聚合器必须区分 PASS/FAIL/SKIP。`CI=true` 时任何 SKIP、缺失依赖、断言数为 0 或子脚本未执行都必须使聚合器非零退出；只有本地非 CI 环境可以显式 `--allow-skip`，且结果不得计入 PASS 或 hardening 验收证据。

开发机不具备真实浏览器、DSH、Docker/TeX、远端主机/mTLS 或 GPU 时，不要求先搭建这些 CI 才能实现代码。生成器应先产出完整生产路径、可运行的本地验证和 `manual-acceptance.md` 对应场景，把真实环境结果标成 `NOT_RUN_MANUAL_PENDING`；待人工验收后再升级 hardening 状态。已经存在并实际运行的 CI 仍保持上述 fail-closed 语义。

## 6. 生成顺序

1. 建立 schemas 与错误 code；
2. 建立临时 SQLite/CAS 并实现 Kernel 深接口；
3. 建立 v2 HTTP、ResearchClient 和 contract tests；
4. 实现 Gate、Artifact、Job/lease/Manifest 事务；
5. 实现通用 Workspace、Config registry 和浏览器 upload；
6. 实现 Runner Fleet、Local/Remote Docker、Run Terminal 与 Interactive PTY；
7. 实现 Analysis/Evidence/Claim；
8. 实现 TeX document、实时 preview 与权威 build；
9. 实现 ResearchOnboarding、Grill Me、Adoption 与结构化 NextAction；
10. 实现 Orchestrator、Connectors 和 Release；
11. 实现不含浏览器面的 DSH Agent adapter、safe Session source 和 Skills；
12. 实现 Trajectory/Subagent projection 与 standalone BFF/UI/i18n；
13. 验证包 manifest 和路由不存在任何 DSH embedded UI 面；
14. 生成 security、recovery、remote/Docker/PTY、upload/onboarding、trajectory、TeX、Golden、clean-room 的自动化脚本或人工验收步骤；开发环境能运行的立即执行，真实环境不可用的登记 `NOT_RUN_MANUAL_PENDING`，后续交给人工执行。

每步先写对应接口验收，再实现。第 1–13 步和第 14 步的“场景/脚本生成”属于代码实现阶段；第 14 步的真实环境执行属于后续人工验收阶段，不阻塞继续开发。旧浅模块的测试在新深接口测试覆盖后删除，避免同时维护两套行为。

## 7. 开发协作与 subagent

开发默认尽可能并行使用 subagent：

- 跨目录检索、外围资料、测试日志、独立核验和无重叠文件实现应并发；
- 每个委派任务写清范围、问题、输出和 file:line 证据；
- 代码任务明确文件所有权，并声明不得回滚他人修改；
- 多个独立任务同一批派发，主代理等待结果后再合并判断；
- 基础架构文档和即将修改的具体代码由主代理完整阅读；
- 方案取舍、冲突解决、最终修改和全量验收归主代理；
- 子代理结论只做压缩线索，重要结论按提供的 file:line 抽查，不重复通读其全部范围。

一次 agent 任务应有界，异常长时间无结果要中止并拆小。并行不能成为减少测试或绕过代码所有权的理由。

## 8. 文档同步工作流

每个需求或修复分支必须包含：规范差异、实现、测试、hardening status。PR 模板检查：

- 哪个规范章节改变；
- Domain/HTTP/DB/UI/i18n 是否同步；
- 新增 acceptance 场景；
- 迁移和向后兼容；
- 安全影响；
- 当前差距是否关闭。

只改代码的变更不能合并。

## 9. Self-mod 开发配置

configs/research-dev-selfmod.cordis.yml 只插入 @deepseek-ai/dsh-tool-cordis，绝不并入根 cordis.patch。开发启动脚本要求显式环境确认，例如 DSH_SCHOLAR_ENABLE_SELFMOD=1，并打印高风险提示、profile、DSH_HOME 和 workspace。

实际包名必须是 @deepseek-ai/dsh-tool-cordis；cordis:tool-cordis 只在专门注册该 builtin 的 DSH 测试 scaffold 有效。源码仓库保留 dev overlay，但生产 npm files/发布 tarball 排除 configs/research-dev-selfmod.cordis.yml；开发者从源码使用 scripts/start-selfmod-dev.sh。

调试完成后把动态代码转换为普通插件源码、测试和文档；dyn-N 不是可交付产物。CI 对生产 dump-config 做否定断言，对开发 overlay 做 inspect/mount/unmount 冒烟。

## 10. 完成检查

- pnpm lockfile、构建和类型检查可从 clean checkout 运行；
- npm pack 或本地 package tarball 包含全部运行资产；
- 私有 `@deepseek-ai/*` 验收从临时 0600 userconfig 安装到全新 DSH_HOME，不使用 checkout/symlink/fake host/file override；无 credential 时明确登记 NOT_RUN_MANUAL_PENDING；
- 全新 DSH_HOME 安装成功，不依赖开发 symlink；
- production composition 无 tool-cordis；开发 overlay 可用且隔离；
- zh/en 资源完整，无 UI 硬编码；
- Terminal、TeX、PDF、binary proxy 和 SSE 在 standalone 模式完整验收；
- Init/Resume/Upload、Grill Me、NextAction、Workspace/PTY、远端 Runner、Settings、Trajectory/Subagent 拓扑在 standalone 模式完整验收；
- archived 项目可由 PI 经 exact-name 确认删除，UI/Kernel 重启后均不可见；tombstone/Outbox/retention 与共享 CAS 安全通过；
- 根插件的 browser export 仅含 Plugin config 卡片，且无 legacy dshClient/HTTP bridge；UI 包无 Cordis host/patch；
- docs/README.md 的所有文档链接和规范条目可达；
- hardening 状态没有未实现、部分或已实现未验收的 P0/P1；每个已验收条目绑定当前 commit、CI job 和 acceptance 报告；
- CI 所有 blocking jobs `skip_count=0`、实际断言数大于 0，缺 Docker/TeX/DSH fixture/git base 必须 fail closed；
- `verify-docs --diff-check` 使用已 fetch 的精确 base SHA，base 不可达时非零失败；
- README、USAGE、hardening、acceptance 与源码对当前能力无矛盾；
- Release Bundle 在删除 checkout/旧 DB/CAS、断网的空目录中只依赖 Bundle 与声明的固定 runtime 完成重跑、分析和 PDF 重建。

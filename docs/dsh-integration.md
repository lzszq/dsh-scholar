# DSH 宿主集成规范

> 规范性文档。目标宿主是 DeepSeek Harness 当前 Cordis 架构。

## 1. 包与前置条件

根包名为 @dsh-scholar/research-plugin，ESM，导出 Cordis Agent 插件，并通过 `./client` 与 `dsh.client` 提供 DSH Web 半侧。该半侧向 Settings → Plugin config 注入 Scholar 配置卡，并向会话 `conversation.view` 注册 `dsh Scholar` 页签；页签是 Host 原生的 session-focused 绑定/阶段视图，完整 standalone 只从新页面打开，不在 DSH 主区 iframe。宿主提供私有 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings` 以及 Host/Client 相关 DSH 包；这些 DeepSeek 包不假设存在于公共 npm registry。

当前安装与支持基线是 `@deepseek-ai/dsh@next`；每次安装都必须记录 tag 当时解析出的精确版本，本文更新时 `latest` 与 `next` 均解析为 DSH `0.1.1-rc.2`。唯一可编辑基线位于 `config/dsh-baseline.json`，由 `pnpm sync:dsh-baseline` 同步 root peer/dev 与 release-age exclusions，并由 `pnpm check:dsh-baseline` fail-closed 验证；禁止手工分散升级或用旧 Host 类型编译后再交给新 Host 运行。`settings.plugin.item` 在该基线是 keyed slot：Scholar 必须以其 Host Settings namespace `research-plugin` 注册 `options.key`，且不得再提交 list-slot 的 `id`/`order`。缺 key 必须由真实 DSH 启动验收捕获；只使用不执行 slot kind 校验的 mock 不能计为兼容性 PASS。2026-08-17 的 RC7、2026-08-20 的 RC8 与 2026-08-21 的 rc.1 记录仅作为历史回归证据保留，不能替代当前 `0.1.1-rc.2` 运行态验收。

常规安装先用 `npm install -g @deepseek-ai/dsh@next` 安装宿主，再在本仓库 build 后执行 `dsh plugin --profile web add /absolute/path/to/dsh-scholar`。开发环境可通过 DSH_SCHOLAR_DSH_ROOT 指向 DSH checkout，脚本只建立可恢复的 symlink；该源码路径只用于宿主开发和补充验证。生产运行由 DSH profile 的扁平 node_modules 提供同一 Cordis 实例，禁止打包第二份 Cordis。symlink/check-out 验证只用于开发反馈，不能计为当前 `@next` 精确版本的宿主兼容性 PASS。

## 2. Cordis 插件形状

~~~typescript
export const name = 'research-plugin'
export const inject = ['tools', 'commands', 'subagents', 'settings']
export const Config = z.object({ /* DSH host-visible Schemastery schema */ })
export async function apply(ctx, config) { /* effect-scoped registrations */ }
~~~

所有工具、命令、事件、Skill provider、settings 注册和 sidecar 生命周期都有 disposer。`Config` 通过 Cordis Standard Schema 在 `apply` 前完成默认值和类型校验；Scholar 的严格适配层额外拒绝未知 root/kernel/standalone key，避免拼写错误静默进入运行时。Host 半侧除可选的 connection RPC（loopback private settings/Token channel 与 trusted-host view channel）外不依赖 `httpServer`、slots、LocaleFace 或 ThemeFace；浏览器半侧依赖 DSH Client runtime、connection、locale、settings、plugin-config 与 conversation slot。全局可变 toolContextRef 禁止；每个插件实例使用闭包保存 Client、RoleRegistry、Tenant 和 cache。

## 3. 目标配置

以下是 v2 生成目标。当前兼容层已把 v0.1 的 `kernel.host/port/dataDir/token`、`defaultMode`、`unattended`、`models`、`cacheDir` 以及 `standalone.url/shortcut` 暴露为 DSH 可发现的运行时 Schemastery schema：空配置生成 loopback/7412、gate-only、非 unattended、空 model map、`http://127.0.0.1:18610/` 与 `Alt+Shift+S`；端口、URL、快捷键和类型在 `apply` 前校验，token 标记为 secret，未知字段拒绝。插件在 `research-plugin` namespace 下注册该 schema作为 Host 内部持久化权威；浏览器卡片不依赖或修改 DSH 的 settings allowlist，而是通过 Scholar 自有 loopback-only connection RPC 读取仅含 `defaultMode`、`unattended`、`standalone` 的脱敏投影，并以 revision-fenced path mutation 写回。Settings → Plugin config 的卡片保存后在下一次 DSH 重启生效。`defaultMode` 已接入 `research_project create` 与 `/new`，显式调用参数仍优先；`full-auto` 继续要求注册 FixtureProfile。下列 skills/onboarding/trajectory/runner/config 字段仍是 v2 目标，差距记录在 hardening-v0.2-status.md。

~~~yaml
kernel:
  host: 127.0.0.1
  port: 7412
  dataDir: null
  tokenFile: null
  requireSignedManifest: true
  startSidecar: true
defaultMode: gate-only
unattended: false
subagents:
  enabled: false
  provider: spawn
  maxConcurrency: 4
  maxFanoutPerAction: 6
  maxDepth: 1
  timeoutMs: 300000
  maxOutputBytes: 131072
skills:
  includeCore: true
  includeDomains: [machine-learning, data-science]
  includeVenues: true
onboarding:
  enabled: true
  maxIntakeBytes: 2147483648
trajectory:
  publishSafeSessionProjection: true
  rawDetail: false
runner:
  defaultProfileId: local-docker-cpu
config:
  source: canonical-registry
~~~

该 YAML 只是 Config Schema 的 instance layer；所有字段必须从 canonical registry 生成，未知字段拒绝。Project/Workspace/Session/Target overrides 由 Kernel ConfigDocument 管理，插件不能另建一套 merge/default。Secret 只写 SecretRef。

port=0 必须通过 sidecar handshake 回填，不能把 0 当作客户端 endpoint。Agent 与 headless profile 使用相同 Kernel 数据规则；不同 DSH_HOME 必须得到不同 dataDir。

## 4. 工具注册

使用 ctx.tools.register(defineTool(...))，parameters 和 output 都给精确 JSON Schema，additionalProperties 明确声明。render 返回结构化 ContentBlock 或安全的工具卡意图。

工具组：

| 角色 | 工具 |
|---|---|
| DSH 会话公共受控入口 | dsh_scholar |
| DSH 会话方法论入口 | research_methodology_status、research_protocol_record、research_synthesis_record、research_writing_review_record、research_knowledge_activate |
| director | research_project、research_phase、research_gate_request、research_budget、research_status |
| intake | research_intake_begin、research_intake_stage、research_intake_scan、research_intake_answers、research_intake_propose（prepare-only，不提供 adopt） |
| scholar/curator | literature_search、paper_resolve、corpus_snapshot、passage_lookup |
| panel | research_panel、idea_create、idea_compare、novelty_audit |
| engineer | workspace_snapshot、patch_apply、baseline_prepare、test_run、baseline_verify |
| architect/operator | experiment_register、experiment_submit、experiment_status、experiment_cancel |
| statistician | evidence_note_create、claim_create、claim_verify_request、analysis_request |
| writer/reviewer | manuscript_build、manuscript_review、release_bundle_request |

Canonical catalog 固定为 42 个可调用工具名。Unknown/root role 不是空集合：只允许 `dsh_scholar` 与上述七个 exact-session methodology tools；其余普通 Research tools 继续 deny。tools/pre-execute waterfall 对未授权工具返回 deny；允许时必须调用 next()。`dsh_scholar` 只接受有界 `text`、可选 `project_name`、可选 `project_id` 与 `locale`，默认从 `exec.agent.id` 解析当前 DSH session link；session id 只允许安全 opaque-id 字符并在 ResearchClient 中编码成一个 URL segment。`project_name` 只在 session 尚未关联、用户原文是整句肯定创建指令、且字段等于确定性语法从命令后缀解析出的完整名称时启用 name-only Init；只取名称子串、疑问、否定/取消/避免、主题讨论、模型补写/改写名称、名称不一致或已有 link 均不得创建。否定/疑问词只作用于命令结构，合法名称中的“风险”“方法”“类别”或英文 `What` 不应被误拒。它返回精确、封闭的脱敏阶段投影和受控动作结果，不授予任何低层 Research role capability。七个 methodology tools 必须从调用 DSH session 精确解析持久 project link，不接受任意 `project_id`；`research_knowledge_activate` 只接收 package identity 与 CAS，Host confirmation 后由 Kernel 派生 session/project/PI/phase/NextAction/policy/capability；`research_assurance_run` 的 semantic reviewer identity 只从 durable child topology 派生。DSH 当前 Tool schema DSL 不表达 string min/max，故 `text` 的 1–4000 和 `project_name` 的 1–120 长度由运行时再次强制；其余 input/output 字段、enum、对象开放性必须在 schema 中精确声明。Human Gate Decision、accepted Evidence 写入和任意宿主 shell 不注册为 Agent Tool。

## 5. 命令

命令直接注册为一级 slash command：`/help`、`/new`、`/list`、`/status`、`/survey`、`/ideas`、`/gates`、`/jobs`、`/reproduce`、`/contract`、`/run`、`/evidence`、`/claims`、`/write`、`/review`、`/release-bundle`、`/release`。DSH Web 保留 `/export` 用于下载 Session 日志，因此 Scholar 用 `/release-bundle` 生成私有 Release Bundle。DSH Command Registry 与 standalone parser 都不注册、不解析或兼容旧聚合前缀；帮助、补全、descriptor、文档与新审计 provenance 一律使用直接命令。

`/new <name> [<brief-json>]` 是 name-only Init 引导入口，只有 `name` 必填；`brief-json` 省略时通过 DSH internal create+link 事务直接创建 `DRAFT/collecting` 空项目与 Init Intake，不得创建 Scope Gate，也不得返回 Brief 缺失错误。DSH `parseCommand()` 会在 `rawInput` 中保留命令名后的分隔空白，Scholar command adapter 必须在自身语法边界归一化该空白，并以真实的 `rawInput=" <name>"` 形状做回归测试。命令成功后，`dsh Scholar` 页签的 Host-owned session workspace 必须在下一次可见态轮询（最长 4 秒）显示同一 project id/name/status/brief status；该确认不得依赖 standalone 页面。Grill 回答与 PI `/confirm-brief` 目前属于 authenticated standalone Human Chat/BFF 面，不冒充 Agent command。Agent Intake tool 只操作 observation/question/proposal，不提供 accept/adopt/merge-confirm 或任何 Gate Decision，最终 Adoption 与 Brief confirm 只能由 Human PI 完成。

自然语言 Chat 是 project-scoped turn adapter，不新增 `/research` 聚合 descriptor，也不改变上述 direct command Registry。Standalone composer 接受任意普通文本并根据当前 Kernel projection 返回阶段感知回答；普通讨论经 plugin-owned private loopback bridge 使用当前 DSH `llm` service，模型不可用时保留确定性阶段引导。状态/已有想法/Gate/Jobs/Claims 等只读意图执行 canonical operation，用户明确要求且权威 NextAction ready 的 `/ideas generate <1-5>`、无参数 `/write`、`/review`、`/release-bundle` 可直接执行，ready survey 还必须带明确 query。Idea generation 另要求最新非空 frozen corpus，模型只产严格草稿，BFF/Kernel 以 revision CAS + 单事务附加 identity/provenance；失败零部分写，且不选择或批准 Idea。实验、复现或其他参数不完整写动作只返回可编辑 direct command。blocked、歧义、权限不足与 Human-only 决策零写；对话执行后重新读取 projection 并给出下一步，不得退化成 slash-only 或 `Unknown command`。

DSH 本体 Chat 与 standalone Chat 是两条不同但语义一致的自然语言入口。Harness Agent 识别项目研究意图后调用 `dsh_scholar({ text: 用户原文 })`；当未关联且用户以肯定句明确创建并在本次原文给出名称时，同时传确定性语法解析出的完整 `project_name`。工具从调用方 session 精确解析项目并读取 Kernel `projectProjection`，返回 `intent`、`execution`、`project`、`stages`、`next_action` 和本地化 `assistant_text`。未关联 + 明确创建 + 原文完整同名经 Kernel bearer、共享 service token 与仅 DSH plugin 持有的专用 token 三重受控 internal route 原子完成 name-only `DRAFT/collecting` Project、active Init Intake、PI membership 与当前 DSH session link；自报 `dsh-plugin` header 不构成身份。确定性 idempotency key 配合由专用 plugin token 签出的 route/session/name HMAC 防止模型/网络重试和 public v2 row 双向碰撞；事务检查原始 link 行，活动、墓碑、悬空或竞争 link 均 409，绝不 upsert 改绑。只有肯定创建意图但名称不明确时返回 `needs_project` 并直接追问名称，用户不必先打开 standalone Scholar 页面或先学 slash；带逗号/分号的后续否定、取消、停止或避免子句视为歧义并零写。创建 fetch、响应头或成功响应体读取/解析丢失、超时或 abort 时使用同一 key 的 replay-only internal 请求取回已提交回执，再以无 caller signal 的 link/projection 复核；不存在回执时零写并保留原错误，不能仅凭同名 collecting 项目回显成功。状态/下一步/Gate/Job/Idea 查询只读；只有锚定正向动作词的创建和“开始/继续/执行调研”可触发自动写，否定、主题讨论和歧义输入零写。调研执行前再次核对 `survey_run/ready/agent` 和 revision，并以 expected revision 调用与 `/survey` 相同的 canonical Kernel Corpus Snapshot primitive；native 入口额外施加 ready/CAS 策略。其他写动作返回建议并引导打开完整 Scholar；其中 IdeaCard 实际生成在 standalone Chat 通过 `/ideas generate <1-5>` 完成，不能把 native 的只读 `/ideas` 列表回答当成生成成功。显式 `project_id` 必须与当前 session link 一致，否则 fail closed；不得借此跨项目操作。

命令只是 ResearchClient adapter，不重复业务逻辑。它使用 invocation.agent.id 解析 session link。错误输出 research: 加稳定错误摘要，不能泄漏内部路径、Token 或上游响应。帮助文本与 i18n 资源生成；宿主命令描述若在注册时固化语言，locale change 时重新注册或保持语言无关。

本地开发可运行 `scripts/link-dsh-deps.sh` 解析当前 DSH checkout；脚本必须链接 `@deepseek-ai/*`（包括当前 DSH 的 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 与设置 provider）与 vendored `@cordisjs/*`/`cosmokit`，并且只替换因 DSH 包目录重组产生的 dangling symlink，不覆盖仍有效的链接或真实安装包。当前 Harness checkout 的文件设置 provider canonical 包名是 `@deepseek-ai/dsh-settings-file`；宿主生命周期夹具必须跟随 checkout 的 canonical provider，不得继续依赖已经移除的 `@deepseek-ai/dsh-settings-local`。该链接只用于本地 typecheck 与 checkout 夹具反馈，不能作为 DSH 发布兼容性 PASS；发布兼容性仍必须由 `tests/integration/run-dsh-private-registry-tests.sh` 在全新目录和全新 DSH_HOME 中安装固定私有 `@deepseek-ai/*` 包验证。

每个发布 Skill 的 YAML frontmatter 必须能被当前私有 `dsh-skill-filesystem` 严格解析；含 `: ` 等 YAML 指示符的 description 必须引用。兼容测试必须从 `ctx.skills.list()` 公共接口核对四个 Skill，而不能读取内部 provider collection。

## 6. DSH Session 与事件

DSH SessionEventMap 可通过 TypeScript declaration merge 扩展。插件可以追加展示事件并调用 session flush，但科研业务审计仍以 Kernel Outbox 为权威。

推荐 Session 事件只保存关联：project_id、kernel_event_id、gate_id/job_id/build_id 和安全摘要。原始 TerminalLog、Artifact 字节和 TeX 文件不复制进 Session 日志。Tool call/result 使用 DSH presentation metadata 生成可回放终端卡和 Artifact link。

DSH browser half 通过 trusted-host `/dsh-scholar-view` Connection RPC 的 `session-workspace` 读取当前页签 `session_id` 对应的精简工作区。已关联响应只含项目 id/name/status/revision/brief status、阶段 id/state、主要 NextAction 安全字段及 Gate/Job/内容计数；未关联响应只含稳定 DSH 操作员有权访问的项目摘要。`session-bind` 显式绑定已有项目，`session-create` 创建 name-only 项目并绑定；归档和跨操作员项目拒绝，已有不同 link 绝不改绑。三个 handler 都不认领 settings/token endpoint。Host 在 projection/列表前后读取 session link，稳定一致才返回，否则重试后 fail closed。客户端首屏读取并在可见时至多每 4 秒串行刷新，session 改变或页签卸载必须把 AbortSignal 贯通到 ResearchClient fetch 并 abort 旧传输/写入且清除 busy；wire validator 对 root/project/stage/NextAction/summary/jobs/options 使用精确字段 allowlist，畸形/额外字段响应 fail closed。阶段块显示本地化 label + 可见 state，current/blocked 项使用 `aria-current=step`，NextAction 显示 label/reason。该 RPC 面向同一受信 DSH deployment 的 UI，不替代 Kernel ACL；完整 standalone 只通过新页面打开并继续使用共享 Kernel。

独立 UI 的 Session Trajectory 由 `SafeSessionTrajectoryAdapter` 提供：输出稳定 session/node/parent/mode/status/timing/四桶 token/安全 tool summary 与业务 refs，默认删除 prompt、raw tool args/result、provider payload、cwd/env/secret。Kernel Outbox 另行生成 Research Trajectory；两者不能互相覆盖。

## 7. 子代理与 Durable Orchestrator

ctx.subagents 用于短周期文献、Idea 和 Reviewer Panel。长实验、等待 Gate、崩溃恢复不依赖活跃子代理或聊天上下文；由 Durable Orchestrator 和 Kernel projection 管理。

research_panel 必须：

- 默认关闭；启用后每次调用先经过 DSH Host `ask`，模型不能用输入布尔值冒充用户确认；
- 使用有界 perspectives 数量和 completion；
- Promise.allSettled 保留部分成功和失败；
- 将 API/模型用量写预算；
- 外部文本保持 untrusted；
- 返回结构化面板结果而不是让子代理直接写权威状态。
- child session 绑定固定 project scope，显式 foreign project/job id 在 `tools/pre-execute` fail closed；timeout/cancel 优先于延迟 completed，terminal update 与 dispose 并行有界；stale fan-in 丢弃 structured members。

当前预算只在已启动 child 完成后记录 `api_requests`；DSH 公共 SubagentResult 未提供可信四桶 token/cost，Kernel 也尚无 panel 原子 reserve/reconcile，所以这一轮不能宣称预算闭环或崩溃恢复。进程内同 action 只允许一个 panel、同 idempotency key 稳定 replay 只是 fail-closed 临时边界，不替代 durable ledger。

每次 `ctx.subagents.start` 保存 exact parent session、child session、role/kind、one-shot/continuable、created_at 与 safe refs。standalone Topology 只通过 BFF adapter 列 direct children、分页读取 cold history，读取不得激活 Agent；进入 child 使用 parent+child+mode address 和 breadcrumb。continuable follow-up 必须由服务端重新验证 exact live parent、项目 membership 和 capability；首版浏览器不提供 spawn/stop/cancel。

DSH Web 的 trajectory/subagent React plugin、slot、SessionHistoryFace 和 localStorage 不能直接打包到 Scholar。只可移植纯折叠、树、时间线、virtual row 和 ARIA 语义，接口以 trajectory-subagents.md 为准。

## 8. Skill 发现与打包

提供四个源 Skill：skills/research-core/SKILL.md、skills/domain-machine-learning/SKILL.md、skills/domain-data-science/SKILL.md、skills/venue-templates/SKILL.md。每个文件有合法 YAML frontmatter name 和 description，name 使用 kebab-case。静态插件 manifest 位于 plugins/research-core/.dsh-plugin/package.json。

构建要求：

1. 主插件运行时以 package URL 解析发布包内 skills，而不是假设 lib/skills 自动存在；
2. build 明确复制或生成 runtime skill assets，并有测试验证安装包内容；
3. SkillFilesystem providerName 唯一，includeDefaultRoots=false，customSkillDirs 显式，watch=false；
4. domain 和 venue skill 都要注册，不能只挂 research-core；
5. 静态 GitHub repository plugin 的 dsh.skills 列表包含全部需要发布的 roots；
6. .dsh-plugin/package.json 声明 prepare 所需的 dsh-repository-plugin 开发依赖；
7. generated dsh-plugin.mjs 和 assets 在发布包中存在，源码副本一致性有测试。

Domain/venue 选择必须由项目 brief.domain 和 target_venue 产生确定性 Skill 注入；不能只写在 Skill 正文期待模型自行发现。

## 9. 独立 Web UI

`@dsh-scholar/research-ui` 只发布独立 HTTP server、browser client bundle 和可执行入口。包不得声明 Cordis host export、`dsh.bundle.patch` 或 `dshClient`。根插件的 browser half 可以注册 DSH `conversation.view`，但 renderer 只能显示 Host 原生的 session workspace 并在新页面启动独立 URL，不能嵌入完整 UI；standalone 客户端仍只通过同源 BFF 读写 Kernel，不存在 DSH boot token fallback。

## 10. i18n 集成

独立 UI 内置 locale adapter，接口为 bind(namespace)、getSnapshot、subscribe、setLocale。选择顺序：有效 localStorage dsh.locale、navigator.languages、navigator.language、zh。支持 zh 和 en；存储故障不阻断启动。namespace lookup 顺序是 active locale、zh fallback、common active/zh、原 key。资源和完整规则见 gui-plugin-plan.md。

## 11. Standalone BFF

独立 HTTP server 在同源下提供 `/v2`、`/bff/research` 和迁移期 `/v1`。BFF 验证 bearer/Principal、same-origin、CSRF、Project AuthZ、限流和 body cap。Artifact 与 SSE 必须流式转发；不能对 upstream 调用 text() 后再返回二进制。`/research-api` 和 `/research-ui-api` 必须不存在。

## 12. Composition 与安装

根 package 的 dsh.bundle.patch 只插入 Agent `research-plugin` 行；根 manifest 另声明 `dsh.client` 与 `./client`，由 DSH Web 模块宿主加载配置卡和 `conversation.view` 页签。页签通过 trusted-host RPC 显示 session workspace，并只以新页面启动 standalone，不插入第二个 BFF 或业务状态层。standalone UI 独立管理 loopback server、BFF Token 与 BFF dataDir，但 Kernel sidecar 默认复用插件的 `127.0.0.1:7412` 与 `~/.dsh/research-kernel`；复用前仍须通过 endpoint identity 校验。只有一个 sidecar 实际拥有 Kernel 子进程，另一个必须 identity-verified reuse，禁止并发打开第二个业务数据库。

Plugin config 编辑 `standalone.url` 与 `standalone.shortcut`，并提供显式“复制 standalone 访问 Token”。Host 通过 connection generic RPC 注册固定 `/dsh-scholar` channel，authority 必须是 loopback；`settings-snapshot` 只投影三个浏览器拥有的配置字段，`settings-mutate` 只接受这三个字段的 set/unset 并携带 expected revision，二者都不暴露 `kernel`、`models`、`cacheDir` 或任何 secret。`standalone-token` handler 只读取 `DSH_SCHOLAR_STANDALONE_DATA`（或默认 standalone dataDir）下固定文件名，不接受浏览器路径。浏览器只在用户动作中把成功响应直接交给 Clipboard API，随后丢弃；不能把该能力泛化为读取 `kernel.token`、service token、Provider SecretRef 或任意宿主文件。

Scholar 包尚未发布时，当前可用的用户安装路径是从本地 checkout 构建后加入 DSH profile：

~~~bash
source ~/.bashrc # 仅当 NPM_TOKEN 配置在这里
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile web add "$PWD"
dsh plugin --profile web why @dsh-scholar/research-plugin
dsh web
~~~

更新时重新 build 并执行同一 add；卸载使用 `dsh plugin --profile web remove @dsh-scholar/research-plugin`。`dsh plugin --profile web add @dsh-scholar/research-plugin` 只在包已发布且当前 registry 可解析后才是有效的用户安装路径。源码安装允许开发期链接当前 checkout；下文兼容性 PASS 仍必须使用 build + pack 后的 tgz 和空 profile，不能用该链接替代。

静态 repository plugin 只承载 Skills/MCP，不能替代完整代码 bundle。安装验收必须使用全新 DSH_HOME 和远程或打包产物，不能只验证本地 symlink。

私有宿主兼容性测试通过 `tests/integration/run-dsh-private-registry-tests.sh` 触发，固定输入为 `DSH_PRIVATE_REGISTRY_URL`、`DSH_PRIVATE_REGISTRY_TOKEN`（可显式选择受控的 `NPM_TOKEN` fallback）、精确版本 `DSH_PRIVATE_DSH_SPEC` 和已发布/可安装的精确 `DSH_SCHOLAR_PLUGIN_SPEC`；token 只写入权限 0600 的临时 npm userconfig，禁止进入仓库、命令行、日志或测试报告。测试必须在空目录安装真实私有 `@deepseek-ai/dsh` 及其 host 包，再经公开 `dsh plugin --profile … add`、profile boot/dump-config、Cordis apply/dispose 观察 Scholar。未提供私有 registry/credential/Scholar 安装 spec 的开发机输出 `NOT_RUN_MANUAL_PENDING`，不能计 PASS；真实 CI/人工执行一旦开始则缺包、版本漂移、symlink、checkout realpath 或生命周期失败必须非零退出。

## 13. 开发模式的 Cordis self-referential 工具

DSH 的 @deepseek-ai/dsh-tool-cordis 提供 cordis_inspect、cordis_mount、cordis_unmount。它可在运行进程内检查服务、插件、工具、临时插件、接口和事件；执行一段临时代码挂载 dyn-N Cordis 插件；并等待 quiescence 后卸载该临时插件。

该能力只能通过显式开发 overlay 启用。dsh web --dev 只代表前端 HMR，不得隐式开启 self-referential 工具。

推荐新增 configs/research-dev-selfmod.cordis.yml：

~~~yaml
- insert:
    - id: tool-cordis
      name: '@deepseek-ai/dsh-tool-cordis'
      config:
        vmTimeoutMs: 5000
~~~

启动必须同时满足：

- 独立 DSH_HOME 和测试数据库；
- loopback Web；
- 人工交互、approval=ask；
- 非 unattended、非 production、非 shared team profile；
- 不注入 bash、fs、web、Kernel internal client、Runner key 等高风险服务，除非当前调试任务明确需要且再次审批；
- 每次 mount/unmount 保留 DSH tool/call、tool/result 和 dyn id 审计；
- 重启不恢复临时插件，重要修改必须转成普通源码、配置和文档变更。

cordis_mount 的 node:vm 和 Context façade 不是安全边界；同步 vmTimeoutMs 不限制所有异步行为。它应按 bash 等级管理。动态 plugin 启动失败必须 dispose；重复工具/服务冲突不得破坏旧注册；provider unmount 后 consumer 回到 pending；父 fiber、HMR 或退出必须级联清理。

生产 research-web、research-headless、根 cordis.patch 和发布包必须没有 tool-cordis 行。CI 同时验证开发 overlay 可 inspect→mount harmless dev_probe→下一轮调用→unmount，以及生产 composition 中三个 cordis_* 工具均不存在。

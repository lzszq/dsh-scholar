# 产品规范

> 规范性文档。实现、UI 文案和验收不得与本文件冲突。

## 1. 产品定位

DSH Scholar 面向需要可追溯、可恢复、可人工治理的纯计算研究项目。它不是“替用户自动发表论文”的机器人，而是一套把研究问题、论文证据、代码、实验合同、运行记录、统计结论、TeX 稿件和复现包连成一条审计链的科研工作台。

产品正式名称是 `DSH Scholar`；Web UI 的组合字标统一显示为 `dsh Scholar`。顶部栏、侧边栏、独立解锁页、浏览器标题、Chat 欢迎语/导出标题、设置卡片与命令帮助不得再显示 `dsh Research`、`DSH Research` 或以 `dsh` + `Research` 分段拼出旧品牌。`Research Kernel`、Research/Session lane、API 路径和科研动作中的 `research` 是领域或技术名称，不得因品牌替换而改名。

支持领域以机器学习、数据科学、生物信息学等纯计算研究为主。涉及临床决策、人体试验、湿实验、武器、生物安全或其他高风险领域时，系统必须停止自动推进并要求独立政策扩展。

## 2. 用户与职责

| 用户 | 主要目标 | 可以做 | 不可以做 |
|---|---|---|---|
| Human PI | 定义范围、承担预算和发布责任 | 决定 Gate、取消任务、批准预算、导出与发布 | 绕过 Kernel 不变量 |
| Researcher | 调研、查看、编辑、运行和解释 | 创建草稿、编辑 TeX、查看终端和证据 | 冒充 PI、直接写 accepted Evidence |
| Operator | 运行计算基础设施 | 提交、观察、取消符合合同的 Job | 改写 Manifest 或研究结论 |
| Auditor | 检查证据、引用、安全与复现 | 读取全链路并提出问题 | 修改原始 Run 和 Evidence |
| DSH Agent | 执行受控科研动作 | 提议、检索、生成 Patch、请求 Gate | 决定 Gate、宿主正式执行、公开发布 |

## 3. 产品模式

### 3.1 gate-only

默认且唯一可用于真实项目的模式。系统在 Scope、Idea、Contract、Budget 和 Release Gate 暂停，等待认证人类决定。Gate 期间不得占用模型会话或保留易失进程状态。

### 3.2 full-auto

只允许 fixture-only 配置。可用于 CI、演示和确定性 Golden Path，不得接触真实凭据、私有数据或公开发布入口。界面必须持续显示 fixture 标识，并明确写作“自动审批（Fixture-only，Release 保持人工）”；`defaultMode` 保存后须显示“重启生效”，不能让保存态伪装成当前运行态。

`full-auto` 的权威含义首先是由 Durable Orchestrator 自动批准精确 allowlist 内的 `scope|idea|contract|budget` Gate；普通 Agent 动作只有在登记 canonical executor 后才可能自动执行，当前唯一登记的 executor 是 `survey_run`。它不是 Human Principal，也不得调用/复用 Human BFF：Orchestrator 只能携 Kernel bearer、独立 service token、固定 `research-orchestrator` service identity 和幂等键调用专用 internal endpoint；Kernel 必须在一个事务内重新读取 Project、pending Gate、Gate payload、project revision、registered FixtureProfile、explicit RunnerProfile/Target 与 target object。Idea/Contract Gate 在创建时必须把 target id、version 与 canonical sha256 一并固定进 Gate payload，审批时与当前权威对象逐项复核；不能只凭可复用 id 自动批准。Kernel 据此派生 `full_auto_service` authority receipt，并原子写 Decision、receipt/audit、Gate、Project transition 和 Outbox。receipt 至少固定 project/gate/type、payload hash、expected/current project revision、target id/version/hash、fixture id/profile hash、runner profile id/config hash、runner target id/revision/config hash和请求幂等键。任一 pin、payload、project、revision、profile、target 或权限不匹配必须零写 fail closed；相同 key+相同请求重放返回同一 receipt，不同请求稳定冲突。

自动 Gate allowlist 固定为 Scope、Idea、Contract 和 Budget；Idea 必须绑定同项目、已完成 novelty audit 且版本精确的 IdeaCard，Contract 必须绑定同项目、版本精确的 draft Contract，Budget 只能使用 Gate payload 内由 Kernel 生成的 resume target。Release 永不自动批准，因为所有 FixtureProfile 强制 `automatic_release=false`；Direction、Brief confirm、Intake adoption、Evidence acceptance、Assurance acceptance、Knowledge activation 与任何未列出的治理动作也保持人工。Agent action 只有同时满足权威 `next_actions_v2` 中 `state=ready`、`required_by=agent`、`required=true`、显式 executor allowlist 与完整参数时才可执行；预算、Protocol、Runner、Secret 或参数缺口必须 park。unsupported/缺 executor 必须记录 typed gap，不得伪造成功、猜参数、自动降级或自动 Release。

`survey_run` 的查询只能从权威、完整的 `Brief.problem` 取得，不能由 Agent 猜测或覆盖；插件托管既有多源 connector/cache。Connector I/O 前，Orchestrator 必须通过同一 service-only surface 取得严格的只读 authority context；其 hash 固定 project/NextAction id+revision+hash、Brief query+hash、fixture/profile、Runner profile/target、budget 与 latest frozen Protocol，并进入 durable Action idempotency key。Mutation endpoint 只接收该 expected authority hash 和严格结构化且仍不可信的检索结果；Kernel 在同一事务中重新推导 context，hash 不同即零写 `full_auto_survey_authority_changed`，相同才把 result hash 一并写入冻结 Corpus Snapshot、authority receipt event、Project transition 和 Outbox。检索期间任一 pin 变化必须零语料写并 typed park；提交后崩溃重启必须从 receipt 恢复，不得重复调用 connector。

Durable Orchestrator 是唯一自动推进状态机：继续复用 project lease 和 append-only Action store，以 project/action/gate/revision/pins 构造幂等键，Kernel write 前先落 `running`，崩溃后恢复并与 Kernel receipt/projection 对账。每个成功的 Gate/action 后必须重读权威 projection，并在单项目单轮最多 8 步的有界循环内继续；因此 Scope 自动审批可立即进入 `survey_run`，再按新的 NextAction 前进或以 typed unsupported/gap park，不能依赖旧 projection、无限自旋或伪造后续成功。插件只在 Kernel identity/health 校验通过后启动它，并在插件 dispose 时停止、释放 lease 和关闭 store；Settings 必须显示 worker 当前运行状态、fixture-only 边界、待重启状态与最近 park 原因。只有名称的 `/new <name>` 始终创建 `gate-only DRAFT/collecting` 并进入 Grill；只有显式提供 registered fixture、explicit runner profile/target 和完整 Brief 的创建才可继承 `defaultMode=full-auto`，不得因默认值制造必然失败的半配置项目。

## 4. 端到端用户旅程

1. 未选择项目时，用户从 Init、Resume、Upload 三入口开始。Init 首次只填写项目名并创建 `DRAFT/brief_status=collecting` 项目；Resume 回到已有权威状态；Upload 把外部研究先放入隔离 Intake。
2. Init 在项目 Chat 中通过 Grill Me 每轮收集一个问题，允许先批量上传材料并由 OCR/parser 提供带来源候选；当前问题必须作为 assistant 对话回合显示并复用页面唯一的 Chat composer 作答，禁止在 composer 上方或旁边再创建独立 Brief textarea/提交表单。跳过、暂时未知和 PI 确认可作为问题回合内的明确动作。PI 确认完整 Brief 后才创建唯一 Scope Gate。Upload 经静态扫描和 Grill Me 形成阶段/缺口提案，只有 Human adoption 后才创建或合并项目，且不能伪造历史 Gate、Run 或 Evidence。
3. PI 批准 Scope 后，系统执行多源检索、去重和冻结 Corpus Snapshot；若采用了已有调研，先验证来源、license 与缺口。
4. Idea Panel 生成可证伪候选，完成新颖性反查；PI 选择一个版本。
5. 系统物化 Baseline 代码和数据，在隔离 Runner 中真实复现。
6. 系统生成 ExperimentContract；PI 审批并冻结合同。
7. Engineer 生成 Patch 和代码快照；Operator 执行 Smoke、Pilot 和多 Seed Formal Runs。
8. 用户可在 Run Terminal 中实时查看每个 Job 的 stdout/stderr，也可打开独立 Interactive Terminal，在受控 Workspace/Runner 中输入命令、使用 TUI、调整窗口并重连会话。
9. Analysis Worker 按合同生成统计 Artifact 与 accepted Evidence；Claim Verifier 更新 Claim。
10. Writer 生成版本化 Workspace；用户以 VS Code 式文件树、标签页、搜索和编辑器直接修改项目文件，LaTeX 在保存后增量编译并实时刷新诊断、日志和 PDF。
11. Reviewer 检查数字、引用、限制、构建和复现；系统生成私有 Release Bundle。
12. Clean-room Verifier 重跑关键结果并重建 PDF；PI 最终决定 Release Gate。

每一步由权威 `NextAction` 卡说明“现在做什么、为什么、由谁做、被什么阻断”，一项主 CTA 进入目标页面。Agent 运行时，用户可打开 Trajectory 查看消息/工具轨迹和 subagent 父子拓扑，并进入有权限的 child 查看详情。

Direction 是 Methodology overlay，不是新的 Project phase。fresh Direction proposal 如需治理，Overview/Approvals 必须显示 Human `direction_gate_review`，并只关联 strict payload 精确绑定 proposal+synthesis+direction 的专用 pending Direction Gate。adoption 后展示 Kernel 派生的五向 continuation：deepen 继续已批准边界内研究，broaden/pivot 打开既有 Intake continuation proposal，conclude 准备收束证据/写作，pause 交给 Human 复核；Kernel 在每次投影/重启时仍以 durable Decision + Gate 重验需治理 adoption 的 exact receipt，不能只信 adoption 内的 ref。浏览器和 DSH 只显示 Kernel 返回的 compact recommendation，不按 direction 文本自行推断或执行；continuation 永不直接改 Scope、Contract、Project 或自动 Gate。

## 5. 核心能力

### 5.1 研究控制面

- 项目状态机、Revision CAS、历史与下一步动作；
- Human Gate 请求、决定、理由、对象版本和认证 Principal；
- 预算、数据、执行、网络和发布策略；
- Durable Orchestrator，在重启后根据 Kernel 投影恢复。

### 5.2 学术工作流

public v2 name-only adapter 保留对 legacy 额外字段的忽略语义；它不是 DSH create/link 的安全边界。DSH internal 幂等摘要必须使用专用 plugin token 作为 HMAC 密钥并覆盖固定 route/session/name，因此公开请求不能伪造同一摘要。

- OpenAlex、Crossref、arXiv 的结构化检索与失败透明；
- Unicode-aware 去重、引用图、Passage 与不可变 Corpus Snapshot；
- IdeaCard、Novelty Audit、Pareto shortlist；
- ExperimentContract、代码/数据快照、真实隔离实验；
- MetricSpec、RunSet、AnalysisPlan、EvidenceItem、Claim；
- 确定性稿件、图表、BibTeX、复现包。

DSH 直接创建链路的安全补充：`project_name` 必须等于确定性语法从本次用户原文创建命令后缀解析出的完整名称，不能只是名称子串；原文必须是单一、整句锚定的肯定创建指令。疑问、否定/取消/避免、带逗号/分号或“然后/并/and/then”等连接词的后续子句、无标点的“不创建/not create/先别创建”尾句、主题讨论、历史推断、模型补名或字段/完整解析名称不一致均零写；命令判定不得因合法名称自身含“风险”“方法”“类别”或英文 `What` 而拒绝。internal create route 同时要求 Kernel bearer、共享 service token、仅注入 DSH plugin/kernel 的非空专用 token 与固定 audience；专用 token 配置缺失/空白或 `x-service-principal` 自报值均不能授权。创建事务内同时处理 idempotency ledger 和原始 `session_links` 行，任何活动、墓碑、悬空或并发 link 均稳定 409，绝不 upsert 改绑。DSH request hash 必须是用专用 plugin token 签出的 route/session/name HMAC；public v2 可兼容 legacy 额外字段，但任一方向都不能用同 key 构造相同摘要或认领对方资源。提交后 transport 在 fetch、响应头或成功响应体读取/解析阶段失败、超时或 abort 时，只允许用同一幂等 key 的 replay-only 请求取得已提交回执，再以无 caller signal 的权威 link/projection 对账；回执不存在时零写并保留错误，不能因同 session 恰好出现同名项目就报告 executed。

Chat 是项目内部工作面，不是跨项目共享的全局收件箱。每个本地 Chat session、active session、transcript、草稿、引用回复、附件引用、搜索上下文和异步命令/上传回写都必须绑定明确 `project_id`；切换项目只加载目标项目的对话，返回原项目时恢复其自身状态。固定全局 localStorage key、无项目字段的 session、或仅凭同名 session id 回写结果均不符合隔离要求。跨项目附件引用必须拒绝或过滤，项目 A 发起后延迟完成的命令/上传不得写入项目 B；引用回复只能由创建它的 exact session 消费。一次正在执行的 turn 必须由 page-lifetime exact project/session single-flight 持有，不能因 composer 重绘而重新开放重复提交，且模型 selector 在该轮完成前保持冻结；关闭 session、删除项目或浏览器/BFF 断开必须把取消信号贯穿到模型 bridge。项目删除同时删除 transcript/context、封死 project/session late write 并清附件队列；open server upload 的权威清理由 Kernel 在 tombstone 事务内完成，浏览器不得依赖 tombstone 后已无权限的 abort。外部删除只在项目列表成功且 projection 明确 404 时触发本地 destructive cleanup，网络/5xx 必须保留恢复数据，不能让延迟结果复活 tombstone project。Composer 必须有持续可见、带文字且具备 ARIA 的“上传文件”入口，并提示可选择、拖放或粘贴；项目没有 active Intake 时由该入口自动创建隔离 Intake，不能要求用户切换到 Intake 页面后才能上传。上传必须遵守服务端 begin/list 协商的 chunk cap；begin/append 在途暂停不能被旧状态覆盖，失效 stage 重选后必须重新 begin。

Chat composer 内首次输入 `/` 必须立即显示命令补全并连续得到 `/…`，候选可见性只能由当前草稿是否为 slash command name prefix 决定，不能依赖菜单此前已经打开；也不得因命令补全或页面级快捷键把 caret 移到 `/` 前。页面级键盘监听位于 Shadow DOM 外时，必须使用 `event.composedPath()` 判断事件是否源自 `input/textarea/select/contenteditable`，不能只依赖被重定向为宿主节点的 `event.target`；编辑态、IME composition 和按键 repeat 均不得触发全局 `/` 接管。真正从非编辑区域使用 `/` 快捷键时，预填后必须聚焦 composer，并把 selection 显式放到文本末尾。

外部删除对账不能只检查当前选中的项目。一次成功的项目列表读取后，浏览器必须枚举本页 transcript、upload、vision、turn、attachment-flight 等全部 page-lifetime store 持有的后台项目，不能把 localStorage 持久化成功当作可发现性的前提；对列表缺失项再取得 projection 404 后，逐项调用同一 project discard，取消后台 turn/Intake/hash/upload、释放 File/视觉队列并删除 snapshot。列表失败、projection 非 404 或仍在列表中的项目一律保留。

关闭 Chat session 必须建立 Kernel durable scope tombstone。浏览器先把关闭意图写入独立 durable outbox；只有 outbox 已落盘或 Kernel 已确认时才移除本地 session，storage 失败则保留 session 供重试，项目激活/成功列表刷新自动重放。Chat 附件创建的 Intake 与 upload session 持久化绑定 `owner_scope_id`；scoped Intake 只能被同 scope 或 unscoped 工作流复用，不能跨 Chat scope 借用。客户端取消信号贯穿 Intake、hash、begin、append、finalize，服务端在每个可产生权威写入的边界重检 scope，包含 multipart/direct artifact stage。tombstone 与所有相关 upload 转 aborted ledger 必须同事务提交，文件清理失败可恢复。关闭已先线性化时，任何迟到 continuation 都返回 `chat_scope_closed` 或被补偿 abort，且只能回滚本 session 实际拥有的 staged artifact；重复 abort 保留未清理账本，same-SHA 新 stage 接管 generation，去重命中、已扫描或后来重建的材料不能被旧 ledger 删除。Project/Intake/scope/quota 的 upload begin 校验与配额预留必须同处一个写事务。

Chat composer 必须同时接受自由自然语言与一级 slash command。显式 `/...` 是确定性高级入口；普通文本在 active Init Grill 时仍只回答当前唯一问题，其他阶段进入 project-scoped natural turn，由意图路由器结合 Kernel `next_actions_v2` 选择只读查询、可安全执行的 Agent 动作或阶段感知对话，不能把 prose 当成未知命令。开放讨论通过当前 DSH `llm` service 回答，但模型只产文本，不能直接写 Kernel；DSH 插件与 standalone 间只能使用不暴露给浏览器的 authenticated loopback bridge，模型不可用时保留确定性阶段引导。用户明确说“继续/推进/执行下一步”时，只能执行当前投影中 `state=ready`、`required=true`、`required_by=agent` 且不需要额外参数的 canonical Agent 动作；当前包括 `/write`、`/review`、`/release-bundle`，而 survey 仅在用户同时给出 query 且 `survey_run` ready 时执行。`/ideas` 只读；“生成几个 idea”或 `/ideas generate <1-5>` 仅在 `idea_generate/ready/agent` 且存在最新非空 frozen corpus 时执行，模型只返回严格 `IdeaDraft`，Kernel 用 project revision CAS、corpus provenance 和单事务整批写入；任一草稿无效或竞争均零写，且不选择 winner 或批准 Idea Gate。实验、复现和其他缺参数动作返回可编辑 slash 建议，不得猜参数。active Grill 的下一题由权威 projection 作为 transcript 末尾的 assistant question 显示；提交回答后 transcript 保存普通 user/assistant 回合，下一题就地推进，不能再显示一套独立 Brief 输入框、重复下一题或抢夺 composer 焦点。自然语言路由不得根据状态 label 猜 mutation：未知/歧义/blocked/权限不足时只解释并给出候选；Gate Decision、Brief confirm、Intake adoption、Release 决定等 Human-only 动作永远不能由模型代做。任何自动触发结果都必须回显解析出的动作、参数、执行状态和最新权威 NextAction；显式 slash 与自然语言必须进入同一 canonical operation/权限/审计语义。`/new <name> [<brief-json>]` 的唯一必填参数是非空 `name`；省略 `brief-json` 必须创建 name-only `DRAFT/collecting` 项目并进入 Grill Me，不能要求用户先构造 Brief。命令 adapter 必须按 DSH Command Registry 的真实 `rawInput` 契约处理命令名后的保留分隔空白。

`SURVEYING` 本身不证明语料可供 Idea 生成。Kernel 只有在同项目存在 `frozen=true`、`source_status=complete` 且至少含一篇 Paper 的 Corpus Snapshot 时，才可把 `idea_generate` 投影为 ready 并固定该 snapshot ref；否则 `idea_generate` 必须以 `frozen_nonempty_corpus_snapshot` 明确 blocked，同时给出 ready 的 `survey_run` 修复动作。UI、Chat 与 full-auto 都只能消费该权威状态，禁止因阶段标签或曾经存在空/未完成快照而本地放宽。

IdeaCard 生成成功后不得继续投影为 `idea_generate`。只要 SURVEYING 项目已有 proposed 候选，NextAction 必须切换为 Human `idea_select`，在 Overview 每张候选上提供“选择并审计”入口，同时支持 `/ideas select <idea_id>`。该操作必须先用 Scholar connectors 对所选候选执行真实 counter-search，失败时零写；随后由 Kernel 在单事务中校验 project/idea revision、候选归属与 frozen corpus，保存 NoveltyAudit、执行 `SURVEYING→IDEATING` 并创建唯一 pending Idea Gate（payload 固定所选 `idea_id`）。不得自动挑选候选、不得创建 payload-less 正常 Idea Gate、不得自动批准 Gate；成功后的 NextAction 才能是 Human `idea_gate_approve`。

Idea Gate 批准必须在同一事务把 payload 指向的 IdeaCard 冻结为 `approved`，不能只推进 Project。随后流程固定为 `IDEA_APPROVED → contract_register → CONTRACT_PENDING → Human Contract Gate → CONTRACT_APPROVED → baseline_reproduce`：`contract_register` 必须是可执行动作，按钮、自然语言“继续”和 `/contract draft` 共用一个 BFF；它从唯一 approved IdeaCard 的 minimum viable experiment 形成可审计合同草案，由 Kernel 以 project/idea revision CAS 单事务登记 Contract、进入 `CONTRACT_PENDING` 并创建 payload 绑定 contract_id 的 pending Contract Gate。Gate 拒绝或要求修改后必须重新给出 `contract_register`，不得让项目只剩 blocked 动作；Orchestrator 禁止创建 payload-less Contract Gate。任一非终态、无 pending Human Gate 时至少存在一个 `state=ready` 的权威 NextAction，动作不得依赖只能在后续阶段创建的对象。

DSH 本体 Chat 必须注册单一受控入口工具 `dsh_scholar`。DSH Agent 在用户用普通自然语言提出“创建研究、继续调研、查看进度、下一步做什么”等项目研究意图时，把用户原文和当前 DSH `session_id` 交给该入口；用户明确创建且给出名称时额外传 `project_name`。入口只按 session link 解析一个 Scholar 项目，不能读取或写入其他项目。Host 提供的 session id 必须符合 1–256 位安全 opaque-id 语法（首位字母或数字，其余仅字母、数字、`. _ : @ -`），所有进入 URL path 的 id 必须按单个 path segment 编码；`/`、`\`、`?`、`#`、`%`、首尾/内部空白和控制字符一律 fail closed。未关联时，明确创建 + 1–120 字符名称必须直接创建 name-only `DRAFT/collecting` Project、active Init Intake 和 PI membership，并在同一 Kernel transaction 绑定当前 session；名称不明确则只追问，不能产生占位项目，也不能强迫用户先进入 standalone 页面。创建或继续遇到 collecting Brief 时，插件必须通过正式依赖的 Harness `ctx.userQuestions`，把每个权威 Grill question 逐题交给 DSH 原生 composer takeover UI；必须传递 exact live root Agent、复用原生自由文本/跳过交互，并提供“暂时未知”选项，紧凑 `dsh Scholar` 页签禁止复制第二套提问框。等待答案期间重新核对 session link、question code/revision 后才写入；缺少 userQuestions service/provider 属部署错误并 fail closed，不得启用旧表单、猜答或自动确认。创建通过 service-token + `dsh-plugin` identity 的 internal route，Human Principal 由持久的 DSH plugin route credential 通过固定 HMAC 域派生；同一 Kernel 实例的全部 DSH session 与 standalone BFF 使用同一个稳定本机操作员身份，客户端/模型不能提交或覆盖该 principal；idempotency 按 session + 规范化名称固定，重试返回同一项目，已有不同 link 或竞争 relink 必须 409。已关联项目返回权威阶段时间线、主要 NextAction、Gate/Job 摘要、解析出的意图和执行结果。Unknown DSH role 只允许调用这个有界入口，不因此获得 `research_project`、Gate、Evidence 或 Runner 等低层工具权限。自动写集合只包含上述显式 name-only 创建、由 Human 在原生提问 UI 中逐题提交的 Brief answer，以及权威投影为 ready 且用户本次话术以正向动作词明确确认的 `survey_run`；Brief confirm 仍为 PI-only。“研究”“research”等主题讨论、疑问、歧义以及“不要调研 / do not research”等否定话术不得写入。检索完成后必须重新读取 revision/NextAction/session link，并在 Kernel Corpus transaction 内同时校验 `expected_revision + expected_session_id→project_id`；检索期间从项目 A relink 到 B 时不得再向 A 写入。提交写入前取消为零写，进入不可回滚 commit boundary 后按已提交处理，不能声称“取消即零写”。对外错误只能使用稳定安全摘要，不能回显 Kernel endpoint、内部 path 或上游错误。其他 Agent/Runner 写动作只生成 canonical slash 建议，Human-only 动作只解释并引导到人工页面，绝不代做。

DSH 会话中的 `dsh Scholar` 页签必须是 Host 原生、面向当前 session 的紧凑视图，不得 iframe 或压缩显示完整 standalone 工作台。已关联时只显示当前项目、revision、完整研究阶段、主要下一步 label/reason、待审批数与运行统计，并提供“在新页面打开完整 Scholar”；未关联时必须在页签内直接列出当前稳定 DSH 操作员可见的项目供显式绑定，也可只填写项目名创建 name-only 项目并在同一事务绑定。归档项目可显示但不可绑定；绑定同一 pair 可幂等重试，任何改绑、悬空 link、竞争 link 或跨操作员项目都必须 fail closed，不能静默 relink。读取 workspace 后要再次核对 session link；link 在读取期间变化时重试或 fail closed，不得把旧项目投影标成当前 session。

trusted-host `/dsh-scholar-view` 只承载请求字段严格校验的 `session-workspace`、`session-bind` 与 `session-create`；配置和 standalone Token 仍在独立 loopback-only channel。响应进入 React state 前必须经过共享 runtime normalizer：`session_id`、linked `project_id`、revision 与所有已知字段类型 fail closed；独立升级新增的普通字段忽略且不复制。旧服务端缺失或返回 null 的 Knowledge/Manuscript/Runs/Topology 块分别归一为 inactive/null/zero 安全默认；单个非 null 畸形可选块只丢弃该块、记录 `unavailable_blocks` 并在 UI 显示“不可用”，不能拖垮十阶段时间线。任何 `token`、Secret、payload 或 content 字段都不能进入归一化投影；workspace/project 身份层出现敏感字段直接拒绝。响应必须精确匹配当前 `session_id`，切换会话立即取消旧读取和写入、清空 busy 状态并重新加载，迟到或 session 不匹配的响应 fail closed；可见态至多每 4 秒一个串行读取。阶段标题与可见状态文字不能只靠颜色区分，`current` 与 `blocked` 阶段都使用 `aria-current=step`，状态、错误、空态和 aria 全部支持中英文。DSH 页签与 standalone 必须复用同一个 Kernel endpoint/dataDir 和稳定操作员身份，因此双方显示同一批有权限项目；standalone BFF dataDir 只允许保存浏览器 Token、操作员 session 和显示配置，禁止包含第二个 `kernel.db`。

升级不得通过更换默认 `kernel_data_dir`、启动空数据库或退役旧目录，让已有项目、Workspace、Artifact、TeX、Intake、Gate、Run、Assurance/Methodology/Writing/rollout ledger 或会话关联从产品界面消失。数据目录/存储拓扑发生变化时，升级必须在切换权威 endpoint 前由 Operator 显式离线执行可审计、可重复运行的导入；正常 sidecar 启动不得扫描环境变量或退役目录、复制旧库、修补旧 migration checksum。导入顺序固定为：先备份目标 DB/CAS inventory，再对源库做只读 snapshot 并在副本上迁移；随后在一个 DB transaction 中校验完整 product-table inventory、按 parent-first 顺序 merge 并执行 FK 检查；只有 DB 成功后才能复制 CAS/Workspace/PTY，全部成功后才能写 receipt。DB 冲突必须零文件副作用；文件冲突不得写 receipt，并须允许修正后幂等重试。migration checksum 漂移必须 fail closed，低版本 receipt 不能替代完整重接管。失败必须保留旧库可恢复且不得启动空工作台；禁止长期双读、静默 fallback 或直接覆盖已有目标库。完成导入后只保留一个当前 Kernel 作为运行时权威，旧目录进入带 inventory/导入回执的只读保留期。

每次 assistant 回答结尾都应给出与当前阶段相符的一项下一步引导，但不得自动跳页或覆盖用户正在编辑的草稿。Chat transcript 在底部时随新消息继续贴底；用户向上查看历史时，新消息、8 秒投影刷新、locale 切换和 Dock 重绘必须保持当前滚动锚点并显示“跳到最新”，不得反复回到顶部或强制拉到底部。滚动/follow 状态按 project + session + surface 隔离，切换回来恢复各自位置。

### 5.3 执行可观测性

- Runs 列表和任务详情；
- stdout/stderr 分通道且按全局序号合并；
- 实时流、断线续传、截断标记、最终退出码或信号；
- 取消实际进程树或容器，并显示权威取消结果；
- 完整日志作为项目级 CAS Artifact 下载。

Run Terminal 是正式 Job 的只读、可恢复账本。Interactive Terminal 是单独的真实 PTY 会话，必须使用 xterm-compatible 浏览器终端模拟器，支持可聚焦键盘输入、粘贴、IME/Unicode、ANSI/VT 光标与 alternate-screen TUI、窗口自动 resize、INT/TERM/KILL、断线续传、显式关闭和审计。把服务端输出逐行放进普通 `div/textContent`、只提供 resize/signal 按钮或存在未接线的 `sendText()` 均不算 Web Terminal 完成。Interactive Terminal 不得直接产生正式 Metrics、accepted Evidence 或 Human Decision；浏览器不能获得 Runner/SSH/Kernel secret。

### 5.3.1 可配置实验环境

- 实验执行环境是版本化 `RunnerTarget + RunnerProfile`，至少支持 `local-process`、`local-docker`、`remote-ssh` 三种显式类型；项目、Contract、Job 和复现 attempt 只引用 opaque ID，并在 submit 时固定 target/profile/environment revision 与 hash；
- Settings 必须以“本机开发 / 本机 Docker CPU / 本机 Docker NVIDIA / 远程 SSH”四个用户可理解的预设进入同一个创建、测试、保存和设为项目默认流程；切换预设只显示该类型需要的字段，保留未提交草稿，加载失败、CAS 冲突和连接测试失败均显示可重试的结构化诊断，不能让配置区静默消失；
- `local-process` 仅允许明确标记的 trusted development/smoke 工作负载，不能承载 baseline、pilot、formal、reproduce、latex-compile 等正式隔离任务；`local-docker` 使用固定 digest、非 root、只读根、资源/网络策略；`remote-ssh` 连接受控实验机器并在远端执行同一冻结 ExecutionPlan，不能成为业务权威；
- Docker 配置必须允许由 PI/Operator 在权威 RunnerTarget Registry 中登记完整 `repository@sha256:<digest>`；该 Registry 写操作本身就是本项目的受控 image allowlist，不能由普通项目输入绕过。禁止把 tag、`latest` 或任意 Docker flags 固定到正式 Job。计算模式是判别联合：`cpu` 不产生 GPU 参数；`nvidia` 必须显式选择 `all` 或数字设备 ID 列表，并在 ExecutionPlan、RunManifest 与 environment hash 中固定。保存时至少完成共享 schema 静态校验；每次 spawn 前必须检查 Docker daemon、镜像、NVIDIA Container Toolkit/driver 与请求设备。独立“测试连接”API/UI 仍是关闭本项所需能力，未实现前不得把保存成功描述为环境已就绪；失败返回稳定诊断且不得自动降级 CPU、本机或其他 target；
- Settings 的 Execution 折叠组提供 Target/Profile 列表、创建、编辑、禁用、健康状态与能力配置。远端 endpoint、known-host/CA 与 credential 分别以完整 SecretRef 配置，界面必须显式覆盖 `scheme`、`name`、可选 `version` 与可选 `scope`，编辑已有 Target 时不得丢失任何可选元数据；SecretRef 只保存于服务端，浏览器、项目、Job、argv、导出包和日志均不得得到私钥或原始 endpoint 内容；
- 当前项目必须能在 Settings 中以 CAS 保存默认 RunnerTarget；`/run` 与 `/reproduce` 的 JSON 可用顶层 `runner_target_id` 对单次 Job 显式覆盖。解析优先级固定为“Job 覆盖 > 项目默认”，两条路径都必须在 Job/ExecutionPlan 中固定同一 target revision/hash；页面只显示 opaque id、类型、能力与健康摘要；
- 持久化 `health=unknown` 只能显示为未探测的观测摘要，不能伪装成 online；远端执行权威来自认证 Agent Registry 的新鲜 heartbeat。offline/draining/capability mismatch/host-key mismatch 必须 fail closed 或保持 retryable，绝不静默切换到本机或 Docker。目标在排队、claim 或 spawn 前任一时刻被禁用、排空、换 kind 或 revision/hash 漂移，旧 pin 均不得执行；更换环境必须由用户创建显式新 attempt，并产生新 pin/审计。
- 论文复现的 execution binding 与 environment lock 不能只保存未经解析的字符串：创建/更新 spec 与启动 attempt 都要对照 RunnerTarget Registry 校验 target/profile 兼容性，并固化 target revision/hash；未知、禁用、排空、冲突或过期的环境绑定必须 fail closed。

### 5.4 Workspace Workbench

- 项目可有 code、manuscript、scratch 等版本化 Workspace，文件树和路径均为项目根相对形式；
- VS Code 式 Explorer、已打开标签页、全局搜索、行号、语法高亮、查找替换、撤销重做、快捷键、Problems 和集成 Terminal；
- Workspace 内容搜索必须调用 project-scoped Kernel search 并显示 path/line/snippet；搜索与编辑输入期间不得重建控件或抢走焦点。`patch_apply` 只接受 `workspace_id` 与单文件文本 unified diff，并以 version/etag CAS 写回；禁止宿主路径、多文件、二进制与 rename/copy patch；
- 文本与二进制文件可直接查看；可编辑类型由 media type 和策略决定，未知/大文件安全降级为只读或下载；
- manuscript TeX facade 与 generic Workspace API 必须是同一文件权威的两种视图：list/tree/read/version/blob/write/move/delete/search/watch 任一 generic 操作都必须先解析 workspace backend，不能因“generic store 未命中”把已存在的 TeX 文件误报 404；公共节点大小字段缺失或非法时 UI 安全显示 `0 B`，不得出现 `NaN undefined`；
- create/read/write/move/delete/upload/watch/search/snapshot 共用 Revision/ETag/CAS，冲突提供 base/current/local，禁止静默覆盖；
- 编辑器只是 Workspace interface 的 adapter；Kernel 不依赖 Monaco、CodeMirror 或 VS Code Web。

### 5.5 Manuscript Workbench

- 项目级 TeX 文件树，至少支持 .tex、.bib、.sty、.cls、图片和生成图表；
- 文本编辑、保存、版本冲突、历史与恢复；
- 固定镜像中的 latex-compile Job；
- pdflatex/bibtex 或配置的 biber 多遍构建；
- 实时编译终端、结构化诊断、点击跳到文件和行；
- PDF 安全预览、下载、过期提示和输入版本追踪。

LaTeX “实时预览”表示：成功保存后按可配置 debounce 创建可取消、可取代的 preview build，实时显示同一 build 的编译输出和诊断，并在成功时刷新 PDF；编辑发生后旧 PDF 必须在不重建编辑器 DOM、不打断焦点/选区的前提下立即标记 stale。preview build 不得进入 Evidence。显式 Compile 仍创建冻结输入、固定镜像和完整 RunManifest 的权威 latex-compile Job。

Manuscript 的 builds/preview-builds 轮询必须分别 single-flight，并以 generation + project + document + request sequence 拒绝乱序迟到响应。权威 PDF 只从 `preview=false` 的最新成功 Compile build 选择，并按 build_id 替换/回收旧 URL；live preview 只使用 preview projection，二者不得串区。若最新成功的 Compile 或 preview build 明确没有 `pdf_artifact`，必须立即回收并清空该区域上一 build 的 PDF，不能把旧稿继续显示为当前成功结果；较新的 queued/running/failed build 仍可保留上一成功 PDF，但必须在 PDF 区本身显示 stale。较新 succeeded build 的 PDF fetch/解码失败时可以保留上一 PDF 供参考，但必须按 build_id 明确标为 stale，不能因最新状态仍为 succeeded 而显示为 fresh。Save→Compile、Regenerate、Reload 等跨 await 操作必须钉定发起时上下文，保存后的 preview hook 也必须属于可取消的 manuscript generation；切项目、切文档、离面板后不得继续对新上下文提交动作或重启旧轮询；读取 manuscript workspace 只有明确 404 才允许首次创建，401/500/网络错误不得降级成写操作。

### 5.5.1 Artifact 多格式预览

- Artifact 预览必须按服务端 MIME essence、登记文件名扩展名与 Artifact kind 的保守组合分类，MIME/扩展名冲突时采用更安全的行为；不能把未知二进制调用 `Blob.text()` 后显示乱码；
- 原生只读预览至少覆盖 PDF、安全栅格图（PNG/JPEG/GIF/WebP/AVIF/BMP）、音频与视频；结构化只读预览至少覆盖 Markdown/R Markdown/Quarto、JSON/NDJSON/Jupyter Notebook、CSV/TSV、纯文本、代码、TeX、BibTeX 与日志；
- Markdown 只使用白名单块/行内节点并分别限制 block、list item、表格行列；JSON/NDJSON 的格式化必须保留原始数字字面量、重复键和 `-0`，不得通过 JS number round-trip 改写科研数据，同时设置嵌套深度与格式化输出上限，超限时回退原始有界文本，不能因缩进放大造成主线程或内存拒绝服务；CSV/TSV 有界行列解析。所有动态内容使用 DOM text node/属性，不使用 `innerHTML`；文本、JSON 和表格必须有字节/字符/行列上限和明确截断提示；
- `text/plain` 可由安全的结构化文本扩展名细化为 Markdown/JSON/NDJSON/CSV/TSV；`application/json` 只允许由 `.jsonl`/`.ndjson` 细化为 NDJSON，不能被扩展名提升为 Markdown 或表格。空或缺失的响应 `Content-Type` 必须回退登记 MIME 再分类，active/binary 冲突始终向安全侧降级。HTML、SVG、XML、Office/ODF、压缩包、模型、科学二进制数据与未知二进制首期只显示安全元数据、格式说明和按需下载，不执行、不解包、不反序列化、不顶层打开；SVG 只有经受控转换产生的安全栅格衍生物才能预览；
- 下载型格式和超过文本预览上限的产物不得为了打开预览弹窗而完整读取响应体或创建 Blob URL；只显示响应/登记元数据，用户明确点击下载时才读取原始字节。文本响应即使缺失或伪报 `Content-Length`，客户端也必须以流式字节预算在 1 MiB 处停止并取消 reader，不能先完整缓冲后检查上限。浏览器无法解码 PDF、图片或音视频时必须给出可访问的错误和原文件下载，不能留下空白控件；
- 预览失败必须显示可访问的 zh/en 错误，不得静默变成空面板；关闭、切项目、卸载、切换产物、离开 Artifacts 或离开 Manuscript 面板时必须取消预览、批量/单项下载、TeX PDF fetch 与轮询，并释放全部 Blob URL；任何跨项目或跨文档迟到结果不得覆盖当前页面。Artifact 详情与预览弹窗都必须随 locale 重建，并在遮罩/Escape/按钮关闭时统一恢复焦点；同项目背景重绘替换了原触发行时，必须按 Artifact ID 找到新行或安全的面板控件作为焦点回退，不能把焦点交给已脱离 DOM 的旧节点。Shadow DOM 内的初始焦点、Tab 圈闭和关闭恢复必须以所属 ShadowRoot 的 active element 为准。下载、预览和 Range 始终携带当前 `project_id` 并经过 BFF membership 校验；服务端生成的无扩展名 `Content-Disposition` 不能遮蔽已知安全格式的下载扩展名。

### 5.6 Runner Fleet

- 默认 target 是本机 Docker；可登记受控远端 Runner machine 或 scheduler target；
- UI/Job 只引用不透明 `runner_profile_id`，不能提交 hostname、SSH command、credential、Docker socket 或宿主路径；
- Kernel 保持队列、lease、Run、Artifact、Manifest、预算和审计权威；远端 Runner 只物化 CAS 输入、隔离执行并回传事实；
- Runner 签名、Kernel 验签与 terminal observation 必须共用递归 canonical JSON：每层 object key 排序、array 保序、无空白；`resources`、`environment`、`outputs`、`lease` 等任一嵌套事实变化都必须改变 payload/observation hash，旧观察不得继续分类；
- target capability、health、draining、latency 和资源可见；无能力或离线时 fail closed，不静默回退到本机或 subprocess；
- 远端控制和 Artifact 传输使用 mTLS/短期 service identity、断点续传、hash、generation/token fencing。

### 5.7 配置中心

- 所有可配置项由单一版本化 Config Schema 定义，并生成 Zod、JSON Schema、配置文件模板、HTTP schema、CLI help 和 Settings 表单；
- 每项声明 instance/user/project/workspace/session/target/job scope、类型、默认值、范围、是否 secret、是否可热更新、是否需要重启以及是否允许更窄的下层覆盖；
- effective config 展示每个字段的值和来源；修改使用 revision CAS，外部文件修改与 UI 修改不会静默互相覆盖；
- secret 值不进入普通配置、浏览器、argv、日志、Manifest 或 Bundle，只保存 `SecretRef` 并由服务端解析；
- 唯一的浏览器明文例外是用户在 DSH Plugin config 显式触发“复制 standalone 访问 Token”：loopback-only Host action 从固定 `0600` 普通文件读取后直接写 Clipboard，不回显、不持久化、不进入 URL/日志/配置；该例外不适用于 Kernel、Runner、Provider、SSH 或任何其他 secret；
- 运行中的 Job、PTY 和 Build 固定创建时的 config revision/hash，新配置只影响新动作。

### 5.8 全页面 i18n

- 所有页面 chrome、弹窗、aria、通知、Terminal 状态和 TeX Workbench 控件首发支持简体中文与英文；
- 浏览器 UI 仍只构建和交付一份完整 standalone 实现；DSH Agent 插件在会话区注入 Host 原生的紧凑 `dsh Scholar` session workspace，并以新页面启动器打开同一 standalone URL，不复制业务 UI 或 BFF；
- 语言选择、fallback、插值、复数和 Intl 格式遵循 gui-plugin-plan.md；
- 项目名、论文、模型文本、Terminal 输出、TeX 源码和原始编译消息保持原文。

### 5.9 既有研究接入与文件上传

- 支持上传单文件、Workspace/TeX archive、代码、数据、日志、结果与私有 Release Bundle；上传可暂停、恢复、取消并显示 hash/scan 状态；
- ResearchOnboarding 以静态 parser 和 Grill Me 收集缺口，输出 observed phase 与安全采用 proposal；
- 用户可在创建新项目或合并授权项目之间选择，所有 path/role/revision 冲突显式解决，绝不静默覆盖；
- 导入日志只是 log Artifact，导入指标只是 legacy/draft Evidence；没有本系统签名 Manifest 时必须重跑或重新分析；
- 精确状态、映射和安全边界见 research-onboarding.md。

### 5.10 Trajectory 与 Subagent 拓扑

- Research Trajectory 展示 Kernel Outbox 的权威研究链；Session Trajectory 展示 DSH/Agent 的观察性过程，两者必须显式区分；
- subagent 以可折叠树/图展示 parent-child、role、mode、activity、duration、token/cost、失败和 children；
- 用户可进入 child，使用 breadcrumb 返回；one-shot 只读，continuable 只有 exact-parent 授权后可续问；
- history/cold read 不得激活 Agent，默认只返回脱敏安全摘要；
- 精确模型、流协议和 DSH 移植边界见 trajectory-subagents.md。

#### 5.10.1 阶段感知 Subagent 加速

- Survey、Idea、Writing、Review 优先使用确定性 fan-out/fan-in 面板；Init、Reproduce、Contract、Evidence、Release 可在领域 provenance 完整后并行读取、审阅与草稿任务；Experiment 的真实计算并行必须使用 Runner Job，subagent 只辅助规划、监控和诊断；
- child 只产出 observation、proposal、draft、review finding 或 diagnostic，不能批准 Gate、提交正式 Runner、接受 Evidence、支撑 Claim、合并 canonical manuscript 或发布；
- 每次 fan-out 必须钉定 project/session/revision/NextAction/snapshot/config/model，校验 exact live parent、membership、pending Gate、幂等、预算、并发和 allowlist；fan-in 后再次校验，过期结果不得回写权威对象；
- DSH child 使用公开 ctx.subagents 一次性 spawn、maxDepth=1 和最小 tool filter；所有路径必须 dispose，并把 running/terminal state 回写既有 observational topology；
- 当前 research_panel 已部分完成 Survey/Idea/Evidence/Writing/Review 的阶段 policy、DSH Host `ask` 审批、生命周期与 topology 回写，但 durable confirmation receipt、原子预算/四桶对账、durable idempotency、十阶段覆盖和真实宿主验收未完成，默认关闭；child 工具必须绑定创建时 project scope，取消/超时/重注册与 stale fan-in 均 fail closed。完整生成级契约见 subagent-stage-execution.md。

### 5.11 Model Provider 与 OCR

- instance/global Provider Registry 支持内置与自定义 Provider；credential 只保存 SecretRef，项目只引用 provider/model ID；
- 首个内置 OCR Provider 为 MinerU：Settings 的「Models & OCR」提供一个可折叠 MinerU 配置项，固定 `provider_id=mineru`，默认官方 Open API `https://mineru.net/api/v4`，模型目录为 `flash`、`pipeline`、`vlm`；Flash 允许无凭据，其他模式的凭据只能引用可选 SecretRef，浏览器和 Provider 记录均不得接收或回显明文 Token；
- 当前项目可在同一配置项内选择 MinerU OCR model，并通过既有 model binding 只保存 `purpose=ocr`、provider/model ID 与 provider revision/config hash。配置成功只代表 Provider 与项目绑定可用；在 OCR request/worker、结果 provenance 和状态恢复完成前，不得把文件展示为“已 OCR”；
- MinerU 配置面必须按「服务商配置 / 项目模型 / 访问凭据」分组；多字段表单禁止复用单行 Settings 布局。桌面宽度可用双列，窄屏自动收敛为单列，标签、说明、输入框、SecretRef 和保存按钮不得重叠、压缩为不可用宽度或溢出弹窗；
- OCR 是显式选择模型的异步 Intake pipeline，无匹配模型时 fail closed，禁止静默回退；
- OCR/parser 结果保持 `observed_unverified`，带来源、页码、模型 revision 和 confidence，经 Chat 逐项由 Human 确认；
- name-only Init、单题 Grill、批量分块上传和 Provider/OCR 的生成级契约见 `init-grill-upload-models.md`。

### 5.12 论文复现

- 用户用 `/reproduce` 或在 Chat 上传论文/PDF/代码/数据进入复现向导；所有 slash command 直接使用一级命令，不注册、不解析、不展示旧聚合前缀；
- 系统固定论文来源、代码 commit/CodeSnapshot、数据/hash、ExperimentContract、环境和目标结果，在本机 Docker 或配置的远端 SSH Runner 上执行；
- execution exit 0 不等于复现成功；必须生成不可变 ReproducibilityReport，对齐指标、表格、图和可选 TeX/PDF，结果为 pass/fail/blocked/inconclusive；
- Chat 附件先进入隔离 Intake；Interactive Terminal 按 Research/Chat/Subagent session 打开多个独立 PTY，不能作为正式复现证据；
- Chat 中的 PNG/JPEG/WebP/GIF 可同时作为下一次自由对话的瞬态视觉上下文：仍保留 Intake stage ref，但字节只经私有 BFF 交给 DSH AttachmentStore；一次选择/拖放/粘贴必须把新增图片与 exact-session 队列做原子批次预检，在任何字节读取前限制 20 图与 16 MiB envelope，失败零项进入视觉队列，通过后顺序有界编码并允许逐图移除；发送在首个 await 前冻结 exact project/session/history/quote/image ids。模型发现目录只用于 discovery；provider 与 opaque model id 只在第一个 `/` 分隔，目录外的已配置 route 由所属 adapter `resolveModelInfo` 精确解析，每个实际 turn 也重新 exact-resolve，失败不得改跑 Auto/首项。Scholar turn 固定含 text，因此显式空数组或不含 text 的 capability 表示不支持；字段缺失才是 unknown。视觉 turn 要求显式 text+image。用户显式 UI 选择优先于插件 PI 默认，只有 Auto 才允许回退默认或遍历目录并跳过离线/no-text 项；取消后必须立即停止解析。模型选择保存是发送屏障，迟到初始化 GET 不得覆盖已开始的 PUT，失败恢复上一已确认值并阻止 turn。exact-session single-flight 必须独立于 composer DOM，重绘不得重新开放提交，执行期间模型 selector 保持冻结。私有 Bridge 只原子发布一个 `0600 agent-bridge.json`，稳定错误由 typed code 而非英文 message 派生。文本/unknown/不可用模型不得忽略图片、按名称猜能力或静默降级为普通文本回答，失败后图片只保留在原会话；视觉回答零 canonical mutation，图片内指令不可信；
- 生成级对象、比较算法、环境绑定、API、NextAction 与验收见 `reproduction-contracts.md`。

### 5.13 全页面可停靠侧栏

- 左侧 Project Sidebar 只负责项目搜索、选择和项目生命周期；页面停靠区统一称为 Panel Dock/页面侧栏，二者不是同一个导航或配置对象；
- Chat、Overview、Approvals、Runs、Artifacts、Evidence、Budget、Manuscript、Run Terminal、Trajectory、Topology、Workspace、Interactive Terminal 等全部当前页面既可占据主区，也可作为一个活动面板停靠在右侧或底部；
- 同一页面任一时刻只允许一个活实例。把当前主页面放入 Dock 时，主区切到安全回退页；从 Dock 打开到主区时先关闭 Dock 中的该实例，禁止复制 Chat 草稿、PTY 输入目标、Workspace/TeX 编辑状态或流消费器；
- 右侧与底部切换必须移动同一个已挂载面板，不重建 DOM、不关闭 SSE/PTY，也不丢失焦点、草稿、选中文件和滚动位置；主区与 Dock 之间切换允许按最后序号安全重连，Terminal、PTY、Workspace watch 与 Trajectory 不得丢帧或重复展示；
- 用户可拖动分隔条调整尺寸，也可用方向键、Home/End 完成同一操作。默认右侧 420 px、底部 320 px，右侧限制 280–720 px、底部限制 180–640 px；无效或过期持久化值必须 fail closed 回默认值；
- Dock 的打开页面、首选位置和尺寸是当前浏览器的本地展示偏好，不是 Kernel Config Registry、运行时 config pin、项目数据或跨设备同步配置，不得保存 token、secret、聊天内容或研究文件；
- 视口小于 720 px 时，右侧首选位置只在视觉上投影为底部，不覆盖已保存的右侧偏好；Dock 标题、选择器、移动/关闭动作、分隔条 aria 和提示全部支持 zh/en 即时切换。

### 5.14 合同批准后的基线运行交接

- Contract Gate 批准只冻结实验约束，不等于已经存在可执行 Job。系统不得把 Contract 中的自然语言 baseline 描述直接当作 shell 命令，也不得伪造“运行中”；
- `CONTRACT_APPROVED` 且尚无 baseline Job 时，Runs 不能显示通用空白态。它必须显示一项由权威 `baseline_reproduce` NextAction 投影出的“基线运行准备任务”，列明缺少的代码快照、可执行命令或实验环境，并提供进入项目 Chat/Workspace/Settings 的明确入口；
- 用户在 Chat 中可以自然语言要求“准备/启动基线实验”。系统必须结合当前 approved Contract 逐项引导补齐代码、命令和 Runner 配置；参数不完整时零 Job 写入，不能退化成仅返回 `No jobs` 或要求用户猜 JSON；
- 参数完整后，baseline Job 提交与 `CONTRACT_APPROVED → BASELINE_REPRO` 必须是同一个 Kernel 原子操作，并绑定 approved Contract、不可变 CodeSnapshot、固定镜像/Runner target、输出契约、提交人和幂等键。matched-seed 复现还必须允许调用方显式固定整数 `seed` 与至多一个同项目 Data Artifact；二者进入请求幂等 hash、Job payload、`data_artifact_ids` 和签名 RunManifest，不能只藏在 argv。失败时 Project 与 Jobs 均不产生半写；
- Contract 的 `baseline_run` 是自然语言实验约束，不是 argv，也不能消除 `baseline_command` 缺口。UI/Agent 不得猜测 `python train.py` 等命令；只有用户或受信任工具提交的非空结构化 argv 才算命令已备；
- Runner 环境只有在 profile/target enabled、非 draining、kind/capability 匹配、SecretRef 可用且远端有未过期的认证 heartbeat 时才算 ready；unknown/offline/stale 必须保留 `runner_environment` 缺口且禁止远端提交，不得自动回退本机；
- Runs 的计数只统计真实持久化 Job。准备任务要明确标为“待准备”，不混入 queued/running/succeeded 统计；真实 Job 创建后准备任务消失并由 Job 卡片接管。

### 5.15 运维预算页面按需启用

- Budget 是运维诊断页面，不是默认研究流程入口。新浏览器实例默认不在“运维”导航、快捷键顺序或页面选择器中展示 Budget；预算记账、硬限制与 Budget Gate 仍由 Kernel 始终执行，隐藏页面绝不能关闭预算治理；
- 用户可在 Settings → Preferences 中显式启用或关闭“显示预算页面”。该值是当前浏览器的本地展示偏好，不进入项目、Kernel Config Registry 或运行时 config pin；不得包含预算值、token 或研究内容；
- 关闭后必须立即从导航与键盘顺序移除 Budget。若 Budget 正在主区显示，主区回到 Overview；若停靠在 Panel Dock，关闭该 Dock 页面。刷新后保持用户选择；清除本地偏好后恢复默认关闭；
- 预算页关闭时，`#tab=budget` 深链与快捷键不得绕过配置打开页面；预算超限、pending Budget Gate 或 `budget_resolve` NextAction 仍必须通过 Overview/Approvals 给出治理入口，不得因隐藏诊断页而形成流程死路；
- 设置项及隐藏/启用状态支持 zh/en 即时切换，并保持键盘、ARIA 与窄屏可用。

## 6. 明确不做

- 不把 LLM 对新颖性或结果的自评当作 Evidence；
- 不允许 Writer 从 stdout 或聊天内容抄取正式数字；
- 不允许模型调用 Human Gate Decision；
- 不允许正式 Job 使用宿主 subprocess、任意宿主路径或可变镜像标签；
- 不允许从 stdout 自由 JSON 行生成正式指标；
- 不提供通用网页抓取、任意 MCP 或 Cordis 自指工具的默认权限；
- 不渲染不可信 HTML，不让 SVG 脚本执行；
- 不自动提交 arXiv、会议或期刊；
- 不承诺通过当前原型即可进行无人值守正式研究。

## 7. 用户可见信息架构

页面采用渐进披露。未选项目只显示 Start；选中项目后顶栏只显示 Overview、Workspace、Runs、Manuscript 四个高频入口和 Settings 齿轮。其他能力收进 More、上下文 CTA 和可复制深链，不能因此失去键盘可达性。表中的全部当前业务页面都支持主区、右侧 Dock 和底部 Dock 三种展示位置；Settings 仍是独立设置面，不作为业务页复制到 Dock。

| 分组 | 页面/路由 | 核心任务 |
|---|---|---|
| Start | `/start` | Init、Resume、Upload/Continue existing research |
| Research | Overview | 唯一主 NextAction、阶段、Brief、可折叠 Trajectory/Topology |
| Research | Chat | 自由对话、按阶段自动引导与自然语言动作路由；保留 `/new`、`/reproduce` 等一级 slash command，上传材料并查看结构化结果卡 |
| Execution | Approvals | Human Gate 决策和审计 |
| Execution | Runs | 任务筛选、详情、取消和 Manifest |
| Execution | Run Terminal | 查看活动或历史 Run 的真实只读终端流 |
| Execution | Interactive Terminal | 在授权 Workspace 和执行 target 中操作真实 PTY；与 Run Terminal 分离 |
| Research | Workspace | 浏览、搜索、查看、编辑和版本化项目文件 |
| Research | Trajectory / Topology | 查看权威研究事件和 Agent/subagent 运行拓扑，进入 child |
| Review | Artifacts | 搜索、预览、下载项目产物 |
| Review | Evidence | Claim–Evidence、CI、效应量和限制 |
| Review | Manuscript | TeX 文件、编辑、编译、诊断和 PDF |
| Operations | Budget（默认隐藏，可在 Settings 启用） | 模型、API、GPU、并发和硬限制；页面可见性不影响 Kernel 预算治理 |
| Operations | Settings | 配置作用域、Runner targets、TeX、Terminal、限制、来源和 Secret 引用 |

Settings 首次进入时所有 section 默认折叠，按 Essentials、Execution、Workspace、Terminal、LaTeX、Agent/Trajectory、Security & Secrets、Diagnostics 分组；非默认项显示 badge，每项显示 effective value、来源 scope/revision/hash、热更新或重启标识以及 reset-to-default。配置不得散落在业务页常驻展示。

## 8. 成功指标

| 类别 | 最低标准 |
|---|---|
| Gate | 100% Gate Decision 绑定认证人类；通用 transition 无法进入 Gate 状态 |
| Run | 正式 Job 100% 容器执行；非 echo 不存在合成成功；Contract 批准后 Runs 总能显示真实 Job 或明确的基线准备任务，不出现无解释空白 |
| Terminal | 日志断线恢复无静默丢失；截断、缺口和退出原因可见 |
| Interactive PTY | 输入、resize、signal、重连和关闭可操作；无权限、过期会话或背压 fail closed |
| Workspace | 文件树/搜索/编辑/冲突/快照无越界与丢失更新；桌面和窄屏核心动作可达 |
| Evidence | 对外 Claim 100% 可追溯到 accepted Evidence 和签名 Run |
| TeX | 保存后实时 preview；固定镜像权威编译；日志/诊断可定位；PDF 与输入版本绑定 |
| Runner | 本机 Docker 与远端 target 使用同一 Plan/lease/Manifest；网络分区不产生合成成功 |
| Config | 所有可配置项 schema/UI/file parity；来源可解释；secret 零泄漏；运行固定 config hash |
| Onboarding | 任意阶段材料可恢复接入；pre-accept 零权威写；历史 Gate/Run/Evidence 无伪造；上传可恢复且冲突不覆盖 |
| Guidance | 每个非终态项目都有结构化下一步、原因、负责人和目标路由；未知 action 不会误执行 |
| Trajectory | Research/Session 权威性明确；subagent 拓扑可展开/进入/返回；详情脱敏、history 不激活 Agent |
| i18n | zh/en key 完整；全页面无硬编码 chrome；切换后即时更新且格式 locale 一致 |
| Panel Dock | 全部当前页面可在主区/右侧/底部间切换；同页仅一活实例；位置与尺寸可恢复；窄屏、键盘、i18n 与流重连无数据丢失 |
| 隔离 | 项目级 Job、Artifact、日志、文档和权限不串项目 |
| 恢复 | Kernel/Runner/UI 重启后无重复正式 Run、无丢失 Gate、无孤儿容器 |
| 复现 | Release Bundle 在空环境重建关键指标和论文，满足合同容差 |

## 9. 发布策略

Security Alpha 阶段只能私有导出。重新使用“全自动科研系统”定位，必须同时具备真实文献检索、真实 Baseline、Human-approved Contract、隔离 Formal Runs、确定性 Evidence、可编辑并可编译的 TeX 稿件、clean-room 重跑和 Human Release Gate。

## 10. 方法论与知识层

DSH Scholar 必须把研究方法作为受 Kernel 治理的辅助层，而不是第二套编排器。首批能力按 [methodology-knowledge-layer.md](methodology-knowledge-layer.md) 分阶段实现：Assurance 三轴、Protocol-before-run、受限两层循环、Research Synthesis、双通道知识 Registry，以及 Reverse Outline/Claim–Evidence 写作检查。

用户必须始终能区分“任务执行状态”“审查 verdict”“审查是否被接受”。审查 Job exit 0 不等于内容 PASS，模型 PASS 不等于 accepted，accepted 也不等于 Human Release Gate 已批准。输入变化后旧审查必须明确 stale，mandatory Audit 缺漏必须 blocking，不能显示为 N/A。

Assurance 执行只能显式调用已注册 producer。首批 `writing` 与 `claim-evidence` producer 生成真实 immutable findings Artifact；后者仅在权威 Claim 集为空时记录 `NOT_APPLICABLE`，并固定稿件 Artifact 与 canonical Claim→accepted-Evidence 集合 hash。未执行或不存在 producer 必须继续表现为 missing/blocking，不能用 N/A 掩盖；新增 Claim/接受证据变化会让旧 N/A stale。该执行层不能自动审批 Assurance、Gate 或 Release，也不能修改 TeX。

外部研究仓库当前只允许方法语义的独立重写。第三方原文、模板、代码、示例、论文段落、品牌资产和远程 Pack 不进入产品；任何后续 vendor 必须作为独立需求重新完成许可、来源、NOTICE、SBOM、安全和验收决策。

截至本轮实现审计，strict Schema、四个纯 Module、`AssuranceStore` / `MethodologyStore`、migration `0028_methodology_knowledge_layer`、typed HTTP/Client、durable membership/PI/Operator AuthZ、可重建 Research Graph、standalone compact read projection、DSH session-bound compact summary/methodology tools 与 Protocol 驱动的 Job pre-write admission 已存在；实际表为 `assurance_events`、`methodology_project_events`、`methodology_registry_events`，Graph 不是另一份权威存储。formal/confirmatory Job 会读取 frozen Protocol 并复核权威 Contract/Code/Data/Environment/Runner/预算 pins 后才写入；Direction adoption 会复核当前 Project/NextAction revision，并沿 durable approved Decision→专用 `direction` Gate→strict proposal/synthesis/direction payload 与 Human PI/operator membership 构造 verified receipt，成功只追加 immutable Adoption。

有状态方法论协调不得堆叠在 `ResearchKernel` 或 HTTP handler。当前 Knowledge activation/delivery、Synthesis admission/telemetry、Writing methodology/Assurance 已分别进入三个具体 Coordinator；Kernel 公共方法只是兼容 wire 的稳定 façade，并以窄事务/投影/Store/Artifact/Topology/telemetry ports 注入能力。Synthesis 必须继续消费唯一的 `run-outcome-lifecycle` 与 `synthesis-admission`，科学分类不得出现第二套 evaluator；full-auto 继续只由 `full-auto.ts` 授权。该拆分不能改变任何 AuthZ、CAS、append-only、零写、Gate、Release 或 canonical TeX 边界。

Runner completion 当前只自动持久化 execution-only 未分类观察，并精确固定 run/attempt/lease/manifest/Protocol；它绝不自动猜 scientific outcome/run validity。未分类观察投影 `run_outcome_classify`，PI/researcher 权限下的 Human/Agent 显式分类后，Kernel 原子记录 outcome、分类 principal 与确定性 synthesis request；trigger 只投影 `synthesis_record`，不生成内容或推进 phase/Gate/Release。infrastructure failure 不产生 NegativeFinding，exploratory positive 只产生 proposal；重放、旧 attempt、崩溃恢复和 full-auto park 有自动证据。

真实本机 Docker formal positive fixture 已自动验证 signed Manifest `run_id` 对应的 pending observation、scientific-only classification、evidence_candidate 与幂等 replay；安全脚本在非 2xx 时必须显示 HTTP status/body，不能只暴露 curl exit 22。

这仍不构成完整用户能力：deterministic producer/findings Artifact、StageSubagent semantic seam、三份 Scholar-owned immutable native Pack、exact-context delivery、Chat/Assurance reviewer 注入与 append-only deactivate/revoke suppression 已存在，但生产 DSH Host/model 的实际可用性和人工交互仍待验收；远端 SSH/GPU、生产 Docker 科学分类/NegativeFinding、真实 reviewer/model、自动 Release、项目激活 UI 与人工浏览器/ARIA/TeX 验收尚未闭环。External Knowledge 永远只投递 `content=null` 的不可信 metadata，第三方正文没有进入 instructions。standalone Overview/Manuscript/Topology 和 DSH Host 原生 Scholar panel 当前都只显示 session/project-scoped 摘要；compact Assurance 已复用 verifier 解析当前可用 input hashes（包含 N/A 的 Claim–Evidence 集合 pin），Writing stale 已按 live TeX 与 Claim–Evidence hash 复算，但这些投影仍不替代 submission、Gate 或 canonical TeX 权威写入。此前八个无 runtime consumer 的 `methodology.*` / `knowledge_registry.*` 配置键已删除并明确延后，不能写成 schema-live；remote 禁止由 local-only Package Schema、resolver 与许可政策执行。

三份外部研究仓库在当前产品中统一保持 `METHOD_ONLY`。Registry 中出现 package record 或 evaluation 也不构成复制、vendor、分发或执行授权；当前 schema 只接受本地 immutable source，remote Pack 仍禁止，任何第三方正文/模板/代码进入产品必须先完成逐文件许可、归属、NOTICE/SBOM 与安全审批。自动化状态只按 [acceptance-tests.md](acceptance-tests.md) §25 的分层证据记录；真实 reviewer/model、Docker/SSH/GPU、浏览器/i18n/焦点与 TeX 全流程在人工执行前一律为 `NOT_RUN_MANUAL_PENDING`。

### 10.1 方法论 rollout 与产品可见性

Phase 8 采用一个持久化、可恢复的 rollout policy，而不是恢复未消费的 Settings 占位键。默认 `internal-fixture`；Operator 只能追加新全局 revision，项目 PI 必须显式把项目 re-pin 到当前 policy，Knowledge Activation 和 Assurance execution 必须保存 exact revision/hash consumption receipt。`opt-in-dev` 与 `opt-in-user` 只表达部署/用户采用范围，不提高任何角色或自动审批权限。

项目 compact 摘要应显示当前 mode、policy/project pin revision 与脱敏方法论 aggregate，帮助用户判断功能是否在该项目启用和运行；不得显示 actor、policy hash、项目/会话/包 identity、路径、prompt、正文或凭据。方法论 counters/histograms 是进程级运行观测，不替代 append-only Audit、Gate、Artifact、Run 或 Project ledger。真实浏览器对该摘要的可读性仍为 `NOT_RUN_MANUAL_PENDING`。

### 10.2 Assurance / Knowledge 权威输入边界

用户或模型不能直接写 Assurance verdict、reviewer independence、provider/topology 事实；所有 Audit 必须来自注册 producer，semantic reviewer identity 必须由 Kernel 从 durable StageSubagent execution identity 与 topology 派生。public API 只允许 deterministic producer，DSH semantic 执行必须是 Host-confirmed exact session。缺 reviewer identity、空/未完成 reviewer panel 或 provider unavailable 不得降级为 caller 声明，也不得落一条 BLOCKED Audit；产品只显示 typed execution diagnostic，Artifact、Audit、rollout consumption 保持零新增。合法 partial/complete panel 仍按真实 durable children 生成 provisional Audit。

Knowledge 激活表单/工具只收 package identity 与 CAS，不展示或提交 session、phase、principal 和 capability 数组。当前 session-project link、Project phase、NextAction、PI membership、project policy 与 capability intersection 全部由 Kernel 当前投影派生；跨项目、未链接、stale 或 forged authority 必须零写。这个边界同时适用于 standalone BFF、typed Client 与 DSH Host，不允许为某个入口增加兼容旁路。

内置 Knowledge Pack reconcile 只属于受管 DSH plugin 启动流程。internal route 必须同时验证共享 service token、固定 `dsh-plugin` audience 与独立 plugin token；共享 token、浏览器 bearer 或自报 audience 均不能单独改写全局 Registry。typed Client 只能从 server-side 构造配置发送专用 token，不能从 principal 参数或请求 body 接受它。

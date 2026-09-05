# DSH Scholar 使用指南

> 目标版本 2.5。浏览器 UI 仅支持 standalone，产品仍在开发中。本指南同时描述目标使用流程和当前限制；任何能力只有在 hardening-v0.2-status.md 标为“已验收”并绑定当前 CI 证据后才能用于正式科研。

## 1. 启动

~~~bash
bash scripts/start-standalone-ui.sh
~~~

访问 http://127.0.0.1:18610，输入启动脚本打印的 Token。完整工作台仍由 standalone 提供；安装根插件后，DSH 会话同时提供 `dsh Scholar` 页签和默认 `Alt+Shift+S` 新页面快捷键。打开页面后可以在 Settings → Language 选择中文或 English。没有手动选择时，系统先读 dsh.locale，再匹配浏览器语言，最后使用中文。切换语言不会翻译项目名、论文、命令输出和 TeX 原始错误。

在 DSH 自带 Chat 里可以直接用自然语言说“创建研究项目 OCR 复现”“继续调研”“现在到哪一步了”或“下一步做什么”，无需先记住 slash command。Harness 会调用 Scholar 的受控会话入口：没有关联项目时，整句肯定创建指令与原文中的完整项目名会直接创建 name-only Init 并绑定当前 session；缺名称会在对话中追问，普通未关联对话才把 `/new <项目名>` 作为可选快捷入口。项目进入 Brief 收集时，每个问题直接复用 DSH 原生提问输入区逐题出现，可自由输入、跳过或选“暂时未知”，紧凑 `dsh Scholar` 页签不会再出现第二个输入框；全部答完仍需打开完整 Scholar 由 PI 核对并确认 Brief。有项目时读取同一 session 的权威状态，明确回显识别到的研究动作、是否已执行、最新下一步与阻断。名称子串、疑问、否定、歧义不会创建；当前只有已就绪且用户以“开始/继续/执行”等正向动作词明确要求的调研快照可由这次对话直接执行。Gate、Brief 确认、外部研究采纳和发布决定仍需在 Scholar 中由人完成；其他写动作只生成可编辑的直接命令，不伪装成已执行。

会话的 `dsh Scholar` 页签是面向当前 DSH session 的紧凑入口，不再把完整 Scholar 工作台压缩进 DSH 主区。未绑定时可直接从同一批有权限项目中选择并绑定，或只填写项目名创建 name-only 项目并绑定；已绑定时只显示阶段条、每阶段可见状态、revision、下一步、待审批和任务统计。完整工作台通过页签按钮或 `Alt+Shift+S` 在新页面打开。两处复用同一个 `~/.dsh/research-kernel` 权威数据目录和稳定本机操作员身份；`~/.dsh-scholar-standalone/research-ui-standalone` 只保存浏览器 Token、会话和显示偏好，不得包含第二个业务数据库。

### 1.1 把页面停靠在右侧或底部

选择项目后，Chat、Overview、Approvals、Runs、Artifacts、Evidence、Manuscript、Run Terminal、Trajectory、Topology、Workspace 和 Interactive Terminal 等每个当前页面标题区都有“停靠到右侧”和“停靠到底部”。Budget 是默认隐藏的可选运维页，先在 Settings → Preferences 启用后才进入导航与 Dock 页面选择器。Dock 顶部的页面选择器可以直接换页，“打开到主区”把当前 Dock 页面恢复为全页，“关闭”只关闭 Dock，不关闭项目。

同一页面只会存在一个活实例：把正在主区显示的 Chat/Terminal/Workspace/Manuscript 放入 Dock 时，主区自动切换到其他安全页面；从 Dock 打开到主区时也不会复制第二份实例。右侧和底部之间切换的是同一个已挂载页面，因此草稿、选中文件、滚动位置和实时连接应保持。主区与 Dock 之间移动流式页面时，会从最后消费的序号安全重连。

拖动主区与 Dock 之间的分隔条可调整尺寸；聚焦分隔条后可用方向键微调、Home/End 跳到最小/最大。小于 720 px 时，右侧首选位置会临时显示在底部；回到宽屏后恢复右侧。打开页面、首选位置和两种尺寸只保存在当前浏览器，是展示偏好，不是项目配置或 Kernel config pin，也不会跨设备同步。

实验环境在 Settings → 实验环境（Experiment environments）中配置，分为本机进程、本机 Docker 和远程 SSH。正式实验应使用本机 Docker 或满足同一容器/快照合同的远程机器；本机进程只面向明确受信的开发/冒烟任务。项目、实验和复现只选择 Target/Profile 名称与 ID；SSH 私钥、known-host 和真实 endpoint 只由服务端 SecretRef 管理。远程机器离线、能力不匹配或 host key 校验失败时任务会阻断/重试，不会自动改成本机执行。当前代码已实现持久 Target Registry、revision CAS、PI/Operator 写权限、Settings 中英写面、Job/ExecutionPlan target revision/hash pin、target-aware claim，以及受控 SSH → RemoteRunnerAgent 引导；真实 Docker/SSH 主机、host-key 轮换、网络分区和生产 mTLS 仍为人工验收项，未验收前不得用于正式科研。

## 2. 首次进入：Init、Resume 或 Upload

未选择项目时页面显示三张启动卡（不会自动选中某个项目）：

- **新建研究（Init）**：只填写项目名，创建 `DRAFT/brief_status=collecting` 空壳并进入项目 Chat；Grill Me 每次只问一个问题，答完后预览 Brief，PI 确认才创建 Scope Gate；
- **打开已有项目（Resume）**：Start 屏下方列出此内核上的项目，搜索名称或输入完整 project id 后显式选择（不会自动选中某个项目）；选中后进入项目总览（当前不按 status/pending Gate/NextAction 自动跳转页面，tab 恢复只恢复上次使用的面板）；
- **上传 / 接入（Upload）**：选择目标项目与阶段，批量加入材料；独立页面默认按 8 MiB 分块，可暂停/刷新/恢复，每个文件显示 hash/静态扫描状态，单 Intake 默认总量 2 GiB（管理员最多配置到 10 GiB）。静态扫描与 Grill 后生成 proposal，PI 采用或拒绝；刷新后从服务端投影继续。OCR 已具备 durable create/read/cancel、worker 状态恢复和 `observed_unverified` provenance；真实 MinerU 网络与凭据仍为 `NOT_RUN_MANUAL_PENDING`。

Upload 可以创建新项目或选择有权限的现有项目。采用前材料只在 Intake quarantine 中；确认 proposal 后也不会声称历史 Gate 已批准、日志是本平台 TerminalLog、结果是 accepted Evidence。冲突必须选择保留当前、采用上传或重命名。服务端支持 Intake begin→stage→scan→grill→propose→adopt/reject、静态扫描/quarantine、确定性 taxonomy、单事务 Adoption、过期/GC 与可恢复分块上传；扫描前字节只在隔离 staging，不进项目 Artifact。DSH Agent 只能使用 `research_intake_begin`/`research_intake_stage`/`research_intake_scan`/`research_intake_propose` 准备接入；Human Grill answer 与 adopt 必须在可信原生提问 UI/BFF session 中完成。不能用普通 Artifact/TeX 上传模拟安全接入。

## 3. 创建项目与 Scope Gate

点击 New Project，只输入项目名。系统进入 Chat，逐题询问研究问题、范围、指标、输出、约束和已有材料；你可以回答、编辑、跳过或标记 unknown。确认 Brief 预览后才出现 Scope Gate。

**创建后自动进入 Chat 引导**：创建成功即跳转到 Chat 页面，当前 Brief 问题作为对话末尾的一条 Scholar 提问，按固定 7 题顺序推进。直接使用页面底部唯一的普通 Chat 输入框回答；问题消息本身提供“跳过”和“标记未知”，不再出现独立 Brief 输入卡。答完后同一位置出现 Brief 预览与「确认 Brief」按钮（等价于 `/confirm-brief`）；项目确认后问题消息消失。刷新页面后从服务端权威投影继续（不依赖 localStorage）。

Chat 对话属于当前项目。切换项目时，会话列表、当前会话、消息、草稿、引用回复和附件也随项目切换；返回原项目才恢复原对话。项目 A 中仍在执行的命令或上传即使晚于切换完成，也只能回写 A，不能出现在项目 B。当前修复状态以 hardening 的 `CHAT-SCOPE-01` 为准。

Chat 同时支持普通自然语言和一级 slash command。直接输入“现在进展怎么样”“看看审批”“有哪些想法”“查看运行任务”会按当前项目投影路由到对应只读操作；明确输入“调研 <主题>”可在 `survey_run` ready 时执行 survey。Brief confirmed 后的其他普通文本通过 DSH 当前已配置的模型自由讨论研究问题，模型只返回对话文本，页面始终追加 Kernel 权威阶段、下一步和阻断原因；DSH 模型暂不可用时仍返回确定性阶段引导。显式 `/status`、`/gates`、`/ideas`、`/ideas generate 3`、`/ideas select <idea_id>`、`/jobs`、`/survey ...` 是确定性高级入口。在 composer 内输入 `/` 会原位打开补全并保持光标连续；从页面非编辑区域直接按 `/` 则跳到 composer，并把光标放在预填斜杠之后。Init Grill 尚有当前问题时，普通文本仍回答该问题。

用户明确输入“继续”“推进”或“执行下一步”时，Scholar 只会执行当前权威投影已经 ready 且无需补参数的动作；当前可自动进入 `/write`、`/review` 和 `/release-bundle`。要求实验、复现等仍缺必要参数时，页面给出可编辑 slash 建议而不猜参数。Gate 决策、Brief 确认、Intake adoption 和 Release 决策始终只解释并引导人工处理；blocked、权限不足或歧义输入零副作用。对话和显式 slash 最终调用同一个 canonical operation，因此状态、权限和审计语义一致。

对话在底部时会随新消息保持到底部；向上查看历史后，刷新和新消息不会把内容拉回顶部或强制到底部，使用“跳到最新”恢复跟随。项目、Chat session、主区与 Dock 分别保存自己的查看位置。

Chat 使用直接一级 slash command；不要添加聚合前缀：

~~~text
/new shift-localization
~~~

随后直接在 Chat 回答每个问题；Brief 完整后由 PI 输入 `/confirm-brief`。Scope Gate 创建后到 Approvals 检查 target、范围和预算。Human UI 不要求填写 actor，身份来自当前登录会话。

Chat 输入框支持附件按钮、拖拽和粘贴。一次可以给出多篇论文、代码、数据、图片或历史结果；附件先进入当前 active Intake 的分块上传与静态扫描队列，Chat 只保存引用。Human adoption 完成前，它们不是 Project Artifact、Run、TerminalLog 或 accepted Evidence。MinerU 配置不会自动触发 OCR；OCR 队列/worker 落地前页面不得显示“已 OCR”。

## 4. 调研与 Idea

~~~text
/survey "temporal action localization under domain shift"
/ideas
/ideas generate 3
~~~

Scope 审批后，Overview 的 `survey_run` 主 CTA 会打开当前项目 Chat，并从 Brief problem 预填 `/survey ...`；检查或修改 query 后按 Enter 才开始外部检索。它不是 Runner Job，因此不会把你带到空的 Runs 列表。成功后 Corpus Snapshot 与项目进入 SURVEYING 一起提交，刷新后的主 CTA 变为 `idea_generate`。

SURVEYING 是阶段码，不是“当前有调研任务正在跑”。在快照已冻结且下一步为 `idea_generate` 时，中文页面显示“调研已就绪”；Runs 仍可以是 0，因为这里只记录实验 Job/Run。此时 Runs 空态会说明“调研已完成，尚未创建实验运行”，点击“前往总览”回到权威 NextAction。页面不会为了填充 Runs 而伪造调研任务。

`/ideas` 只查看现有 IdeaCard；它在空列表时不会生成内容。用户直接说“生成几个 idea，用来进行研究”或输入 `/ideas generate 3`，仅当权威 NextAction 精确为 `idea_generate/ready/agent` 且存在非空 frozen Corpus Snapshot 时，Scholar 才调用 DSH 已配置模型生成 1–5 个结构化候选，并以 project revision CAS 和 corpus provenance 一次性写入。数量不符、字段不完整、重复标题、虚构 corpus paper id、模型不可用或 revision 竞争均整批零写。生成后 NextAction 变为 Human `idea_select`；在 Overview 点击某张卡的“选择并审计”，或输入 `/ideas select <idea_id>`，会对该候选执行 connector counter-search，并原子保存 NoveltyAudit、进入 IDEATING、创建绑定该卡的 pending Idea Gate。系统不会自动选择 winner 或批准 Gate；下一步由 PI 在审批页决定。

Overview 展示阶段流水线、Brief（问题与主指标）、NextAction 卡、候选 Idea（点击/双击/右键打开详情弹窗，内含 hypothesis、exact delta、falsification、MVE、novelty audit 与评分）、最近 Contract、预算摘要和审计历史（默认最近 10 条，可展开全部）。Corpus 目前只在项目详情弹窗与 Budget 面板以快照计数展示，最近邻（nearest_prior_works）尚未在 UI 展示。调研来源失败在 connector 层以 `source_status` 记录（api-contracts），不会把部分失败伪装成完整覆盖；当前聊天输出只汇总成功去重后的数量，不逐来源列出失败。选择 Idea 后在 Approvals 决定 Idea Gate。

## 5. Baseline 与 Contract

先登记代码和数据快照，再提交 Baseline。正式 Job 必须来自 CAS 内容、固定镜像和容器；空命令或 message-only 不能成功。

~~~text
/reproduce 10.48550/arXiv.2401.12345
/reproduce arXiv:2401.12345 {"code_snapshot_id":"...","claims":[{"claim_ref":"primary"}],"runner_profile_id":"profile_local_docker_cpu_v1","target_id":"...","metric_comparators":[{"metric_id":"m1","name":"mAP@0.5","expected":58.4,"unit":"%","tolerance":{"absolute":0.5,"relative":0.01}}]}
/reproduce sha256:abcd...   (已扫描 PDF Artifact id)
/contract {"idea_id":"...","dataset_id":"...","baseline":"...","treatment":"...","primary_metric":"mAP@0.5","seeds":[11,23,47,89,101]}
~~~

`/reproduce <doi|arxiv|paper-artifact-id>` 创建或恢复持久化 `PaperReproductionSpec`（spec_id + NextAction），打开 Chat 驱动的复现向导：解析论文标识/上传 PDF → 关联官方或用户上传代码（Git 来源必须固定 exact commit；最终物化为不可变 CodeSnapshot）→ 固定数据（Artifact/hash；无字节时 acquisition recipe + expected hash，clean-room 无法满足即 blocked，不静默跳过）与环境（digest-pinned image、runner profile/target、hash）→ 提取待复现声明 → Human 确认复现计划/合同 → 在选定 Runner 执行 attempt → 比较论文声明目标（先）与 clean-room vs 原正式 Run（单独比较组，两种比较绝不合并为一个 tolerance）→ 生成不可变 ReproducibilityReport（JSON+CAS）。进程 exit 0 只表示执行完成；只有持久化 Report 的所有 required checks pass，`baseline_reproduce` 才能判 done——out-of-tolerance 是 fail/inconclusive，不伪装 code_error。PI 在 Contract Gate 检查 Metric direction、Seed、数据 hash、镜像、预算和 AnalysisPlan。批准后合同版本冻结。

## 6. 运行实验与查看终端

> 服务端/SSE 层已完成:Terminal SSE、seq/gap/reconnect、stdout/stderr 分通道与筛选、安全 ANSI 文本渲染、lease fencing 与 job_log_read AuthZ、cancelled/timed_out/exit 权威终态、最终 log Artifact 与截断记账(tests/unit/terminal.test.ts、tests/security/run-terminal-tests.sh)。仍缺(浏览器层,Playwright 类环境不可用,未验收):严格的有界 DOM 渲染、完整日志 Artifact 下载(当前“Download log”只导出浏览器保留窗口,不等同于完整日志 Artifact;长日志和取消/超时结果必须回到 Runs/Artifact 核对)。

~~~text
/run formal {"contract_id":"...","code_snapshot_id":"...","runner_profile_id":"...","target_id":"..."}
~~~

Runs 显示 queued、running、retryable、succeeded、failed、cancelled。选择一个 Run，点击 Open Terminal 或进入 Terminal Tab：

- All 保持 stdout/stderr 的实际交错顺序；
- stdout/stderr 可单独筛选；
- live 表示正在接收 Runner 输出；
- reconnecting 会自动从最后 seq 续传；
- gap/truncated 表示部分热日志已淘汰，完整或截断日志仍可下载；
- exit code、signal、timeout 和 cancelled 是不同终态；
- Cancel 只有在实际容器停止确认后才显示完成。

页面默认每 8 秒刷新项目投影。聚焦 Chat、搜索框、Workspace/TeX 编辑器或 Interactive Terminal 时，背景刷新不会抢走焦点；编辑控件的刷新会延迟到离开焦点，必要重绘则恢复光标与选区。Terminal/PTY 的实时流不因此停止。若仍观察到焦点或未保存文本丢失，应按 `ui-refresh-focus-stability` 记录页面、控件、时间与是否刚好跨过轮询周期。

Manuscript workspace 在通用 Workspace 页面中应可直接打开 `paper.tex`/`.bib`；文件树能看到但点击 404、出现“文件读取失败”或 `NaN undefined` 都是缺陷。节点大小缺失时安全显示 `0 B`，不会影响打开内容。

终端内容是原始执行数据，不随页面语言翻译。

Run Terminal 可停靠到右侧或底部并继续接收同一 Run 的输出。仅在主区与 Dock 之间移动时，客户端会关闭旧宿主的流并从 `after_seq` 续接；右侧与底部互换不会关闭连接。Run Terminal 仍然只读，能输入命令的是独立的 Interactive Terminal。

当前“Download log”只导出浏览器保留窗口，不等同于完整日志 Artifact；长日志和取消/超时结果必须回到 Runs/Artifact 核对。正式使用前必须等待 TERM-01 标为“已验收”。

### 6.1 Interactive Terminal 与 Workspace

目标 UI 的 Workspace 像 VS Code：Explorer 打开 code/manuscript/scratch 文件，使用标签、搜索、Problems、查看图片/PDF/JSON、编辑文本、上传/移动/删除/历史并冻结 Snapshot。并发冲突会显示 base/current/local，不自动覆盖。**Workspace tree client 逻辑层已实现(2026-08-11,commit 98243ff)**：More →「工作区」面板(#tab=workspace 深链)——workspace 选择器与工具栏(新建文件/新建目录/上传(≤32 MiB multipart)/刷新/路径搜索框);左侧文件树按目录懒展开(implied 目录由文件路径投影、客户端创建的空目录为虚拟节点、文件行 hover 移动/删除);右侧多标签编辑区——每个 tab 持有 path/version/etag/content/savedContent,dirty 语义与 Manuscript 一致(清空读未保存、恢复已保存读干净),保存带 expected_version/etag CAS(409 冲突 → 横幅提示"重新加载",绝不静默覆盖),二进制节点只读显示 meta + 下载(原始字节 + media type),历史版本列表可回退(旧字节以当前 version/etag 守卫写回);树经 workspace watch SSE 流(`…/workspaces/{wid}/watch/stream?after_revision=`)实时增量刷新,流不可用时回退 listSince 每 5s 轮询(离开该 tab 自动停止)。搜索框为客户端路径过滤,尚未接线服务端查询;**服务端已实现路径搜索(prefix/glob)与内容搜索(commit 98243ff)**——POST search `{q, mode:'content'}` 线性文本扫描(文本节点/二进制跳过/每文件 20 匹配/50 文件上限/512 KiB 跳过/大小写可选/非法 UTF-8 容错,无全文索引,大数据集性能受限如实注明;客户端搜索框接入服务端路径/内容模式属后续轮)。剩余(浏览器层,Playwright 类环境不可用,记 NOT_RUN_MANUAL_PENDING):文件树渲染/拖拽上传/多标签视觉/窄屏/键盘 a11y 验收;Problems 面板与集成 PTY 入口。

2026-08-19 更新：Workspace 搜索框已接服务端 content search，按 Enter/搜索按钮返回文件、行号和片段，同时用已提交查询过滤树路径。当前文本标签提供 literal 查找替换。输入过程只更新状态，不重建搜索框或编辑器 DOM，以保持焦点、选区和连续输入。内容搜索仍是有界线性扫描，不宣称全文索引。

点击 Workspace Terminal 打开独立 PTY，选择受控 Runner profile、根相对 cwd 和 shell preset。Interactive Terminal 已使用 xterm-compatible emulator 接到真实 LocalPtyAdapter：聚焦后可输入/粘贴，支持 ANSI/VT/TUI、IME 与自动 fit/resize，输出按 server_seq 增量追加而不因刷新重复。PTY 不是正式 Run，输出不能成为 Evidence。服务端 session context/multi-PTY 绑定、Remote PTY、完整日志下载以及真实浏览器 `WEBTERM_OK`/Unicode/vim/top/Dock/窄屏验收仍分别受 PTY-SESSION-02 与人工队列约束。

Workspace 与 Interactive Terminal 都可以独立停靠；Dock 不改变 Workspace 的 version/etag、编辑 tab 或 PTY 的 session/context。关闭 Dock 等同离开该页面：Workspace watch 会停止，PTY 服务端进程是否继续由 detach/close 与 lease 语义决定，不能用关闭面板代替显式关闭 PTY。

### 6.2 本机与远端执行

Agent 认证心跳会同步 Kernel 的环境状态；未认证或过期仍显示未就绪。长任务期间独立续租与检查取消，Runs 中的取消会终止远端执行；持续断网超过已确认租约时停止进程。完成任务会释放领取容量，产物暂时上传失败可经内存 spool 重试；Agent/Fleet 进程重启会丢失该内存缓冲，不能保证其日志和回执仍在。

执行 target 经项目配置 `execution.runner_target_id`/`execution.runner_profile_id` 选择。先进入 Settings →“实验环境”创建或编辑 target（label、kind、capability、enabled/draining 与 remote SecretRef metadata），再在同一折叠组的“当前项目默认实验环境”选择器保存；页面不输入 SSH 明文、hostname 或任意命令。只覆盖一次运行时，在 `/run` 或 `/reproduce` 的 JSON 中加入 `"runner_target_id":"target_remote_lab_a"`，它优先于项目默认。远端离线时任务明确失败或等待，不会静默改在本机/subprocess 运行。服务端已实现 RUN-REMOTE-01 wire、RemoteFleetServer、RemoteRunnerAgentImpl、持久 Target Registry 和 target-aware claim；真实 mTLS 证书链、跨主机 sandbox/网络分区、Remote PTY 与浏览器视觉验收仍属后续人工阶段。

runner CLI（`node workers/runner-gateway/lib/bin/runner.js`）已接线四个互斥角色（FLEET-01，用法与互斥规则见 remote-runner-wire.md §9）：默认 `--kernel` 本地 claim 循环；`--fleet-server <port>` 启动 Fleet 服务端；`--agent <fleet-url>` 启动已在远端机器上的 Agent；`--agent <fleet-url> --ssh-bootstrap-target <id>` 从受控 SecretRef 通过 SSH 引导远端 Agent。fleet/SSH 角色与本地 `--mode` 互斥；开发 wire 的共享 service identity 只能经 `DSH_SCHOLAR_SERVICE_TOKEN` 环境或受控 0600 配置文件注入，runner 不接受任何 token/service-token/target-token argv；生产必须 mTLS。

受控 SSH 引导（开发/人工验收）在 Fleet 服务端已经可达且其 plan 公钥已保存后运行：

~~~bash
node workers/runner-gateway/lib/bin/runner.js \
  --kernel http://127.0.0.1:7412 \
  --agent https://fleet.example \
  --ssh-bootstrap-target lab-gpu-01 \
  --secret-root /srv/dsh-scholar/secrets \
  --fleet-public-key /srv/dsh-scholar/fleet-public.pem
~~~

`lab-gpu-01` 必须是已登记且启用的 `remote-ssh` target；三个 file SecretRef 分别解析 endpoint JSON（只允许 `host/port/user`）、0600 credential 和预固定 known_hosts。适配器固定 `BatchMode`、`StrictHostKeyChecking=yes`、`IdentitiesOnly=yes`，只启动 `dsh-scholar-runner`，不接受 ProxyCommand、项目 argv 或任意远端 shell。远端主机必须已安装该 runner。直接启动 Agent 时通过 `DSH_SCHOLAR_SERVICE_TOKEN` 和 `DSH_SCHOLAR_RUNNER_TARGET_TOKEN` 注入共享服务身份与此 Target 专属身份；后者必须匹配 Registry 的 service_identity。SSH bootstrap 从同一 Target 的 file SecretRef 解析专属凭据，先在 Kernel 注册 manifest 公钥，再通过加密 SSH stdin 下发密钥与 token（不放 argv），临时密钥文件退出时删除。生产仍必须把 HTTP service-token 链路升级为 mTLS。

## 7. Evidence 与 Claim

普通用户或 Agent 可以创建 draft note，但不能创建 accepted Evidence。Analysis Worker 根据合同、匹配 Seed 和 metrics file 生成 Evidence；Evidence 页面显示 provenance、effect、CI、n 和方向。

缺字段、样本不足、CI 跨无效区间或只使用 draft/legacy Evidence 时 Claim 是 inconclusive。contradicted 和 negative result 会保留在稿件限制与结果中。

## 8. TeX Manuscript Workbench

> 当前已有 TeX 文件树、textarea 编辑、expected_version 保存、构建轮询、诊断列表和 PDF embed。dirty 判断已修复（以文件 GET/最近保存内容为基线，清空非空文件会正确显示未保存）；编译冻结可物化字节（快照按 revision 保存文件内容，Runner 编译输入不会被编译期间的编辑改变）；保存冲突（409）会立即终止编译且不创建 Job；构建卡片显示输入 revision 与 stale 标识，可跳转到同一 Job 的实时 Terminal。**打开/ensure 只读或首次创建（P0-3，2026-08-11 修复）**：进入 Manuscript 页先 GET（只读），工作区不存在才 POST 首次生成；render、轮询、locale 切换、保存后 rerender 都不会改写 `paper.tex`/`main.bib` 或推进 revision；显式“♻ 重新生成”按钮需确认，重写前把当前内容冻结为历史 revision（可回退）。**保存触发实时预览（P0-3）**：保存成功后自动调用 preview-builds hook（服务端 debounce），右侧“实时预览”区展示 pending/queued/running/succeeded/failed/cancelled/superseded 状态、stale 标识与最新预览 PDF。仍缺（UI 浏览器层，Playwright 类环境不可用、未验收，记 NOT_RUN_MANUAL_PENDING）：Manuscript 页内嵌实时 Build Terminal DOM、预览链与 regenerate 对话框的浏览器视觉验收、完整 history/move/assets。以下步骤描述目标 v2，TEX-01/TEX-02 未“已验收”前不得把编辑或编译结果当成正式稿件证据。

### 8.1 生成稿件

~~~text
/write
~~~

系统从 Brief、Corpus 快照、approved Contract、accepted Evidence、Claim 与图表 Artifact 生成 markdown 稿件（含 BibTeX 与图表引用），保存为 paper Artifact 并登记 manuscript 记录；`/write` 默认产出 markdown（`format='latex'` 的 LaTeX 输出同样可用）。TeX 正式编辑与编译请走 Manuscript 工作台（§8.2）。

### 8.2 编辑

进入 Manuscript：

1. 文件树选择 paper.tex、references.bib 或 figures；
2. 编辑器为受控 textarea（显示脏状态；当前文件提供 literal 查找替换；行号/语法高亮仍属目标编辑器能力）；
3. Ctrl/Cmd+S 保存；
4. 如果其他页面已修改同一文件，会出现 version conflict——冲突横幅提示"重新加载"，系统不会静默覆盖（当前无 Copy local / Merge 三方合并交互）；
5. History 可查看过去 revision。

### 8.3 编译与实时预览

保存成功后 UI 自动调用一次 `POST /v1/documents/{id}/preview-builds`（服务端 debounce，默认 800ms，快速连续保存合并为一次 preview）；右侧“实时预览”区轮询 `GET preview-builds` 投影，展示 pending/queued/running/succeeded/failed/cancelled/superseded 状态文本、stale 标识（预览 revision 落后于当前文档）与最新成功预览的 PDF embed/下载。点击 Compile 会先保存全部脏文件，冻结 manifest，再创建权威 latex-compile Job（创建即 supersede 全部非终态 preview；preview 不产 Evidence、不参与权威 manifest 链）。保存失败或 409 时不触发 preview/compile（冲突分支直接返回，不会创建构建 Job）。

Diagnostics 按 error/warning/info 分级着色展示（服务端 tex-diagnostics 解析出 file/line 定位字段，当前 UI 只显示 level+message 文本，"点击跳到编辑器"未接线）。TeX 原始消息保持原文，按钮与诊断类别按页面 locale 翻译。成功后 Preview 显示 PDF。继续编辑源文件时旧 PDF 标记 Stale，直到下一次成功编译。

可以下载 PDF、完整 compile log、sources 和 aux Artifact。HTML 不作为稿件预览。预览/编译状态与 PDF 的同页视觉链（浏览器验收）未执行，记 NOT_RUN_MANUAL_PENDING。

Manuscript 可停靠在右侧或底部；右侧/底部互换不重新创建编辑器或 Preview。离开主区进入 Dock 后仍使用同一文档 revision、dirty 状态与构建投影，关闭 Dock 前应显式保存需要保留的编辑。

## 9. Trajectory 与 Subagent 拓扑

Overview 的 Research Trajectory 显示权威 Gate/Job/Evidence/Manuscript 事件；Session Trajectory 显示 Agent 的消息和工具过程，后者不是科研事实。打开 Agent Topology 可展开 parent→child 直系树并点击进入 child，查看详情（状态/模式/类型/摘要/起止时间/子项数；role、时长、token/cost 与失败等字段尚未在 UI 展示），用 breadcrumb 返回。

one-shot child 只读；follow-up 输入框对子项常显（one-shot 只读，提交后仅返回 message_id，不激活 child；"仅 parent 在线且有权限才出现"的 capability 校验属后续）。读取历史不会唤醒 Agent，原始 prompt、工具参数/结果、环境和 secret 默认不展示。服务端已实现:TRAJ-01/SUBAGENT-01 投影与拓扑 API 层(Outbox 只读投影、redaction、10k 事件分页、exact direct-child、breadcrumb、只读 history、followup 记录 message_id 不冒充执行)。**UI 逻辑层已实现（commit 98243ff）**：More 导航新增「轨迹」（Trajectory，`#tab=trajectory`）与「拓扑」（Topology，`#tab=topology`）两个面板——轨迹面板双泳道渲染 Research（权威）与 Session（观察）事件，每条泳道可「加载更多」分页（服务端 keyset 游标），条目显示 event_seq/时间/脱敏摘要，点击可展开 allowlisted 详情（聚合引用/来源/会话/状态/条目 ID，原始负载永不展示）；轨迹增量经 `…/trajectory/stream?after_seq=&lane=` SSE 流消费（commit d01d415，lane 过滤、entry_id 去重、断线从最后 seq 续传，离开 tab 关闭流），流失败回退 keyset 分页；拓扑面板展示项目子代理直系树（点击节点懒加载其直接子项），「进入 child 详情」后顶部 breadcrumb 可逐级返回 parent，详情含状态/模式/类型与只读历史列表，底部为 one-shot 只读 follow-up 输入框（提交后仅返回 message_id，不激活 child）。剩余（浏览器视觉验收，Playwright 类环境不可用，记 NOT_RUN_MANUAL_PENDING）：双 lane 滚动/虚拟化（10k 节点 DOM 有界）、树展开/键盘/ARIA、follow-up 交互观感。

Trajectory 与 Topology 均可停靠。Trajectory 从主区移动到 Dock 时按最后事件序号续接，右侧与底部互换不重开双泳道流；进入 child 后的 breadcrumb 与展开状态应保持。

## 10. Review 与 Release

> Review/Bundle:REL-01 已关闭(commit 040e796)——build-bundle.sh 生成自包含 Bundle(manifest runtime 段 + TeX workspace 导出),reproduce.sh 在全新空目录以全新 DB/CAS 重放,拒绝指向原 checkout 的 runtime(bundle-only clean-room),并逐字段比较 manifest/metrics/analysis/RunManifest/TeX 输入与 PDF 结构;tests/security/run-release-bundle-tests.sh 已接入聚合器。尚未绑定 CI job 报告前仍不得据此声明正式可复现性。

~~~text
/review
/release-bundle
/release
~~~

Review 检查数字、Claim 状态、引用定位、Artifact hash、TeX 编译、负结果、许可和 AI usage。`/release-bundle` 生成私有自包含 Bundle（`/export` 保留给 DSH Web 下载 Session 日志）；clean-room 重跑实验、分析和 PDF。release 只创建 Human Release Gate，不自动上传外部平台。

## 11. Budget、Settings 与下一步

Budget 页面默认隐藏，可在 Settings → Preferences 的“显示预算页面”启用；该浏览器偏好只控制页面可见性，不关闭预算记账或硬限制。启用后页面显示模型费用、GPU 小时与 API 请求用量，以及项目内容计数（corpus 快照/Idea/Contract/Claim/Evidence/Artifact）与详情弹窗中的约束和策略（数据集、并发上限、执行 profile、网络与完整性要求；内核记账的存储用量字段当前未在 UI 展示）。超过硬上限时项目进入 BLOCKED_GATE，正在运行的策略按 Job contract 安全停止或完成；只有 Human Budget Gate 可恢复到 payload 允许的状态，页面隐藏时仍可从 Overview/Approvals 处理。

Overview 顶部以结构化卡片（GUIDE-01 `next_actions_v2`）展示下一步：每张卡含 code 徽标、三态标记（ready 可执行 / blocked 受阻 / done 已完成——done 灰显、blocked 因缺失前置条件而禁用、ready 高亮）、原因、需要 Human/Agent/Runner 徽标（内核 `required_by` 未声明时不显示）、缺失前置条件列表（点击受阻卡展开）、阻断说明和进入可完成动作界面的按钮（chat/gates/runs/evidence/manuscript/budget 直达，ideas/contracts/release 收敛到总览）。其中 `survey_run` 打开项目 Chat 并预填命令，不自动发送。标签优先按字典翻译，未登记 code 原样显示内核 label；未知状态动作（code='unknown'）只读，不提供猜测的执行按钮。缺失或畸形的结构化动作只显示安全空态，不会从字符串 label 恢复操作。

所有配置集中在 Settings，首次进入时所有分组默认折叠：静态分组为连接 / 外观 / 偏好 / runner / workspace / terminal / TeX / agent / config provenance，另按 ConfigScope 动态生成 global/project/job（保留，无键）/runner-profile/orchestrator/kernel/standalone 七组。每字段显示 effective 当前值、scope、声明来源、安全基线、env 别名、schema 描述与默认；secret 只显示 SecretRef metadata/可用性，明文永不回显。Config Registry 明确返回每个变更的 `hot_applied_keys` 与 `restart_required_keys`，UI 不从 sources 猜测生效方式。所有 Config、MinerU Provider/项目 OCR binding 与 RunnerTarget 变更只通过一次 `POST /v1/settings/transactions` 提交，携带 scope revision CAS；任一操作失败则整单回滚。Project execution/integrity 仍以 canonical Project row 为唯一业务权威，Config layer 仅保存 Settings CAS/audit projection。旧 project execution、Provider、RunnerTarget 和 model-binding direct mutation HTTP routes 已删除；读取路由与 Runner heartbeat 保留。

Panel Dock 的打开页面、首选位置与尺寸通过页面上的 Dock 控件即时配置并只保存在当前浏览器；它们不改变任何 Job/PTY/Build 的 config hash，也不出现在 Settings 的 Kernel Config Registry/config pin 中。

## 11.1 Models & OCR（Model Provider 与项目绑定）

Settings 的「模型与 OCR」组当前提供 MinerU 配置：官方 Open API 默认地址为 `https://mineru.net/api/v4`，可启用/禁用并为当前项目选择 Flash、Pipeline 或 VLM。Flash 可不配置凭据；Pipeline/VLM 必须填写服务端 `SecretRef` 的 scheme/name/version/scope。浏览器不接收任何 secret value，提交 `value`/`token`/`password` 会被拒绝；响应只显示 SecretRef metadata 与 available。Provider 和项目 binding 写入只允许 PI/Operator，revision 冲突会要求刷新。

当前项目只提交 `purpose=ocr`、provider/model ID、binding revision 与本次 Provider revision；endpoint/credential 不进入项目。Kernel 校验 MinerU 固定 descriptor、enabled、模型目录、能力和 Pipeline/VLM SecretRef，并快照 provider revision + config hash。Provider 保存与项目 binding 是同一个 `ocr-mineru` Settings operation；任一步验证或写入失败都会连同同一 transaction 中的其他配置一起回滚，不存在部分保存。

正常 Kernel 服务现在自动消费 `/v2/intakes/{id}/ocr-requests` 队列，无需手动启动 worker。Flash 使用官方匿名轻量 API，Pipeline/VLM 使用官方精准上传/轮询 API；精准模式 token 放在服务端 secret root 内的 0600 普通文件，以 file SecretRef 引用。取消会中止在途调用，正常停止/重启保留同一请求及来源和配置 pin；不会切换模型。Flash 不支持不连续 PDF 页选择；只返回 Markdown 时没有可用的逐页置信度，系统不会虚构。结果始终为 `observed_unverified`。本轮完成生产适配器、启停接线和隔离自动回归；真实 MinerU 服务、配额与识别质量仍是 `NOT_RUN_MANUAL_PENDING`，不能把本地 fixture 当作真实兼容验收。详细限制见 [OCR 规范](init-grill-upload-models.md#51-mineru-生产消费与兼容边界2026-09-06)。

## 12. 常见问题

| 现象 | 说明 |
|---|---|
| container_execution_required | 正式 Job 不能使用 subprocess |
| code_snapshot_required | 先创建真实内容快照 |
| revision_conflict | 项目已被其他动作修改，刷新后重试 |
| document_version_conflict | TeX 文件有并发版本，显式合并 |
| Terminal gap/truncated | 热日志有保留上限；下载最终 log 查看可用内容 |
| Claim inconclusive | Evidence 未 accepted 或缺统计字段 |
| PDF stale | 源文件 revision 晚于 build input，重新 Compile |
| Kernel unreachable | 检查 instance health、dataDir、port 和 sidecar ownership |
| 直接访问 kernel 端口 401 | 共享 Kernel（默认 127.0.0.1:7412，数据目录 `~/.dsh/research-kernel`）受 0600 `<dataDir>/kernel-token` 随机 bearer 保护（env 注入、不出 argv）；除 `/v1|v2/health` 外缺失/错误 token 一律 401。浏览器/BFF 无需关心——BFF 自动带上该 token；仅脚本或 orchestrator 直接访问时需要（kernel/runner 用 `DSH_SCHOLAR_KERNEL_TOKEN`，orchestrator 用 `--token-file` 或同一环境变量）。`x-service-token` 是内部路由专用层，不能替代普通 bearer |
| 页面部分未翻译 | 缺失 key 会显示 key；这是缺陷，应按 docs 规则补资源和测试 |
| intake/proposal stale | 上传接入期间项目或提案已变化，刷新并重新生成 Proposal |
| chunk_gap / chunk_offset_conflict | 分块上传乱序或与已提交 offset 冲突；客户端队列会按 committed offset 顺序续传，刷新后从服务端 offset 继续 |
| upload_quota_exceeded | 单 Intake 预留总量超限（默认 2 GiB、硬上限 10 GiB）；删除/abort 部分上传后重试 |
| secret_value_forbidden | SecretRef 只接受引用元数据；secret 值由服务端解析，绝不提交 |
| provider_url_ssrf_rejected | Provider base URL 命中私有网段或未白名单主机；联系管理员加入 allowlist |
| target offline | 远端 Runner 不可用；等待/修复或显式创建新 attempt，不会自动本地降级 |
| subagent read-only | one-shot、parent offline 或无 follow-up capability，只能查看 |

## 13. 开发者临时 self-mod

仅调试 DSH/Cordis 运行时行为时，按 test-instance-plan.md 创建隔离 DSH_HOME，并显式加载 research-dev-selfmod overlay。可使用 cordis_inspect、cordis_mount、cordis_unmount；动态插件不持久，不能用于 Gate、正式 Run、Evidence 或发布。需要保留的行为必须转成源码、测试和 Markdown。

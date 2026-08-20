# 领域模型与状态机

> 规范性文档。所有外部写入必须由这里定义的 Schema 校验；数据库行和 HTTP 负载不得引入未定义语义。

## 1. 通用约定

- 时间：UTC ISO 8601，数据库保留毫秒；UI 按活动 locale 和 time zone 格式化。
- ID：小写前缀加不可预测后缀，例如 rsp_、gate_、job_、run_、artifact_、claim_、doc_、build_、intake_、adopt_、traj_、node_、pty_。
- Hash：sha256: 加 64 位小写十六进制。
- Revision：从 0 开始的整数，并发修改使用 expected_revision 或 expected_version。
- JSON：安全关键对象拒绝未知字段；自由 metadata 只能放在明确的 metadata 对象中。
- Project ownership：所有业务对象除 BlobObject 外都有 project_id，跨对象引用必须同项目。

## 2. ResearchProject

~~~yaml
project_id: rsp_xxx
name: Example Study
workspace: /display-only/path
mode: gate-only
status: DRAFT
revision: 0
brief:
  problem: required string
  scope: required string
  questions: []
  primary_metrics: []
  target_outputs: [conference-paper]
  target_venue: null
  baseline_repo: null
  domain: machine-learning
constraints:
  datasets: public-only
  external_model_upload: prohibited-for-private-data
  max_model_cost_usd: 250
  max_gpu_hours: 120
  max_parallel_jobs: 4
execution:
  runner_profile_id: null # name-only DRAFT 的显式未配置状态
  runner_target_id: target_local_docker_v1
  network_policy: allowlist
  artifact_store: local-cas
integrity:
  require_baseline_reproduction: true
  require_experiment_contract: true
  require_claim_evidence_links: true
  require_signed_manifest: true
  require_clean_room: true
  automatic_release: false
session_id: optional
dsh_workspace_id: optional
fixture_id: null
created_at: timestamp
updated_at: timestamp
history: []
deleted_at: null
deleted_by: null
deletion_reason: null
~~~

Project name 去除首尾空白后长度 1–120。archive 是可恢复动作；ARCHIVED 项目默认只读，unarchive 恢复 archive 前状态。

Project 另有 `brief_status: collecting | confirmed`。v2 name-only Init 创建 `DRAFT/collecting` 与 active Init Intake，不创建 Gate；数据库中的 collecting placeholder 只用于旧读兼容，不能作为已确认 Brief。PI Grill confirm 在同一事务写 canonical Brief、改为 confirmed 并创建唯一 pending Scope Gate。

删除是独立于生命周期状态的 tombstone 轴，不新增 `DELETED` 状态。只有 `ARCHIVED` 项目可由 PI 删除；请求必须携带 `expected_revision`、精确项目名确认和非空 reason。成功时在同一 Kernel 事务写 `deleted_at/deleted_by/deletion_reason`、递增 revision 并追加 `project.deleted` Outbox。正常列表、读取、投影和全部项目写入必须把 tombstone 当作 404；相同 request id 的重放返回同一 DeletionReceipt。删除不能物理移除 Project、成员、Decision、Outbox、Artifact 引用或共享 Blob；这些记录由 retention/hold 与后续 purge/GC 协议处理。

Project 持久化的 ExecutionConfig 必须显式包含 `runner_profile_id`。name-only `DRAFT/collecting` 使用 `null` 表示“尚未配置”，不能将缺省或 `null` 解析成本机 Docker。任何 Job 执行前都必须解析出已登记的 opaque profile ID；否则以 `runner_profile_required` fail closed 且零落库。旧 `runner_profile` 枚举已经删除，不映射、不迁移；未知或旧枚举值 fail closed。配置不能携带 hostname、SSH command、credential、Docker socket、远端宿主路径或任意 endpoint。下层配置只能收紧资源/网络/交互策略，不能放宽 instance/team policy。

## 3. 状态机

状态全集：DRAFT、SCOPED、SURVEYING、IDEATING、IDEA_APPROVED、CONTRACT_PENDING、CONTRACT_APPROVED、BASELINE_REPRO、EXPERIMENTING、EVIDENCE_READY、WRITING、REVIEWING、RELEASE_READY、RELEASED、BLOCKED_GATE、STOPPED、FAILED、ARCHIVED。

~~~mermaid
flowchart LR
  DRAFT -->|Scope Gate| SCOPED --> SURVEYING --> IDEATING
  IDEATING -->|Idea Gate; freeze selected IdeaCard| IDEA_APPROVED -->|draft Contract| CONTRACT_PENDING
  CONTRACT_PENDING -->|Contract Gate; freeze Contract| CONTRACT_APPROVED --> BASELINE_REPRO --> EXPERIMENTING
  EXPERIMENTING --> EVIDENCE_READY --> WRITING --> REVIEWING --> RELEASE_READY
  RELEASE_READY -->|Release Gate| RELEASED
~~~

通用 transition 允许主路径的非 Gate 状态，以及明确的 Refine、Stop、Fail 路径。SCOPED、IDEA_APPROVED、CONTRACT_APPROVED、RELEASED 永远不能成为通用 transition 的目标。mutation 必须携带 expected_revision；冲突返回 revision_conflict。

## 4. Gate 与 Decision

Gate 类型：scope、idea、contract、budget、release、direction。前五类控制既有 Project/Governance 状态边界；`direction` 是 semantic-only Gate，不直接推进 Project 状态，其 strict payload 只为 Direction adoption 绑定 proposal、source synthesis 与 direction。

~~~yaml
gate_id: gate_xxx
project_id: rsp_xxx
type: contract
title: Approve experiment contract
summary: human-readable summary
target:
  type: experiment_contract
  id: expc_xxx
  version: 1
payload: {}
status: pending
requested_by:
  kind: agent
  id: agent_xxx
created_at: timestamp
decided_at: null
~~~

Decision 必须包含 decision_id、project_id、gate_id、principal、decision、reason、diff、request_id 和 decided_at。principal 至少包含 principal_id、tenant_id、auth_method 和 session_id。reject/revise 必须有 reason。

一个 Gate 只有一个终态 Decision。批准事务同时校验 Principal、冻结 target version、更新 Gate、持久化 Decision、推进 Project revision 并写 Outbox。Principal 必须持久化，不能只存在响应对象中。

## 5. Corpus

Paper 使用规范化 paper_id，优先 DOI，其次 arXiv ID，再用来源 ID。source 是 openalex、crossref、arxiv、semantic-scholar 或 user。Passage 必须携带 paper_id、定位、文本、内容 hash，并固定 is_untrusted=true。

CorpusSnapshot 包含 snapshot_id、project_id、schema_version、查询及时间、每源状态、Paper、Passage、citation_edges、external_claims、coverage 和 frozen=true。创建后不可编辑；新调研产生新快照。任一来源失败必须保存在 source_status。

**现状注记（已实现，commit d960f34）**：v2 形状对齐组（审计报告 §4 #9）已落地——`CorpusSnapshot.schema_version`（默认 1）与 `source_status`（`pending|complete`，默认 `complete` 兼容旧快照）在 `snapshotCorpus` 写入时填充，显式 `source_status='pending'` 用于记录来源失败；`Passage.content_hash` 为**新写必填、旧读兼容**：kernel 快照写入时对每条 passage 强制计算 `sha256(text)`（调用方提供的 content_hash 一律被覆盖，客户端不可声明 hash），验证步骤要求非空（`passage_content_hash_required` 422），旧行（无该字段）仍可解析读取；`is_untrusted` 保持既有语义（默认 `true`，外部内容提示注入标记）。证据：tests/unit/v2-shape.test.ts 15/15（六项正/负向 + 旧数据兼容）、根 pnpm test 692/692。

标题去重顺序为 NFKC、Unicode case fold、字母数字保留、标点和空白归一；不得使用只支持 ASCII 的规则。

## 6. IdeaCard

必填字段：idea_id、project_id、version、corpus_snapshot_id、title、hypothesis、exact_delta、falsification.observation、minimum_viable_experiment、scores 和 status。

MVE 必须包含 dataset_ref、baseline_ref、primary_metric 和 estimated_gpu_hours。Novelty Audit 保存查询、结果、重叠论文和未解决风险。Idea 进入 Gate 前必须绑定冻结 Corpus、至少一个最近邻、明确反证、可执行 MVE 和数据或伦理评估。

**现状注记（已实现，commit d960f34）**：`IdeaCard.corpus_snapshot_id` 已落地（可空，旧卡兼容——无该字段的卡 parse 为 null 且不被 Gate 拦截）。Idea Gate 决策（decideGate 的 idea 分支）执行绑定校验：当 card 携带 `corpus_snapshot_id` 时，snapshot 必须存在（否则 422 `idea_corpus_unknown`）且属于 Gate 所在项目（跨项目 422 `idea_corpus_foreign`，绝不批准）；不携带该字段的旧卡与无 idea_id payload 的 idea gate 原样放行。`createIdea` 接受并持久化 `corpus_snapshot_id`；HTTP ideaSchema 同步放行。证据：tests/unit/v2-shape.test.ts（同项目批准 / 未知 422 / 跨项目 422 / 旧卡放行）。

## 7. ExperimentContract

~~~yaml
contract_id: expc_xxx
version: 1
project_id: rsp_xxx
idea_id: idea_xxx
status: approved
code_snapshot_id: code_snap_xxx
data:
  dataset_id: fixture-v1
  version: v1
  split: official
  artifact_id: artifact_xxx
  preprocessing_hash: sha256:...
methods:
  baseline: baseline_b
  treatment: method_a
metrics:
  primary:
    name: macro_f1
    direction: higher_is_better
    aggregation: mean
    unit: ratio
  secondary: []
seeds: [11, 23, 47, 89, 101]
analysis:
  paired_by: seed
  effect_size: mean_difference
  interval: bootstrap_95
  multiple_testing: holm
stop_conditions:
  max_gpu_hours: 48
  min_completed_seeds: 5
  stop_on_data_leakage: true
tolerances:
  macro_f1:
    absolute: 0.001
    relative: 0.01
runner:
  profile: local-docker-cpu
  image_digest: sha256:...
approval:
  gate_decision_id: dec_xxx
  principal_id: user_xxx
  approved_at: timestamp
~~~

approved Contract 不可原地修改。任何口径、Seed、镜像、数据或主指标变化都创建新版本并重新 Gate。

## 8. Blob、Artifact 与 Snapshot

BlobObject 只有 sha256、size_bytes、storage_uri、created_at，是全局内容对象。ProjectArtifact 包含 artifact_id、project_id、blob_sha256、kind、media_type、file_name、metadata、created_at，是授权和 provenance 单位。

Artifact kind 至少支持 code、pdf、data、log、model、chart、paper、analysis、manifest、bundle、tex-source、bib、compile-log、compile-aux。

**现状注记（已实现，commit d960f34）**：`ArtifactKind` 已扩展 `tex-source|bib|compile-log|compile-aux`（kernel `registerArtifact`、HTTP artifact 路由与 multipart upload 的 kind 校验同步放行，非法 kind 仍 422 `invalid_kind`）。TeX 构建产物按新 kind 注册：runner latex-compile 完成路径把 TeX 日志注册为 `compile-log`（原泛型 `log`）、aux/bbl/blg/fls 打包 JSON 注册为 `compile-aux`（原泛型 `data`），PDF 保持 `pdf`；`tex-source`/`bib` 供显式登记 TeX 源码与参考文献使用。旧 kind（log/data）与旧行为完全兼容。证据：tests/unit/v2-shape.test.ts（四新 kind 注册/回读/HTTP 放行 + 旧 kind 兼容）。

CodeSnapshot 和 TexWorkspaceSnapshot 都保存实际内容的 archive Artifact 与 manifest Artifact。Manifest 文件路径是根相对 POSIX 路径，拒绝绝对路径、..、NUL、设备、FIFO 和越界 symlink。

## 9. Job、Lease 与 RunManifest

Job kind：echo、smoke、baseline、pilot、formal、analysis、reproduce、latex-compile、clean-room。Job status：queued、running、succeeded、failed、cancelled、retryable。项目内 idempotency 唯一键为 project_id + idempotency_key。

JobSpec 至少包含 project_id、contract_id 可选、kind、idempotency_key、command 数组、payload、code_snapshot_id、data_artifact_ids、image_digest、output_contract、max_attempts。正式实验必须有 approved Contract、快照和固定 digest；latex-compile 必须有 TexWorkspaceSnapshot 和固定 TeX image digest。

Job 还必须持久化 created_by_principal_id；researcher 的 own cancel 以此字段判断。full-auto 项目必须有 fixture_id，且所有 Job 绑定同一受信任 fixture profile；无 fixture_id 的 full-auto 创建直接 422。

**现状注记（已实现，commit d960f34）**：`jobs.created_by_principal_id` 已落地（migration 0016 追加列，可空，旧行 NULL 兼容）。`submitJob` 接受可选 `created_by_principal_id` 并落库；HTTP 作业路由从 BFF 注入的 `x-principal-id` 头解析（body 覆写仅供内部调用方），两者皆缺 → NULL；`getJob`/`listJobs` 读回该字段。证据：tests/unit/v2-shape.test.ts（kernel 落库/读回/缺省 NULL + HTTP 头解析 + 裸请求 NULL）。

Lease 包含 owner、generation、opaque token、expires_at 和 heartbeat_at。每次重新 claim 增加 generation 并生成新 token。

RunManifest 必须包含 run_id、project_id、job_id、contract 和版本、代码或 TeX 快照 hash、image digest、数据 hash、命令、Seed、资源、时间、exit_code 或 signal、Artifact 引用、lease generation、runner_key_id、payload hash 和 Ed25519 signature。

### 9.1 RunnerTarget 与 RunnerProfile

`RunnerTarget` 表示一台本机或受控远端执行目标：target_id、kind(`local-process|local-docker|remote-ssh`)、capabilities、health、enabled/draining、revision/config hash、target-scoped `service_identity` SecretRef、SecretRef availability、created_at、updated_at。`service_identity` 把 heartbeat 调用身份服务端绑定到单一 target；共享 internal token、自报 target/principal 都不能替代。`remote-ssh` 是服务端 bootstrap/transport adapter，连接只由 endpoint/credential/known_hosts SecretRef 解析；安全投影不能包含 hostname、私钥、token、ProxyCommand 或任意启动 argv。`local-process` 仅允许 trusted development/smoke，正式 kind 一律拒绝。

`RunnerProfile` 包含 runner_profile_id、target_id、image allowlist/digest、类型化 compute（CPU 或 NVIDIA `all`/设备列表）、network policy、resource limits、artifact transport、interaction policy、config_revision/config_sha256 和 enabled/draining 状态。用户选择的镜像必须由 PI/Operator 写入 RunnerTarget Registry，并在保存时解析为完整 digest；该权威 Registry 是可配置实验镜像的 allowlist。GPU 请求和实际设备与 profile 一起进入 environment pin；preflight 当前只作为 spawn gate，详细报告持久化仍是待实现项。Job submit 固定 profile/config/environment hash；target 变更不会修改已存在 attempt。无 capability、离线或 draining 目标拒绝新 claim；除显式创建新 attempt 外，不得自动从远端回退本机。

ExperimentContract 与 PaperReproductionSpec 的 execution binding 只保存 `runner_profile_id`、`target_id`、environment revision/hash；默认可继承 Project，但在 submit 时必须解析并固化。本机 Docker 与远端 SSH Runner 都是 RunnerTarget adapter；SSH endpoint/credential 只存在服务端 Config/SecretRef。

**现状注记（2026-08-19）**：opaque profile 注册表与 Job 固定 profile/config hash 已落地。ExecutionConfig 的 `runner_profile_id` 是必须存在的键；仅 name-only `DRAFT/collecting` 允许值为 `null`，并持续投影 `runner_environment` 缺口。旧 enum 与 alias 已删除，未知 id 在 createProject 与 submitJob 均 422 `runner_profile_unknown`，未配置 Job 以 422 `runner_profile_required` 拒绝。kernel submitJob 对 secure kinds 固定 profile/config hash，runner 执行前复算，未知 id 或 hash 不一致绝不执行。Runner 环境投影只有在 profile/target enabled、非 draining、kind 匹配、能力匹配，且远端全部 SecretRef 可解析并在 60 秒内有 service-authenticated heartbeat 时才是 ready；unknown/offline/stale 继续显示 `runner_environment` 缺口。配置变更会把 health 重置为 unknown。

**2026-08-15 增量**：上述 `profile_local_docker_gpu_v1` 历史静态记录仍为 CPU-only，不再代表系统没有 GPU 路径。RunnerTarget `runtime_json` 已可固定自定义 digest 与 `{mode:'cpu'}` / `{mode:'nvidia',devices:'all'|数字列表}`；Job、ExecutionPlan、Docker 参数和签名 RunManifest 复用同一 compute pin，远端调度要求 toolkit 与实际设备 capability。真实 Docker/NVIDIA/第二 SSH 主机仍为 `NOT_RUN_MANUAL_PENDING`。

远端 Runner 仍由 Kernel 掌握 Job、Run、lease、budget、Artifact、Manifest 和 Outbox；Runner Agent 只执行冻结 `ExecutionPlan` 并回传事实。每次 claim 返回 Kernel 创建的唯一 run_id，任何 adapter 都不得自行生成替代 run_id。

### 9.2 ConfigDocument 与 SecretRef

`ConfigDocument` 包含 config_id、scope(instance/user/project/workspace/session/target)、scope_id、schema_version、revision、values、created_by_principal、created_at、updated_at。每个字段由 canonical Config Schema 声明类型、默认值、范围、allowed_scopes、secret、hot_reload、restart_required、security_floor 和 UI metadata。未知字段拒绝。

effective config 按 built-in < instance < user < project < workspace < session < target < one-shot job override 合并；只有 Schema 明确允许的 scope 可以覆盖，并且安全字段采用单调收紧规则。每个值保留 source scope/revision。修改必须携带 expected_revision；冲突返回 config_revision_conflict。正在运行的 Job/PtySession/TexBuild 保存 config_revision 和 config_sha256。

`SecretRef` 只有 scheme(keyring/file/vault)、name、version 可选和 scope；普通配置、HTTP 响应、浏览器、argv、日志、Manifest 与 Bundle 都不能出现 secret value。env resolver 只允许显式 allowlist，不是隐含兜底。

## 10. TerminalLog

TerminalLog 是 Job 的有序附属流，不是聊天文本。

~~~yaml
job_id: job_xxx
run_id: run_xxx
seq: 42
stream_seq: 21
channel: stdout
text: "epoch 2...\n"
byte_offset: 8192
created_at: timestamp
lease_generation: 3
~~~

seq 在单个 run 内严格递增，保留 stdout 和 stderr 交错顺序；stream_seq 用于单通道校验。终态 frame 为 exit，包含 exit_code 或 signal、cancelled、timed_out、truncated、total_bytes、dropped_bytes。旧 lease frame 拒绝写入。

日志可有保留上限，但删除必须产生 gap 或 truncated 元数据；禁止静默丢失。最终完整或明确截断的日志保存为 Artifact。

### 10.1 PtySession

PtySession 与 TerminalLog 分离。它包含 pty_session_id、project_id、workspace_id、principal_id、context_kind(operator/research/chat/subagent)、context_id、parent_session_id、runner_profile_id、target_id、purpose(shell/debug/build-terminal)、cwd、argv preset、cols、rows、status、session_generation、lease_token_hash、config_sha256、retained_from_seq、last_event_seq、created_at、last_activity_at、expires_at、closed_at。一个 context 可绑定多个 PTY；所有 control/stream 校验 owner、lease expiry、expected generation 和 exact-parent 权限。

PtyEvent 为 subscribed、data、gap、input_ack、resize_applied、state、exit。data 保存 raw byte length 和安全显示文本；input/resize 使用单调 client_seq 幂等。write、resize、signal、attach 和 close 都重新校验 project membership、terminal_write capability 与当前 session generation/token。断开浏览器连接不会自动杀进程；idle TTL、显式 close、权限撤销或 Operator policy 才结束会话。

PtySession 只用于交互 shell/debug/构建观察，不得作为 Metrics、accepted Evidence 或正式 RunManifest 的数据来源。正式 Job 默认 `input_policy=none`，仍使用 stdout/stderr Run Terminal。

## 11. Evidence 与 Claim

EvidenceItem source_type 为 run、analysis、external-passage、reproduction；provenance_status 为 draft_unverified、legacy_unverified、verified、accepted、rejected。只有 Analysis Worker 服务身份可创建 verified，只有确定性校验与 Auditor 流程可转 accepted。

正式分析 Evidence 至少包含 contract_id、analysis_plan_id、RunSet、Artifact refs、metric direction、baseline 和 treatment mean、effect_size、CI、n_pairs、adjusted_p_value 和 worker provenance。

Claim status：proposed、supported、contradicted、inconclusive、retracted。默认 proposed；验证缺方向、效应、CI、最小样本或 accepted Evidence 时必须 inconclusive。历史追加，不覆盖。

## 12. TeX 文档模型

TexDocument 包含 document_id、project_id、name、root_path、active_manifest_id、revision、last_build_id、created_at、updated_at。

TexFileRevision 包含 document_id、path、kind、version、blob_sha256、media_type、size、author Principal、created_at。kind 为 tex、bib、sty、cls、image、generated 或 other。

保存请求必须提供 expected_version。版本不匹配返回 document_version_conflict，并带 current_version、current_hash 和可选 diff；服务器不能自动覆盖。

TexBuild 包含 build_id、document_id、input_manifest_id、job_id、status、engine、passes、diagnostics、pdf_artifact_id、log_artifact_id、aux_artifact_ids、started_at、finished_at。PDF 是否新鲜由 input_manifest_id 等于 active_manifest_id 决定。

Diagnostic 包含 severity、file、line、column、code、message、raw、pass。用户可见的本地诊断 code 可以翻译；TeX 原始消息必须原样保留。

### 12.1 Project Workspace 与实时 Preview

Workspace 包含 workspace_id、project_id、kind(code/manuscript/scratch)、name、revision、active_snapshot_id、config_revision、created_at、updated_at。WorkspaceFileRevision 包含 workspace_id、path、kind、media_type、size_bytes、version、blob_sha256、author Principal、deleted、created_at；文本和二进制都由 CAS 保存。Workspace mutation 同时校验 expected file version 和 expected workspace revision。

WorkspaceSearch 是短期投影，不是科研权威：请求包含 query、glob、case_sensitive、regex、max_results 和 after_cursor；结果包含 path、version、line、column、preview 和 truncated。Search 只读取调用者可见的当前 revision，并受时间/结果/文件大小上限控制。

TexDocument 绑定一个 `workspace_id` 和根相对 subtree。`TexPreview` 是可取消、可 supersede 的非权威 Build，保存成功后按配置 debounce 触发；它包含 preview_id、document_id、input_manifest_id、input_revision、config_sha256、job_id、status、diagnostics、pdf/log Artifact 与 superseded_by。任何 source revision 变化立即使旧 Preview/PDF `fresh=false`。显式 Compile 创建权威 latex-compile Job；Preview 永远不能直接产生 accepted Evidence。

Generic Workspace 的 public `WorkspaceNode` 使用 `size`（bytes）而非数据库列名 `size_bytes`。manuscript workspace 是 TeX store facade，不是空的 generic workspace：Kernel 在 read/readVersion/blob 以及全部 mutation 前必须先解析 backend；generic store 不存在该 workspace 时必须转到 TeX facade，只有 facade 中也不存在文件才返回 `workspace_file_not_found`。tree 成功而同一节点 read 404 属契约破坏。UI 遇到旧/畸形节点的非有限 size 时降级为 `0 B`，不得把 `NaN` 或未知单位暴露给用户。

### 12.2 PaperReproductionSpec、Attempt 与 Report

论文复现新增三个权威对象：`PaperReproductionSpec` 固定 paper/code/data/claims/comparators/execution/environment 与 revision；`ReproductionAttempt` 固定 Spec/Contract、Job/Run/lease 和全部环境 pin；`ReproducibilityReport` 保存论文目标比较与 clean-room identity 比较、checks、状态、stable error/failure class 和 Artifact refs。完整字段、比较算法与 provenance 见 `reproduction-contracts.md`。

**现状注记（已实现，commit d960f34）**：保存路径已满足 §12 的原子性与可审计要求（TEX-SAVE，审计报告 §4 #3）——`tex-workspace.ts` 的 writeFile/deleteFile/moveFile 把「文件行 + document revision 递增」放在同一单事务内（失败整体回滚，无半写）；每次成功保存后 kernel 追加 `tex.file.saved` Outbox 事件（payload: project_id/document_id/path/revision，request_id/session_id 可透传；409 版本冲突不发事件；delete/move 按设计不发事件）。跨连接取舍见 storage-migrations.md §7 注记：tex store 为独立 WAL 连接，tex 写先提交、outbox 后写，outbox 追加失败记录 error 不阻塞保存。验证：tests/unit/tex-workspace.test.ts（单事务失败路径无半写）、tests/unit/tex-event.test.ts（事件信封/单调 seq/aggregate/revision/409 无事件/outbox 失败不阻塞）。

## 13. Intake、Proposal 与 Adoption

Intake 的完整行为由 research-onboarding.md 定义。存储模型必须至少包含：

- `IntakeSession`：owner/tenant、target project 可选、status、revision、expires_at；
- `IntakeArtifact`：Blob、upload/scan/quarantine 状态、media/magic、parser/version；
- `IntakeObservation`：source locator、detector/version、warnings、`observed_unverified`；
- `IntakeQuestion/Answer`：稳定 question code/revision、required、Human Principal、`human_assertion`；
- `PhaseProposal`：observed_phase、safe_project_status、confidence、gaps、mappings、Gate plan、target revision；
- `AdoptionReceipt/Mapping`：immutable proposal/adoption refs、idempotency hash、创建的 Project/Artifact/Workspace/Gate/Action refs。

Intake status 为 draft、uploading、scanning、needs_input、grilling、proposal_ready、awaiting_human、accepting、accepted、rejected、expired、failed。pre-accept 对象没有 project authority；accepted 不可变。

`ImportedRunObservation` 只有 source log/result Artifact、用户声明、detector output 和 `legacy_unverified` provenance。它不是 Job、Run、TerminalLog 或 RunManifest，不能加入 accepted RunSet。

## 14. NextAction

NextAction 是 Kernel 投影，不是 UI 本地状态（GUIDE-01）。字段：`id`（`${code}:${projectId}` 稳定，ref-bound 覆盖动作追加 ref id）、`code`（稳定机器码：scope_gate_submit / survey_run / idea_generate / idea_gate_approve / contract_register / baseline_reproduce / pilot_formal_submit / evidence_verify / manuscript_write / reviewer_run / release_bundle / release_gate / gate_resolve / budget_resolve / gate_decide / job_retry / project_stop / project_archived / project_released / project_stopped / unknown）、`label`（i18n key 或英文默认文案；legacy `next_actions: string[]` 由此派生）、`reason`（为什么现在做）、`required`（true 或缺失前置项列表，如 `['approved_contract']`）、`route`（chat/gates/runs/evidence/manuscript/budget/ideas/contracts/release/overview）、`capability` 可选（如 researcher/pi）、`revision`（依赖对象版本：gate 决策=project.revision、run 动作=contract version、idea gate=idea version；null=不适用）、`state`（ready=现在做 / blocked=前置缺失 / done=已完成）、`blocking`（是否阻塞阶段完成）、`refs`（gate/job/contract/idea/evidence 权威对象）、`required_by`（human/agent/runner）。`required` 只表达前置条件，不能用来表示执行者；执行者只能读取 `required_by`。

NextAction 只从 Project/Intake 状态、pending Gate、Job/Build 和 unresolved gap 确定性生成；未知 code（`unknown` 退化）只能只读显示。每阶段至少一个动作：confirmed DRAFT→scope_gate_submit、SCOPED→survey_run、SURVEYING→idea_generate/idea_select、IDEATING→idea_gate_approve、IDEA_APPROVED→contract_register、CONTRACT_PENDING→contract_gate_approve 或 contract_register（Gate 被拒绝/要求修改后）、CONTRACT_APPROVED→baseline_reproduce、BASELINE_REPRO→baseline_reproduce+pilot_formal_submit、EXPERIMENTING→pilot_formal_submit+evidence_verify、EVIDENCE_READY→manuscript_write、WRITING→reviewer_run、REVIEWING→release_bundle+release_gate、RELEASE_READY→release_gate、BLOCKED_GATE→gate_resolve（+budget_resolve）、FAILED→project_stop、ARCHIVED/RELEASED/STOPPED→done。pending gate 产生 gate 决策动作（budget→budget_resolve，其余→gate_decide，base 已引用不重复）；失败/retryable 作业产生 job_retry（attempts 耗尽→blocked+repair_decision）。Intake/Grill 覆盖动作包括 `intake_resume`、`intake_scan`、`intake_answer`、`intake_propose`、`intake_adopt`；collecting DRAFT 不得产生 `scope_gate_submit`。所有非终态投影必须满足进展不变量：存在 pending Human Gate，或至少一个非 done 动作为 ready；禁止全部 blocked 的闭环依赖。

`CONTRACT_APPROVED` 的 `baseline_reproduce` 同时承担执行前交接投影：尚无 baseline Job 时，它是 Runs 中可见但不计入 Job 统计的准备任务。`required` 可以列出 `baseline_command`、`code_snapshot`、`runner_environment` 等缺口；动作保持可进入 Chat/Workspace/Settings，以便 Agent 与用户消解缺口，不能因缺口把整个项目变成无入口的全 blocked。准备任务不是 Job、Run 或 Evidence，不拥有伪造的运行状态。只有 `startBaselineRun` 成功后才创建 Job 并原子推进 `BASELINE_REPRO`。

`startBaselineRun` 是 Contract→Execution 以及 matched-seed baseline 追加运行的唯一入口：输入固定 expected project revision、approved contract id、CodeSnapshot id、非空 argv、可选整数 seed、至多一个同项目 Data Artifact、可选 Runner target/image override、output contract 和 project-scoped idempotency key；输出同时包含 queued Job 与 Project。seed/Data Artifact 必须进入请求 hash、Job payload、`data_artifact_ids` 与签名 RunManifest，不能只由命令字符串间接表达。首次调用在同一事务创建 Job 并推进 `CONTRACT_APPROVED→BASELINE_REPRO`；后续调用仅可绑定首个 baseline 的同一 Contract，保持 Project 阶段/revision 不变。普通 Job API 不接受 baseline。Kernel 在同一事务验证合同归属/批准状态、代码快照与 Data Artifact 归属、Runner/Profile/target、镜像 pin、预算与状态。任一校验或状态迁移失败均回滚 Job、Event 和 Project 更新；相同幂等键只返回原 Job，不创建第二次运行。

SURVEYING 的 Idea 子流程按权威数据细分：没有 proposed IdeaCard 时为 Agent `idea_generate`；已有候选但尚未选择时为 Human `idea_select`，refs 列出候选 idea，不能再次误报“需要生成”。选择操作完成真实 counter-search NoveltyAudit 后，由 Kernel 原子写入 audit、推进到 IDEATING 并创建 payload 绑定所选 idea 的 pending Gate。IDEATING 只有在 pending Idea Gate 存在时才投影 `idea_gate_approve`；禁止 orchestrator 预先创建 payload-less Idea Gate。

没有 proposed IdeaCard 并不足以让 `idea_generate` ready：还必须存在同项目、frozen、source complete 且 `papers.length>0` 的 Corpus Snapshot，动作 refs 固定该 snapshot。缺少时 `idea_generate` blocked (`frozen_nonempty_corpus_snapshot`)，并同时投影 ready `survey_run` 作为修复入口，保持非终态进展不变量。

`survey_run` 不是 Runner Job：它由当前项目 Chat 的 `/survey <query>` 驱动 connector 并冻结 Corpus Snapshot，因此 route 必须是 `chat`，不能把用户导航到没有 Job 的空 Runs 列表。浏览器 CTA 只预填由 Brief problem 得出的 slash command，必须由用户确认发送，不能因打开卡片自动产生外部检索副作用。SCOPED 项目第一次成功冻结 Corpus Snapshot 时，snapshot、`SCOPED→SURVEYING` 与对应 Outbox 必须在同一事务提交；随后只有 complete/frozen/non-empty snapshot 才把 `idea_generate` 置为 ready；空或未完成 snapshot 必须继续给出 `survey_run` 修复动作。其他状态补充/重做 Corpus Snapshot 不擅自改变阶段。

Project `status` 是研究阶段标记，不是活动任务计数。首个冻结快照完成后的 `SURVEYING` 表示“调研语料已就绪，等待或正在执行 `idea_generate`”，不能翻译成暗示 connector 仍在运行的进行时。Runs 只投影持久实验 Job/Run；`SURVEYING + frozen Corpus + jobs=[]` 是合法组合，UI 必须明示“调研已完成、尚未创建实验运行”并导航到 Overview 的权威 NextAction，不得伪造 Job/Run 或用 Runs 计数推断 connector 是否活动。若未来 connector 改为长时任务，必须引入独立的 ConnectorActivity/Action 投影，仍不能冒充实验 Run。

### 14.1 Project Chat Turn 与 Intent

`ChatTurn` 是 project/session-scoped 交互记录，不是 Project state、Evidence 或 Decision。输入分为 `direct_command | grill_answer | natural_turn`；`natural_turn` 的解析结果 `ChatIntent` 至少包含 `intent_code`、canonical command/operation 可选、confidence/ambiguity、effect(`read|agent-write|human-only`) 和基于哪一个 `NextAction.id/revision`。普通文本不能被默认拼成 slash，也不能因无法识别而显示“未知命令”。

Natural turn 只可在当前 Kernel projection 声明的 route/capability 内自动路由。只读查询可直接执行；明确的 Agent 动作以本次 Human 发送作为意图确认，但仍执行相同 ACL/idempotency/revision；Human-only、Gate、Brief confirm、adoption、release decision、blocked/unknown/ambiguous intent 永远只返回候选与页面导航。assistant 回答必须带最新 `next_actions_v2` 的阶段引导；LLM 文本只是非权威说明，不得生成或覆盖 Project status、Decision、Run、Evidence。显式 slash 与 natural intent 必须共享 canonical operation，不能出现两个语义不同的 `/new`、`/reproduce` 或 `/status` adapter。

`ScholarSessionWorkspace` 是 DSH Host 的安全视图，不是 Project 子对象或第二套业务状态。它由 exact `session_id`、脱敏 `ScholarSessionProjection` 和未关联时的 `ScholarProjectSummary[]` 组成。已关联时 options 必须为空；未关联 options 只包含稳定 DSH 操作员拥有 membership 的未删除项目。`session-bind` 只建立不存在的 exclusive link，同 pair 重试幂等，任何改绑、悬空/墓碑 link、归档或跨 Principal 项目拒绝；`session-create` 只创建 name-only Init 并原子绑定。workspace 不保存 transcript、附件、secret、provider 配置或 reasoning，session 切换必须取消旧读取/写入且迟到结果不得回写。

### 14.2 Model Provider、Binding 与 OCR Request

`ModelProvider` 是 global/instance 资源，字段为 provider_id、display_name、kind、base_url、enabled、capabilities、models、可选 credential SecretRef、revision、created_at、updated_at。响应永不包含 secret value。缺省 credential 表示显式 no-auth；无效持久化 metadata 必须 fail closed，不能降级成 no-auth。首个内置种类 `mineru` 固定 id、官方 API origin 与 `flash/pipeline/vlm` 目录；Flash 可无 credential，Pipeline/VLM 绑定要求 SecretRef。`ProjectModelBinding` 只保存 project_id、purpose、provider_id、model_id、provider revision/config hash 与自身 revision；写入同时 CAS binding revision 并核对期望 provider revision。

`OcrRequest` 是下一阶段对象，当前尚未实现。目标字段包含 request_id、project_id、intake_id、source_artifact_id、provider_id、model_id、status、page/language options、config_revision/config_sha256、result_artifact_id、safe_error、created/updated/finished_at。未来 OCR 输出只能以 `observed_unverified` Observation 保存，每个候选携带 source/page/locator/confidence/model/version；它不能成为 Human answer、Gate、Run 或 Evidence。

## 15. Trajectory 与 Subagent Node

`TrajectoryRoot` 包含 trajectory_id、project_id、source(kernel-outbox/dsh-session/external)、source_ref、status、first/last event seq、created_at、retained_until。`TrajectoryNode` 包含 node_id、parent_node_id、relation(root/child/fork)、kind(session/subagent/task/research-event)、mode(one-shot/continuable/read-only)、status、label、safe summary、timing、四桶 token、cost、permissions、retention 和业务 refs。

`SubagentAddress` 固定为 parent_session_id + child_session_id + mode；调用 history/followup 时三者必须共同校验。one-shot 和 parent unavailable 节点只读。普通 fork 的后代不计入 subagent chain；orphan/cycle 只影响展示，不能破坏读取投影。

`TrajectoryEvent` 以 trajectory_id + event_seq 唯一，包含 event_id、version、project/node/parent、type、source、occurred_at 和有界安全 payload。Research Trajectory 可由 Kernel Outbox 重放；Session Trajectory 可过期并产生 redaction/gap。两者不是互相的权威副本。

## 16. Budget

预算记录 model_cost_usd、gpu_hours、api_requests、storage_bytes 和 updated_at。增量必须非负并在事务内原子累计。越限时同一事务把项目置 BLOCKED_GATE、创建 Budget Gate 并写 policy.violation Outbox。恢复状态只接受 Gate payload 中经过校验的 resume_to。

**现状注记（已实现，commit d960f34）**：`BudgetRecord.storage_bytes` 已落地（默认 0，旧行兼容；migration 0016 追加 `budget.storage_bytes INTEGER NOT NULL DEFAULT 0` 列）。`recordUsage` 接受 `storage_bytes` 并在同一事务内与 model_cost_usd/gpu_hours/api_requests 原子累计（非负增量）；`getBudget` 读回该字段；HTTP budget 路由与 budgetSchema 同步放行。证据：tests/unit/v2-shape.test.ts（累计/读回/legacy 行 0 + HTTP 放行）。

## 17. Outbox Event

事件包含 event_id、project_id、kind、source、payload、created_at、delivered_at。业务事务和对应事件原子提交。消费是 at-least-once，消费者按 event_id 去重。

事件族：project.*、gate.*、artifact.*、job.*、terminal.*、corpus.*、idea.*、contract.*、evidence.*、claim.*、manuscript.*、tex.*、budget.*、policy.*、intake.*、adoption.*、session.*。DSH SessionEvent 可承载展示和关联事件，但 Kernel Outbox 始终是科研业务审计权威。trajectory.* 是可重建投影通知，不能反向替代对应业务事件。

## 18. Methodology 与 Knowledge 对象

### 18.1 AssuranceAudit

AssuranceAudit 用三条独立轴描述审查：execution=`queued|running|succeeded|failed|cancelled|timed_out`，verdict=`PASS|WARN|FAIL|NOT_APPLICABLE|BLOCKED|ERROR`，acceptance=`pending|provisional|accepted|rejected|stale`。它必须绑定 project、audit kind、target refs、不可变 findings Artifact、input SHA-256 pins、assurance level 和 reviewer independence。

`NOT_APPLICABLE` 是存在且新鲜的正式 verdict；missing Audit 不是 N/A。input pin 变化只把 effective acceptance 变成 stale，不修改旧 Audit。semantic Audit 的 deterministic reviewer 非法；same-model/same-family 最多 provisional，submission 级 accepted 需要 cross-family 或 human。Assurance acceptance 不替代 Gate Decision。

### 18.2 ProtocolRevision 与研究循环

ProtocolRevision 在正式/confirmatory Run 前冻结 hypothesis、prediction、variables、metrics、stopping conditions 和 Contract/Code/Data/Environment pins。当前 strict enum 为 Run intent=`exploratory|confirmatory`、outcome=`positive|negative|mixed|inconclusive`、validity=`valid|invalid|infrastructure_failure|integrity_blocked`；三者与 Job execution 正交。negative scientific result 不是 Job failure，infrastructure failure 不能制造 NegativeFinding。

`RunOutcomeObservation` 是 Kernel 从 terminal Job/Run 派生的 immutable execution fact，不是科学结论。它固定 project/job/run、attempt、lease generation、manifest hash、Protocol pin、intent、execution/failure class，并作为 append-only outbox event 与 Job/Run completion 原子提交。`ResearchRunClassificationWriteRecord` 只允许授权调用者提供 scientific outcome/validity、analysis Artifact 与 Evidence refs；Kernel 从 observation 反查其余字段并记录分类 principal。未分类观察投影 `run_outcome_classify`，同一 run 只能消费一次，stale binding、late attempt 和冲突重放 fail closed。

`SynthesisRecordRequest` 是确定性 trigger 产生的 fan-in 请求，不是 `ResearchSynthesis` 内容。它固定 request id、trigger run、fan-in 窗口内完整且唯一的 `source_run_refs`、Project revision 与 NextAction revision；分类、classified event 和 request 原子提交。pending request 投影 `synthesis_record`。ResearchSynthesis 写入必须显式携带一个仍 pending 的 request id，并逐项匹配 project、event window、snapshot pin、当前 Project/NextAction revision 与完整 source Run 集；unknown/stale/substituted binding 零写。成功后该窗口才算消费。该请求不修改 Project phase、Gate、Claim、Evidence 或 Release，full-auto 不自动执行科学分类或合成内容。

InnerLoopCycle 是已批准边界内的 Protocol→Run→Measure→Record 投影，不是 Project phase。ResearchSynthesis 以 typed header + Artifact body 汇总 verified facts、negative findings、contradictions、open gaps 和 inferred relations。DirectionProposal 只提出 `deepen|broaden|pivot|conclude|pause`；DirectionAdoption 复用现有 Human/Gate/NextAction 权限，不能自动修改 Scope 或 Contract。

Direction continuation 是由 `Project + pending Gates + Methodology stream` 重建的 NextAction overlay，不是持久化状态机。freshness 同时固定 Project revision、当前基础 NextAction revision、source Synthesis、proposal↔synthesis id 与 input hash；错误或 stale binding 只留下 diagnostic action。需治理的 Proposal 绑定唯一专用 Direction Gate。adopted Proposal 按 direction 确定性映射到 `direction_deepen_continue|direction_broaden_intake|direction_pivot_intake|direction_conclude_prepare|direction_pause_review`；其中 broaden/pivot 只建议进入现有 Intake proposal/adoption 流程。Methodology revision、Project revision 与 Intake revision 各自保持原有职责，不互相冒充。

### 18.3 方法与知识 Pack

`KnowledgePackageManifest`、`KnowledgePackageEvaluation`、`KnowledgeActivationRequest` 与成功 Activation receipt 共同固定 package identity、content hash、来源、许可、输入输出 Schema、requested/granted capabilities、project/session/phase/NextAction revision 与撤销判断。Instruction Pack 只包含 Scholar 自有或独立转写并测试过的可信方法；External Knowledge Pack 始终是不可信、只读、带来源资料。二者不能在读取或激活时互相降级/升级。

ReverseOutline 与 ReviewFinding 必须绑定 TeX revision 和 input hashes；文稿变化后旧结果 stale，不能自动应用到新 revision 或直接覆盖 canonical TeX。Research Graph 由 Protocol、Synthesis、Direction/Adoption 及其 typed Claim/Contract/Run/Evidence/Data/Environment refs 确定性重建，边区分 `explicit|inferred`；它没有独立 revision、表或 mutation 权限，冲突 pin 与跨项目输入 fail closed。

### 18.4 当前持久化与权威边界

`AssuranceStore` 把 Audit 与 acceptance 作为独立事件写入 `assurance_events`。`MethodologyStore` 把 ProtocolRevision、ResearchSynthesis、DirectionProposal/Adoption、成功 Knowledge Activation、ReverseOutline 和 ReviewFinding 写入 project-scoped `methodology_project_events`，把 global Package/Evaluation 写入 `methodology_registry_events`。三个账本均 append-only；Store revision 只是方法论事件流 CAS，不替代 Project revision。

这些对象仍是 non-authoritative proposal/diagnostic/audit facts；HTTP/Client、Research Graph 或 compact UI 的存在不提升其权威性。`ResearchKernel.submitJob(...)` 当前会在 formal 或 `run_intent=confirmatory` 时读取 project-scoped frozen Protocol，用权威 Contract/Code/Data/Environment/Runner/预算边界调用 run-admission evaluator，并在拒绝时保持 Job/Run/outbox 零写；被接收的 Job 持久化 `protocol_pin` 与 `run_intent`。Direction adoption adapter 从 durable PI 派生 Human actor，以当前 Project/NextAction revision 调 evaluator，并从 durable approved Decision 的 `gate_id` 读取同项目专用 `direction` Gate；Gate payload 必须 strict 绑定当前 proposal id、source synthesis id 和 direction，Decision principal 还必须是当前项目 Human PI/operator。只有该 verified receipt 可授权需 Gate 的 adoption；成功也只追加 `DirectionAdoption`，不直接修改 Project/Scope/Contract。NextAction 重建不会把 Adoption 的 receipt ref 当作权威结论，而会重新 join durable Decision/Gate 并验证同项目、approved 与 exact payload，失败只给 diagnostic。

compact Assurance 通过 Store 投影复用 `verifyAssurance(...)`，并解析当前可用的 input hashes；Writing compact projection 从 live TeX tree 与当前 Claim–Evidence 关系生成 hash 后复用 `assessWritingMethodology(...)`。同一 compact wire 进入 standalone surfaces 与 exact-session DSH Scholar summary，但只读展示不等于 Gate、submission 或 TeX authority。五个 DSH methodology tool 只解析调用 session 的持久项目绑定；Knowledge activation 额外要求 Host confirmation 与显式 Human activation。

真实本机 Docker formal positive fixture 已证明 `RunManifest.run_id`（不是 `job_id`）是 classification 的 `run_ref`，且请求不能回传/覆盖 observation 中的 execution/intent/Protocol。当前仍缺的是远端 SSH/GPU、生产 Docker 的科学分类/NegativeFinding 场景、真实 reviewer/model、pack payload 注入/撤销、自动 Release，以及真实浏览器/ARIA/TeX 验收。Kernel 已持久化 execution observation 与授权 scientific classification，但“由机器从执行状态自动判定科学结论”明确不属于领域契约。此前八个没有 runtime consumer 的方法论配置键不属于领域状态，也未在 Config Registry 注册；未来只有在 consumer、持久化与来源 parity 同时存在时才可新增。

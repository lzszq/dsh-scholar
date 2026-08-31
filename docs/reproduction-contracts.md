# 论文复现生成契约

> 规范性文档。论文复现不是一次普通 Job，也不是“命令退出 0 即成功”。实现必须从本文件生成/校验 Schema、API、存储、命令、UI、报告与验收；当前代码只有通用 baseline/reproduce Job 和非持久化指标比较，不能宣称完整论文复现已经实现。

## 1. 用户入口与边界

推荐入口是一级 slash command：

~~~text
/reproduce <doi|arxiv|paper-artifact-id>
~~~

所有功能子项直接使用 `/new`、`/status`、`/confirm-brief`、`/run`、`/evidence`、`/write`、`/release` 等一级命令。DSH 与 standalone 都不注册、不解析或兼容旧聚合 descriptor/prefix；旧形式返回 unknown command，且不得进入帮助、补全、文档示例或新 provenance。

`/reproduce` 创建或恢复 `PaperReproductionSpec`，打开 Chat 驱动的复现向导：解析论文标识/上传 PDF → 关联官方或用户上传代码 → 固定数据与环境 → 提取待复现声明 → Human 确认复现计划/合同 → 在选定 Runner 执行 → 比较论文目标与本次结果 → 生成报告。Agent 可以准备计划、提交 Job 和解释差异，不能批准 Gate、伪造 RunManifest、把 Interactive PTY 输出当正式结果或把“接近”改写为成功。

Chat composer 支持附件按钮、拖拽和粘贴文件。附件复用当前项目的隔离 Intake、多文件分块上传、scan/OCR 与 provenance；消息只保存安全 attachment ref。扫描/Human adoption 前不得成为 Project Artifact、CodeSnapshot、实验输入或 Evidence。

## 2. 核心对象

### 2.1 PaperReproductionSpec

必填字段：spec_id、schema_version、project_id、owner Principal、source paper ref、source artifact/locator、reproduction_level、claims_to_reproduce、code source、data inputs、execution binding、environment lock、expected outputs、metric comparators、revision、status、created/updated_at。

source paper ref 接受 DOI、arXiv ID 或已扫描 PDF Artifact；外部 metadata/full text 均为 untrusted。代码必须最终物化为不可变 `CodeSnapshot`，只给 repo URL/branch/tag 不可执行；Git 来源固定 exact commit、submodule commits、license 和 snapshot hash。数据固定 Artifact/hash、version/split/license/preprocess hash；无字节时必须提供允许联网获取的 acquisition recipe + expected hash，clean-room 无法满足时 blocked，不静默跳过。

`reproduction_level`：

- `baseline_official`：复现论文官方主结果；
- `contract_rerun`：按批准 ExperimentContract 重跑；
- `clean_room`：新 dataDir/runner、无 checkout/CAS 隐式依赖的独立重建；
- `manuscript`：同时重建表格、图和 PDF；
- `bundle_only`：仅验证 Bundle 结构/hash，不等同科学复现。

### 2.2 EnvironmentLock 与 ExecutionBinding

`execution_binding.target_id` 必须解析到 RunnerTarget Registry 中 enabled、非 draining 且与 runner profile 类型兼容的目标。创建/更新 Spec 与启动 attempt 都必须重新核对 target revision/config hash；EnvironmentLock 中冲突、伪造或过期的 pin 一律拒绝，目标变更后不能静默回退本机，只能显式更新 Spec 或创建新的 attempt。

实验/复现只能选择 opaque `runner_profile_id` 与 `target_id`。Target adapter 首版为 `local-docker` 或 `remote-ssh-runner`；SSH host/port/user/private key/jump host/known-hosts/mTLS material 只存在服务端 Settings/SecretRef，不进入 Project、Spec、Contract、Job、ExecutionPlan、argv、浏览器、日志或 Bundle。

EnvironmentLock 至少固定：image digest、OS/arch、runtime 与 dependency lock hash、CUDA/driver/GPU capability（如适用）、dataset/code hashes、runner profile revision/hash、target revision/hash、effective config revision/hash、network/resource policy、tool versions和 SBOM ref。Node/TeX 等运行时必须使用仓库 canonical baseline 与 digest-pinned image，不能用 mutable `latest`。

本机 Docker、远端 SSH Runner 或 scheduler 使用同一 ExecutionPlan/lease/RunManifest/Artifact 接口。target offline/draining/capability mismatch 明确 blocked/retryable；禁止静默回退到本机、subprocess 或另一个 Target。用户可显式新建 attempt 并选择不同环境，新 attempt 保留原绑定和差异原因。

### 2.3 ReproductionAttempt 与 ReproducibilityReport

每次 attempt 固定 spec revision、approved Contract/version、Job/Run/lease、CodeSnapshot、data/image/environment pins 和 submitter Principal。正式 execution 必须在隔离容器或受控远端 Runner 中运行，输出只从声明的 output contract 采集。

`ReproducibilityReport` 为不可变 JSON + Markdown Artifact，字段至少包括：report_id/spec_id/attempt_id、paper/claim refs、status（pass/fail/blocked/inconclusive）、preflight、runtime_verified、environment declared/used、RunManifest refs、metrics/table/figure/PDF comparisons、checks、missing/extra outputs、failure_class、stable error code、retryable、generated_by/tool versions、created_at。报告先比较论文声明目标，再单独比较 clean-room 与原正式 Run；两种比较不能合并为一个 tolerance。

## 3. 指标与产物比较

每个 metric 固定 name、unit、direction、aggregation、expected value/CI、absolute/relative tolerance、seed policy、n 和 source locator。比较规则：

~~~text
allowed = max(absolute_tolerance, abs(expected) * relative_tolerance)
pass = finite(actual) && unit_match && abs(actual - expected) <= allowed
~~~

expected=0 时 relative 部分为 0，由 absolute tolerance 决定；NaN/Infinity、缺失/重复 metric、unit/aggregation/direction 不匹配均不能 pass。方向不是替代误差比较。表格按稳定 row/column key 比较；图先比较生成数据/hash，视觉相似度只能作为附加诊断；manuscript level 必须重建 TeX/PDF 并做结构/文本/font/页数检查，缺输入不能当 skipped-pass。

Job exit 0 只代表 execution succeeded。只有持久化 Report 的所有 required checks pass，`baseline_reproduce` NextAction 才能 done；out-of-tolerance 是科学结果 fail/inconclusive，不伪装为 `code_error`。环境、资源、代码、数据、timeout/cancel、provenance missing、metric mismatch、runtime mismatch 和 report mismatch 使用稳定 error/failure class 与 retryability。

## 4. API、存储与权限

目标 API：

- `POST/GET /v2/projects/{project}/reproduction-specs`
- `GET/PATCH /v2/projects/{project}/reproduction-specs/{spec}`（revision CAS）
- `POST /v2/projects/{project}/reproduction-specs/{spec}/attempts`
- `GET /v2/projects/{project}/reproduction-attempts/{attempt}`
- `POST /internal/reproduction-attempts/{attempt}/reports`（verifier service identity）
- `GET /v2/projects/{project}/reproduction-reports/{report}`

存储新增 reproduction_specs、reproduction_attempts、reproduction_reports 与 source/material links；Report 内容进入 CAS，行保存 hash/ref。所有 project/global ID 先解析 project 再 AuthZ。Plan/Contract approval、Report accepted promotion、clean-room/release Gate 为 Human/verifier 能力；Agent tool 不含 accept/decision。idempotency、revision、attempt generation、lease token 和 signed RunManifest 全部 fencing。

RunManifest 必须补齐 project/spec/attempt、source commit + CodeSnapshot hash、data/image/environment pins（含 exact Project effective `config_pin`）、seed、requested/allocated resources、exit code 或 signal、timeout/cancel cause、output refs、runner key/signature和 lease generation。`config_pin` 必须与 Kernel 提交 Job 时固定的 `payload.project_config_pin` 逐字节一致；lease token、SecretRef 解引用值及其他凭据绝不进入 Manifest/Bundle，secret-free allowlisted argv 或 command digest 才能进入 Manifest。

## 5. UI、NextAction 与 i18n

首版不新增顶栏大页：`/reproduce` 和 Chat 附件进入 Intake/复现向导；Overview 展示 reproduction NextAction，Runs 展示 attempt/environment pins 和 Run Terminal，Evidence 展示 Report/差异，Workspace 展示采用的代码/配置，Manuscript 展示表/图/PDF重建。需要专属详情时使用深链 `#tab=runs&reproduction=<spec_id>`。

NextAction code 至少包括 `reproduction_materials_collect`、`reproduction_plan_confirm`、`reproduction_environment_select`、`reproduction_run`、`reproduction_compare`、`reproduction_report_review`、`reproduction_retry_or_repair`。动作携带 spec/attempt/report refs、required_by、revision、blocking 和 route；UI 不按文案猜状态。

所有 slash command 名保持稳定不翻译；命令 description、表单、附件状态、environment selector、指标差异、报告状态/error、CTA、aria 提供 zh/en key。语言切换不丢 command draft、附件队列、spec 编辑或 target selection。

## 6. Session-scoped Terminal

每个权威 Research/Chat/Subagent session 可绑定零到多个 PTY；Terminal 不是 project 级单例。`PtySession` 增加 server-derived context_kind（research/chat/subagent）、context_id、purpose 和 parent_session_id；客户端不可伪造任意 child/session，也不存在 Operator context 或 project fallback。服务端提供按 project/context 列表、open/attach/detach/close，所有 control/frame/stream 携带 expected generation 并校验 owner、lease expiry、generation 和 exact-parent capability。

UI 为每个 context 保存 PTY 标签集合和 active PTY，支持 `#tab=pty&session=<pty_id>`；Chat/Topology 的“打开终端”只打开对应 context 的 PTY。切换 Chat/Subagent/项目不会复用旧输入目标。远端 PTY 使用同一 owner/generation/token/target fencing。Interactive PTY 永远不生成正式 Metrics/RunManifest/Evidence；正式论文复现输出只来自 Job/Run Terminal 与 output contract。

## 7. 验收与当前状态

自动契约至少覆盖：Spec strict schema/canonical hash；DOI/arXiv/PDF provenance；CodeSnapshot/data/env pins；typed profile/target only；unknown/offline target no fallback；zero-safe per-metric comparator；missing/unit/NaN/table/figure/PDF negative；attempt/report idempotency/revision/generation；project isolation；secret/SSRF/SSH credential negative；NextAction；一级 slash help/complete/execute parity；Chat attachment quarantine；session→multi-PTY binding与 stale generation。

真实 Docker、远端 SSH/mTLS、私有论文/数据、GPU、TeX/PDF、2–10 GiB 附件和真实浏览器统一进入 manual acceptance。通过前 hardening 状态只能是“未实现/部分/已实现未验收”；当前通用 baseline Job、release script 或退出 0 不计完整论文复现 PASS。

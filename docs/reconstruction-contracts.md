# 可生成契约、固定参数与宿主 ABI

> 规范性文档。本文件消除其他文档中的示意值。生成器应把这里的类型转成 Zod、JSON Schema/OpenAPI 和 TypeScript；三者必须由同一源生成。

## 1. 版本与 ABI

规范版本 2.3，Kernel protocol v2，初始数据库 schema v2；新增能力以追加 migration 升级 schema revision，不能改写初始 migration。

DSH 兼容基线：

| 项 | 固定值 |
|---|---|
| repository | DeepSeek Harness / @deepseek-ai/dsh-root |
| local reference commit | 895a2f84133204c92ad3d62297fbb63af182b94f（仅开发参考，不构成安装兼容性 PASS） |
| root version | 0.0.1 |
| cordis peer | >=4.0.0-rc.7 |
| schemastery peer | >=3.18.0 |
| required host modules | @deepseek-ai/dsh-tools、@deepseek-ai/dsh-commands、@deepseek-ai/dsh-skill-filesystem |
| optional host module | @deepseek-ai/dsh-llm（Agent/tool 内容块类型；缺失时不影响 standalone 与紧凑 session workspace） |
| optional dev module | @deepseek-ai/dsh-tool-cordis |

构建仓库必须生成 packages/dsh-host-compat：只暴露本项目使用的 Context、Tool、Command 和 Session 类型。该模块不暴露 HttpServer、Slot、LocaleFace 或 ThemeFace。contract test 可对本地固定 commit 和最小 fake host 运行以加速反馈，但它们不是发布兼容性证据。插件集成兼容性必须从配置的私有 registry 在全新目录安装固定版本的真实 `@deepseek-ai/*` 包，使用全新 `DSH_HOME` 通过公开 DSH CLI/Profile/Cordis 生命周期完成加载、启动和 dispose。源码 checkout、symlink、伪造 host、`file:` override 或仅安装 Scholar tarball 均不得替代该证据。升级 DSH 版本时先更新本文件、锁定 spec 和兼容测试。

## 2. 固定 ID 与 canonical JSON

- 业务 ID：prefix + base32(lowercase, no padding) 的 128-bit crypto random；测试注入 deterministic ID source。
- event_id 和 request_id 同规则；不得使用时间戳作为唯一性来源。
- canonical JSON：UTF-8、对象 key 递归字典序、数组保持顺序、无额外空白、有限 JSON number；签名、hash、RNG seed 均使用同一编码。
- Hash：SHA-256(canonical bytes)，wire 为 sha256:<64 lower hex>。

## 3. 固定资源上限

| 参数 | desktop 默认 | 最大可配 |
|---|---:|---:|
| JSON body | 16 MiB | 32 MiB |
| inline HTTP upload | 32 MiB | fixed |
| staged Artifact total | 512 MiB | 10 GiB（cluster） |
| staged upload chunk | 8 MiB | 32 MiB |
| snapshot files | 20,000 | 100,000 |
| snapshot single file | 64 MiB | 2 GiB |
| snapshot total | 2 GiB | 100 GiB |
| Terminal hot retained bytes/run | 8 MiB | 64 MiB |
| Terminal rendered lines | 10,000 | 50,000 |
| final log bytes/run | 64 MiB | 1 GiB |
| SSE connections/user | 4 | 16 |
| SSE connections/project | 16 | 128 |
| TeX files | 2,000 | 10,000 |
| TeX single text file | 8 MiB | 32 MiB |
| TeX total workspace | 512 MiB | 2 GiB |
| page limit default/max | 50 / 200 | fixed |
| connector query limit | 20 | 100 |
| Intake total bytes | 2 GiB | 10 GiB |
| Intake archive entries | 20,000 | 100,000 |
| Intake expanded bytes | 20 GiB | 100 GiB |
| PTY sessions/user/project | 2 / 4 | 8 / 32 |
| PTY retained bytes/session | 4 MiB | 32 MiB |
| Trajectory page/virtual threshold | 50 / 100 | 200 / fixed |

超限使用明确 413/422，不做隐式截断；Terminal retention 是唯一允许的有标记截断。

## 4. 完整状态转换矩阵

Gate type 有五种；Gate 控制的目标状态有四个。Budget Gate 不进入新“批准状态”，它从 BLOCKED_GATE 恢复到记录的 resume_to。

| From | To | 触发者 | 前置/副作用 |
|---|---|---|---|
| DRAFT | SCOPED | Scope Gate transaction | approved human decision |
| DRAFT | STOPPED/FAILED | PI/Kernel policy | reason required |
| SCOPED | SURVEYING | Orchestrator/Director | corpus action created |
| SURVEYING | IDEATING | Orchestrator | frozen corpus exists |
| SURVEYING | STOPPED/FAILED | PI/Policy | reason |
| IDEATING | IDEA_APPROVED | Idea Gate transaction | target Idea version frozen |
| IDEA_APPROVED | CONTRACT_PENDING | Contract draft transaction | approved Idea 生成 Contract，创建 payload-bound Contract Gate |
| CONTRACT_PENDING | CONTRACT_APPROVED | Contract Gate transaction | target Contract frozen |
| CONTRACT_PENDING | IDEA_APPROVED/IDEATING/STOPPED | revised/rejected workflow | 重起草 Contract、新 Idea 或停止 |
| CONTRACT_APPROVED | BASELINE_REPRO | Orchestrator/Director | approved Contract 绑定的 baseline action created |
| BASELINE_REPRO | EXPERIMENTING | Orchestrator/Director | baseline succeeded within tolerance |
| BASELINE_REPRO | IDEATING/FAILED/STOPPED | PI/Policy | refine/failure reason |
| EXPERIMENTING | EVIDENCE_READY | Orchestrator | minimum runs and accepted Evidence |
| EXPERIMENTING | IDEA_APPROVED/STOPPED/FAILED | PI/Policy | refine/stop/fatal |
| EVIDENCE_READY | WRITING | Orchestrator/Writer | TexDocument created |
| WRITING | REVIEWING | Orchestrator/Writer | latest TeX build succeeded |
| REVIEWING | WRITING | Reviewer | major revision |
| REVIEWING | RELEASE_READY | Orchestrator | review and clean-room pass |
| RELEASE_READY | RELEASED | Release Gate transaction | human approval |
| RELEASE_READY | WRITING/ARCHIVED | PI | revision or private archive |
| any non-ARCHIVED | ARCHIVED | PI | no running jobs; otherwise 409 |
| ARCHIVED | previous_status | PI | stored pre_archive_status, no stale Gate |
| ARCHIVED | tombstoned | PI Human BFF | exact name + reason + expected_revision；写 project.deleted，正常读取变 404 |
| any active | BLOCKED_GATE | Kernel policy transaction | budget/data/security Gate + resume_to |
| BLOCKED_GATE | resume_to | Budget/policy Gate transaction | resume_to must equal saved allowed state |
| terminal status | none | none | RELEASED/STOPPED/FAILED remain read-only except archive；删除只接受已经 ARCHIVED 的项目 |

通用 transition 只允许表中触发者含 Orchestrator/Director/Writer 的非 Gate 行。PI stop/archive 走专用 BFF route；Policy block 走内部事务。

Gate Decision 效果：

| Gate | approved | rejected | revised |
|---|---|---|---|
| scope | DRAFT→SCOPED，冻结 Brief revision | DRAFT→STOPPED | 保持 DRAFT；旧 Gate 终态；保存新 Brief 后显式创建新 Gate |
| idea | IDEATING→IDEA_APPROVED，冻结 Idea version | 保持 IDEATING，target Idea 标 rejected | 保持 IDEATING；产生新 Idea version 后创建新 Gate |
| contract | CONTRACT_PENDING→CONTRACT_APPROVED，冻结 Contract | 保持 CONTRACT_PENDING，target 标 rejected | 保持 CONTRACT_PENDING；新 Contract version 后创建新 Gate |
| budget | BLOCKED_GATE→saved resume_to，并更新 limits/reservation | 保持 BLOCKED_GATE | 保持 BLOCKED_GATE；新预算提案创建新 Gate |
| release | RELEASE_READY→RELEASED | 保持 RELEASE_READY/private | RELEASE_READY→WRITING，创建 revision action |

每次 Decision 都使旧 Gate 终态并写 gate.decided；revised 不原地重开 Gate。只有 approved 进入四个 Gate 控制状态或预算 resume。

## 5. Wire 基础类型

~~~typescript
type ProjectMode = 'gate-only' | 'full-auto'
type GateType = 'scope'|'idea'|'contract'|'budget'|'release'|'direction'
type GateDecision = 'approved'|'rejected'|'revised'
type JobStatus = 'queued'|'running'|'succeeded'|'failed'|'cancelled'|'retryable'
type JobKind = 'echo'|'smoke'|'baseline'|'pilot'|'formal'|'analysis'|'reproduce'|'latex-compile'|'clean-room'
type EvidenceProvenance = 'draft_unverified'|'legacy_unverified'|'verified'|'accepted'|'rejected'
type MemberRole = 'pi'|'researcher'|'operator'|'auditor'|'viewer'

interface Principal {
  principal_id: string
  tenant_id: string
  auth_method: 'dsh-session'|'standalone-local'|'sso'|'service-mtls'
  session_id?: string
  service_id?: string
}

interface PageRequest { cursor?: string; limit?: number }
interface Page<T> { items: T[]; next_cursor: string | null }
interface ErrorEnvelope {
  ok: false
  error: { code: string; message: string; request_id: string; retryable: boolean; details?: Record<string, unknown> }
}
interface JobExecutionLimits {
  timeout_seconds:number
  cpu:number
  memory_bytes:number
  pids:number
  max_log_bytes:number
  log_overflow_action:'terminate'|'drop'
}
~~~

Zod 对象默认 strict。metadata、payload、details 是唯一允许 passthrough JSON 的位置，且有 256 KiB 编码上限。

full-auto 只接受 fixture_id 非空且已登记的 FixtureProfile。FixtureProfile 固定 code/data/image/expected outputs、禁止 secret/private data/external release，并强制 automatic_release=false。Project create 和 Job submit 都校验 fixture_id；fixture Job 不得引用 profile 之外的 Artifact。

HealthResponse：

~~~typescript
interface HealthResponse {
  ok:true
  instance_id:string
  protocol_version:'v2'
  schema_version:2
  database_id:string
  capabilities:{
    terminal_stream:true
    interactive_terminal:true
    workspace_files:true
    tex_workspace:true
    latex_compile:true
    latex_live_preview:true
    remote_runner:true
    config_registry:true
    research_onboarding:true
    trajectory:true
    subagent_topology:true
    signed_manifest:true
    clean_room:true
    locales:['zh','en']
    locale_contract_revision:1
  }
  time:string
}
~~~

Sidecar 只复用 protocol_version、schema_version、database_id 和预期配置都匹配的 instance。runtime/endpoint.json 原子写为 {protocol_version:'v2',instance_id,host,port,unix_socket:null|string,database_id,token_file,started_at}，权限 0600；client 先读该文件再 health。port=0 只以此文件中的实际 port 为准，10 秒未出现或 health 不匹配即启动失败。

## 6. 分页、ETag 与幂等

- 列表稳定排序：created_at DESC、ID DESC；特殊列表可声明 updated_at DESC，但必须写在 route schema。
- cursor 是 base64url(canonical JSON {v:1, sort_time, id, filter_hash})；filter_hash 与当前 query 不同返回 invalid_cursor。
- 分页不保证数据库快照隔离，但稳定 keyset 保证不重复；新插入可能出现在下一次从头刷新。
- ETag：双引号包围资源 version/hash，例如 "tex:doc_x:path:7:sha256..."。
- 修改优先使用 body expected_version；If-Match 可携带同一 ETag，两者同时存在必须一致。
- Idempotency-Key 长度 1–200，同一 project/key 且 request hash 相同返回原响应；hash 不同返回 409 idempotency_conflict。

## 7. AuthZ 能力矩阵

| 能力 | pi | researcher | operator | auditor | viewer |
|---|---|---|---|---|---|
| project_read | yes | yes | yes | yes | yes |
| member_manage | yes | no | no | no | no |
| gate_decide | yes | no | no | no | no |
| job_submit | yes | yes | yes | no | no |
| job_cancel | yes | own | yes | no | no |
| job_log_read | yes | yes | yes | yes | no |
| document_write | yes | yes | no | no | no |
| evidence_note | yes | yes | no | no | no |
| evidence_review | yes | no | no | yes | no |
| audit_read | yes | no | no | yes | no |
| trajectory_summary_read | yes | yes | yes | yes | yes |
| trajectory_detail_read | yes | yes | no | yes | no |
| subagent_continue | yes | yes | no | no | no |
| terminal_write | yes | yes | yes | no | no |
| intake_create | yes | yes | no | no | no |
| intake_accept | yes | no | no | no | no |
| release_decide | yes | no | no | no | no |

Project creator 成为 pi。成员管理：GET/POST/PATCH/DELETE /bff/research/projects/{id}/members；最后一个 pi 不能删除或降级。standalone local identity 仅在 loopback 映射为单一 pi。

Route policy：所有 /v2/projects/{id} GET 需要 project_read；project mutation 需要 pi 或文档明确能力；Job submit/cancel/log 使用 job_submit/job_cancel/job_log_read；Document read/write/build 使用 project_read/document_write/job_submit；Gate Decision 使用 gate_decide；Release Decision 使用 release_decide；成员 route 使用 member_manage。全局 ID route 先解析其 project_id，再执行相同能力检查，不因知道 ID 绕过。/internal/v2 只接受对应 service identity：Runner 只能 claim/heartbeat/frames/artifact stage/complete，Analysis Worker 只能写 verified Evidence，Verifier 只能把验证通过的 Evidence 转 accepted，并持久化 service Principal/request_id；Human Auditor 只能提交 evidence review request。

## 8. BFF base path

客户端逻辑路由统一写 /v2 或 /bff/research。运行形态改写：

| 形态 | 浏览器 base | 转发 |
|---|---|---|
| standalone | 空字符串 | 同源直接提供 /v2 和 /bff/research |
| internal worker | http://127.0.0.1:<kernel> | 直接 /internal/v2；浏览器不可达 |

`/research-api` 和 `/research-ui-api` 是已删除的 DSH 嵌入面，必须返回 404。目标客户端只使用 standalone 同源逻辑路由。

## 9. Internal Artifact staging

Runner/Worker 使用服务身份和 lease token：

1. POST /internal/v2/jobs/{job}/artifact-stages
   请求 kind、media_type、file_name、expected_size、expected_sha256、lease generation/token；响应 stage_id、upload_url、expires_at。
2. PUT /internal/v2/artifact-stages/{stage}/content
   原始 bytes，支持 Content-Range；每块和总字节有限制。
3. POST /internal/v2/artifact-stages/{stage}/finalize
   服务端复算 hash/size，事务创建 ProjectArtifact；响应 ArtifactRecord。
4. DELETE /internal/v2/artifact-stages/{stage}
   abort 幂等。

Stage state 为 open、finalized、aborted、expired。upload_url 是同一 internal origin 的相对路径，必须继续携带 Runner service auth 和 lease token，不是公开 pre-signed URL。Content-Range 使用 RFC 9110 inclusive bytes start-end/total；chunk 必须从当前 committed offset 开始。完全相同 offset/hash 的重传返回当前 offset，重叠内容不同或 gap 返回 409 upload_offset_conflict；同一 Stage 只允许一个写者。finalize 在 bytes=expected_size 时可调用，重复 finalize 返回同一 Artifact；abort 重复 204，finalized 后 abort 409。Stage 绑定 project/job/run/generation，过期或旧 lease 409，TTL 默认 1h。未 finalize Blob 在 24h 后 GC。complete 只接受同 Job 已 finalize Artifact。

## 10. Terminal frame wire schema

~~~typescript
type TerminalFrame =
 | {kind:'chunk'; job_id:string; run_id:string; seq:number; stream_seq:number; channel:'stdout'|'stderr'; text:string; byte_offset:number; byte_length:number; lease_generation:number; time:string}
 | {kind:'gap'; job_id:string; run_id:string; seq:number; requested_after:number; retained_from_seq:number; dropped_bytes:number; lease_generation:number; time:string}
 | {kind:'exit'; job_id:string; run_id:string; seq:number; exit_code:number|null; signal:string|null; cancelled:boolean; timed_out:boolean; truncated:boolean; total_bytes:number; dropped_bytes:number; lease_generation:number; time:string}
~~~

POST terminal-frames 接受 {frames: TerminalFrame[]}，1–256 个，总 JSON <= 1 MiB。SSE data 使用完全相同对象。订阅要求 job_log_read。

## 11. TeX 文件操作

- POST /v2/documents/{id}/files：multipart 或 JSON text；path、kind、expected document revision。
- POST /v2/documents/{id}/moves：{from_path,to_path,expected_source_version,expected_document_revision}，单事务插入新 path revision 和旧 path tombstone。
- POST /v2/documents/{id}/assets：multipart binary，要求 document_write，单文件/总量按固定上限。
- PUT/DELETE：document_write；Build：document_read + job_submit。
- 响应统一返回 document_revision、file、active_manifest_id=null（表示需重新 snapshot）。

~~~typescript
type TexFileKind = 'tex'|'bib'|'sty'|'cls'|'image'|'generated'|'other'
interface TexFileRef { path:string; kind:TexFileKind; media_type:string; size_bytes:number; version:number; sha256:string; deleted:false }
interface TexMutationResult { document_id:string; document_revision:number; file:TexFileRef; active_manifest_id:null; etag:string }
interface CreateTexFileInput { path:string; kind:TexFileKind; media_type:'text/x-tex'|'text/x-bibtex'|'text/plain'; content_utf8:string; expected_document_revision:number }
interface SaveTexFileInput { content_utf8:string; expected_version:number; expected_document_revision:number }
interface DeleteTexFileInput { expected_version:number; expected_document_revision:number }
interface MoveTexFileInput { from_path:string; to_path:string; expected_source_version:number; expected_document_revision:number }
type TexEngine = 'pdflatex'
type BibliographyEngine = 'bibtex'|'biber'|'none'
interface TexBuildInput { expected_document_revision:number; root_file:string; engine:TexEngine; bibliography:BibliographyEngine; max_passes:2|3|4; idempotency_key:string }
interface TexDiagnostic { severity:'error'|'warning'|'info'; file:string|null; line:number|null; column:number|null; code:'latex_error'|'undefined_citation'|'missing_file'|'overfull_box'|'shell_escape_denied'|'raw'; message:string; raw:string; pass:number }
interface TexBuildView { build_id:string; document_id:string; input_manifest_id:string; job_id:string; status:JobStatus; engine:TexEngine; bibliography:BibliographyEngine; passes:number; diagnostics:TexDiagnostic[]; pdf_artifact_id:string|null; log_artifact_id:string|null; aux_artifact_ids:string[]; fresh:boolean; started_at:string|null; finished_at:string|null }
~~~

POST files 使用 application/json 的 CreateTexFileInput；PUT/DELETE/moves 使用对应 JSON。POST assets 使用 multipart 字段 path、kind=image|other、expected_document_revision、file，单文件 <=32 MiB。冲突 Error details 固定为 {expected_version,current_version,current_sha256,current_etag}。path 校验失败 invalid_path；不支持媒体 unsupported_media_type；Build root 不存在 tex_root_not_found。Diagnostic message 是安全摘要，raw 是受长度限制的原始一行并只以 text node 显示。

## 12. Analysis 固定算法

Canonical wire 类型：

~~~typescript
interface MetricSpec { name:string; direction:'higher_is_better'|'lower_is_better'; aggregation:'mean'; unit?:string }
interface MetricsFileV1 { schema_version:1; run_id:string; contract_id:string; seed:number; metrics:Array<{name:string; value:number; unit?:string}> }
interface PerRunMetric { run_id:string; seed:number; metric_value:number; code_snapshot_sha256:string; data_hash:string }
interface RunSet {
  run_set_id:string; contract_id:string; method:'baseline'|'treatment'; metric:MetricSpec; runs:PerRunMetric[];
  validation:{seeds_unique:true; min_completed_met:true; same_code_snapshot:true; same_data_hash:true}
}
interface AnalysisPlan {
  analysis_plan_id:string; contract_id:string; metric:MetricSpec; paired_by:'seed';
  baseline_run_set_id:string; treatment_run_set_id:string;
  method:{estimator:'paired_mean_difference'; interval:'bootstrap_95'; resamples:10000};
  multiple_testing:'holm'; minimum_n:number
}
interface PairedAnalysisResult {
  metric:string; direction:'higher_is_better'|'lower_is_better'; baseline_mean:number; treatment_mean:number;
  paired_mean_difference:number; effect_size:number; ci_low:number; ci_high:number; n_pairs:number;
  raw_p_value:number; adjusted_p_value:number; direction_ok:boolean
}
interface AnalysisEvidenceDraft { contract_id:string; analysis_plan_id:string; run_set_ids:[string,string]; artifact_refs:string[]; result:PairedAnalysisResult; provenance_status:'draft_unverified'; generated_by:'analysis-worker'; worker_image_digest:string; generated_at:string }
interface AnalysisOutput { schema_version:1; plan_id:string; result:PairedAnalysisResult; evidence_draft:AnalysisEvidenceDraft }
~~~

MetricsFile 每个 metric name 唯一，value 必须 finite；RunSet 按 seed 升序 canonicalize。PairedAnalysisResult 和 JSON key 顺序严格按接口声明顺序；AnalysisOutput 顺序为 schema_version、plan_id、result、evidence_draft。NaN/Infinity/missing/duplicate 全部拒绝。零差值的 direction_ok=false，raw p=1；Holm ties 按 metric name 升序，adjusted p 单调 step-down 并 cap 1。

AnalysisPlan.minimum_n 必须等于 Contract stop_conditions.min_completed_seeds，不能由调用者降低。Primary 和每个 Secondary metric 各生成独立 AnalysisPlan/AnalysisOutput，之后的多重检验步骤读取同一 Contract version 下全部结果；不得把不同 metric 塞入一个 Result。

- primary estimator：按 Seed 配对的 treatment - baseline；lower_is_better 只影响 direction_ok，不反转保存的原始差值。
- n_pairs >= contract.stop_conditions.min_completed_seeds；重复/missing/non-finite 直接 validation error。
- baseline_mean/treatment_mean/difference 使用 IEEE-754 double，结果 JSON 数值在序列化前保留 12 个有效小数、round-half-to-even；-0 序列化为 0。
- bootstrap resamples 默认且生产固定 10,000；每次对 n 对 difference 有放回抽样并取 mean。
- RNG seed：FNV-1a 32-bit(UTF-8 canonical JSON of plan + ordered run IDs + metric values)，PRNG 为 mulberry32。
- 95% percentile CI：排序 bootstrap means，low index=floor(0.025*(B-1))，high index=ceil(0.975*(B-1))。
- 双侧 p 值：令 B=10000，pLow=(1+count(boot<=0))/(B+1)，pHigh=(1+count(boot>=0))/(B+1)，raw_p=min(1,2*min(pLow,pHigh))；多指标按 metric name 排序后 Holm step-down。
- effect_size 字段为 paired_mean_difference；未来标准化 effect 需新 schema version。
- contract.tolerances 为 metric name -> {absolute?: number, relative?: number}；至少一个非负值。Baseline 和 clean-room pass 取 max(absolute, abs(expected)*relative)。
- 输出 key 顺序固定，时间由调用者提供；golden vector 存 tests/fixtures/analysis-v1.json。

## 13. Runner profile 与镜像锁

生成 configs/runner-profiles/images.lock.json，内容由显式 bootstrap 命令解析一次并提交：

~~~json
{
  "schema_version": 1,
  "node_fixture": "node@sha256:<resolved node:22-alpine digest>",
  "texlive": "<approved TeX Live image>@sha256:<digest>"
}
~~~

缺 digest 时 build 可以生成 lock proposal，但 formal/CI 必须 fail。desktop profile：1 CPU、1 GiB memory、256 pids、/tmp 64 MiB、默认 timeout 60s；latex profile：2 CPU、2 GiB、512 pids、timeout 300s；GPU 合同显式覆盖但仍固定 digest。

Golden fixture 由 evals/golden-path-v2/fixture-repo 和公开小数据组成；规范生成器必须保留 deterministic metrics fixture、3 个 Seed、expected analysis vector 和 TeX fixture。若仓库没有这些文件，acceptance preflight 失败，不得自动下载未知代码。

## 14. Connector 固定接口

~~~typescript
interface SearchOptions { limit: number; from_year?: number; to_year?: number; timeout_ms: number }
interface SourceStatus { source:'openalex'|'crossref'|'arxiv'; status:'ok'|'failed'; error_code?:string; retryable?:boolean }
interface SearchResult { papers:Paper[]; queries:QueryRecord[]; citation_edges:CitationEdge[]; dedup_removed:number; source_status:SourceStatus[] }
~~~

默认 limit 20、timeout 20s、每来源最多 2 次重试（429/5xx/network，指数退避 + jitter），非 retryable 4xx 不重试。单次研究快照只取每源第一页，下一版本才能改变分页策略；这保证 fixture 可复现。parser_version 进入 cache key 和 QueryRecord。

## 15. Orchestrator 运行契约

CLI 参数：--kernel、--token-file、--db、--poll-ms=5000、--owner、--lease-seconds=60、--once、--dry-run。一个 Project Phase Controller 通过 orchestrator_leases(project_id,owner,generation,expires_at) 选主；实验 Job 仍可并行。

**现状（本轮已实现）**：orchestrator CLI 全参数已实现——--kernel/--db/--poll-ms/--once/--dry-run/--owner/--lease-seconds/--token-file（Config Registry orchestrator scope，parseCli 接入，bin 保留 --poll-ms>0 检查）；ActionStore（orchestrator_actions，SQLite）与幂等推进已实现，新增 orchestrator_leases 表（project_id PK、owner、generation、expires_at）：engine 每轮 claim（INSERT OR IGNORE、同 owner 续约 generation+1、过期抢占 generation+1、他人 live lease 持有则跳过该项目不静默双推进）、每轮 refresh、close() 释放全部持有租约；--token-file 读取 0600 kernel bearer token 并附 Authorization 头（缺失文件 fail fast）；owner 缺省 orch-<hostname>-<pid>。证据：tests/unit/orchestrator.test.ts 41/41（含选主抢占/过期/释放/跳过/Authorization 用例）。

Action 包含 action_id、project_id、phase、type、idempotency_key、status、attempt/max_attempts、depends_on、input_refs、output_refs、lease、error、created/updated。执行前 running+lease 事务提交；外部写用 action key；恢复先查询 Kernel projection，对已存在输出标 done，否则 retry。永久 validation/policy 错误 blocked，环境错误有界 retry。

## 16. Outbox envelope

所有事件：{event_id,event_seq,event_version:1,project_id,kind,aggregate_type,aggregate_id,aggregate_revision,source,request_id,session_id?,payload,created_at}。SQLite 单写事务分配 event_seq=max+1，PostgreSQL 使用 sequence；同 aggregate revision 以 event_seq 排序，跨 aggregate 不保证业务因果。消费者以 event_id 去重，失败记录 attempts/last_error/next_attempt_at；超过 20 次设置 dead_lettered_at 并进入 dead-letter projection，但不删除原事件。

## 17. 工具 Schema 生成规则

每个 DSH Tool 直接映射一个 v2 client method。工具 parameters 从相应 Zod input 自动导出 JSON Schema，移除 Human-only、internal、principal 和 provenance override 字段；output 从响应 Schema 导出。tool-schema snapshot 测试覆盖所有注册名。

工具目录只注册 canonical 名 `claim_verify_request`、`analysis_request`、`release_bundle_request`。已废弃的 `claim_verify`、`analysis_build`、`release_bundle` 不注册、不授权，也不提供兼容 adapter；调用方必须升级到 canonical 契约。

Canonical Tool registry（共 40 个实际可调用名称；表中以 `/` 并列的每一项都是独立工具）：

| Tool | Client method / action |
|---|---|
| dsh_scholar | 当前 DSH session 的一般研究 façade；只执行受控 name-only create 与 authoritative ready survey，其余写动作建议/阻断/Human-only |
| research_project | action=create/list/get/projection；映射 projects create/list/get/projection |
| research_phase | project transition；to enum 排除 Gate 控制状态 |
| research_gate_request | action=create/list；gate-requests/gates |
| research_budget | action=read/record；budget projection/usage request |
| research_status | project projection |
| research_methodology_status | 从当前 DSH session link 读取 compact methodology projection |
| research_protocol_record | 对当前 session-bound project 追加 strict ProtocolRevision，使用 methodology stream CAS |
| research_synthesis_record | 对当前 session-bound project 追加 strict agent-generated ResearchSynthesis |
| research_writing_review_record | 对当前 session-bound project 追加 revision/hash-bound ReverseOutline 或 ReviewFinding |
| research_knowledge_activate | 当前 session-bound project 的显式 Knowledge Pack activation；要求 Host confirmation 与 Kernel resolver 全通过 |
| research_intake_begin / research_intake_stage / research_intake_scan / research_intake_answers / research_intake_propose | 五个独立 prepare-only Intake 工具；只输出 observation/question/proposal，不提供 accept/adopt/Decision |
| literature_search | Connector search，不写 Kernel |
| paper_resolve | Connector resolve |
| corpus_snapshot | Connector search + create corpus snapshot |
| passage_lookup | frozen corpus passage read |
| research_panel | DSH subagents panel，输出仅 draft |
| idea_create / idea_compare / novelty_audit | Idea create/list comparison/novelty route |
| workspace_snapshot | code snapshot create；workspace 必须预登记 |
| patch_apply | 对 project-scoped `workspace_id` 内单个文本节点应用 unified diff；Kernel read/write/delete + version/etag CAS，拒绝宿主路径、多文件、二进制、rename/copy |
| baseline_prepare | `POST /v1/projects/{id}/baseline-runs` 原子校验 approved Contract、CodeSnapshot、非空 argv、可选 seed/单个同项目 Data Artifact、Runner target/profile、output contract、expected revision 与幂等键；seed/Data pin 进入 request hash、Job 与签名 Manifest；首个运行同事务创建 queued Job 并推进 `CONTRACT_APPROVED → BASELINE_REPRO`，后续 matched-seed 运行绑定同一 Contract 且保持阶段/revision；禁止普通 Job submit |
| test_run | Job submit with constrained `smoke` / `analysis` kind |
| baseline_verify | analysis request against Contract tolerance |
| experiment_register | Contract draft create |
| experiment_submit / experiment_status / experiment_cancel | Job create/get/cancel request |
| evidence_note_create | public draft_unverified note route |
| claim_create | Claim draft create |
| claim_verify_request | Claim verification request |
| analysis_request | Analysis Job request |
| manuscript_build | manuscript draft / TexDocument create |
| manuscript_review | manuscript review projection |
| release_bundle_request | release bundle request |

Tool input 不接受 principal、verified/accepted provenance、internal token、host path 或 arbitrary URL。普通 role-scoped tool 的 project_id 省略时只允许从当前 Principal session link 唯一解析，否则 project_required；七个 methodology tools 根本不接受可任选 project_id，只能使用调用 DSH session 的持久 link。Unknown/root role 只允许 `dsh_scholar` 与这七个 exact-session methodology tools，其他普通 Research tool fail closed。Knowledge activation 只接收 package identity/CAS，Assurance semantic identity 只从 durable child topology 派生。Tool output 为 {ok:true,...route response fields}，错误通过 DSH tool failure 携带稳定 code，不把 ErrorEnvelope 当成功值。

## 18. 可观测性

结构化日志 JSON 字段：time、level、module、instance_id、request_id、project_id?、job_id?、event、duration_ms?、error_code?；不记录 secret/完整 payload。指标至少有 request latency/error、outbox backlog、queued/running jobs、lease expiry、terminal dropped bytes/connections、CAS bytes/orphans、TeX build duration/failure、connector source failure、budget usage。桌面默认只暴露 loopback /internal/metrics；团队 adapter 接 OpenTelemetry。

**现状（已实现，2026-08，OBS-01）**：结构化 JSON 日志字段已落地（kernel/runner 日志模块）；`/internal/metrics` 端点与上述指标计数已实现：kernel 内存 MetricsStore（counter/histogram 极简实现，`packages/research-kernel/src/metrics.ts`）在 request 完成（server 层计数+延迟直方图）、outbox append/dead-letter、job claim/complete、lease expiry、terminal dropped_bytes、CAS GC/orphan、TeX build 完成、connector 失败（`multiSourceSearch` 观察者钩子，结构性 duck-typing 不产生包依赖）、budget 记账处打点；server 提供 `GET /internal/metrics`（仅 loopback 可达——`req.socket.remoteAddress` 为 127.0.0.1/::1/::ffff:127.0.0.1 或 bind host 为 loopback；非 loopback 来源 403 `loopback_only`；JSON 输出，不要求 service token——与 /v1/health 同级公开面或按部署配置）。团队 OpenTelemetry adapter 留作未来 export 面。证据：`tests/unit/metrics.test.ts` 18/18（计数/直方图/打点路径/端点 200 与 403/快照不含 token、路径、内容）。

## 19. Workspace wire

~~~typescript
type WorkspaceKind = 'code'|'manuscript'|'scratch'
interface WorkspaceFileRef { workspace_id:string; path:string; kind:'text'|'binary'; media_type:string; size_bytes:number; version:number; sha256:string; deleted:false }
interface WorkspaceMutation { workspace_revision:number; file:WorkspaceFileRef; etag:string; active_snapshot_id:null }
interface WorkspaceWriteInput { content_utf8:string; expected_file_version:number; expected_workspace_revision:number }
interface WorkspaceMoveInput { from_path:string; to_path:string; expected_source_version:number; expected_workspace_revision:number }
interface WorkspaceSearchInput { query:string; glob?:string; regex:false|true; case_sensitive:boolean; max_results:number; cursor?:string }
interface WorkspaceSearchMatch { path:string; version:number; line:number; column:number; preview:string; truncated:boolean }
~~~

路径是单次 decode 后的根相对 POSIX path。所有 create/write/move/delete/upload 同时推进 workspace revision 并使 active snapshot 失效；冲突 details 固定返回 base/current refs，不自动覆盖。watch event 使用 workspace_seq 严格递增，支持 after_seq、gap 和 resync。二进制 asset 通过 multipart/CAS，未知媒体只读下载。

## 20. Interactive PTY wire

~~~typescript
type PtyFrame =
 | {kind:'subscribed'; pty_session_id:string; generation:number; last_seq:number; retained_from_seq:number}
 | {kind:'data'; pty_session_id:string; seq:number; byte_length:number; data_base64:string; display_text:string; time:string}
 | {kind:'gap'; pty_session_id:string; seq:number; requested_after:number; retained_from_seq:number; dropped_bytes:number; time:string}
 | {kind:'input_ack'; pty_session_id:string; seq:number; client_seq:number; accepted_bytes:number; time:string}
 | {kind:'resize_applied'; pty_session_id:string; seq:number; client_seq:number; cols:number; rows:number; time:string}
 | {kind:'state'; pty_session_id:string; seq:number; status:'opening'|'running'|'detached'|'closing'; time:string}
 | {kind:'exit'; pty_session_id:string; seq:number; exit_code:number|null; signal:string|null; reason:string; time:string}
~~~

Open 只接受 workspace_id、runner_profile_id、server allowlisted shell preset、cwd relative path、cols/rows、purpose 和 expected config revision；不接受任意 SSH credential、endpoint 或 host argv。input 为 base64 bytes + client_seq；resize/signal/close 同样幂等。WebSocket 每帧重新绑定已认证 session；SSE+POST adapter 必须保持完全相同 generation/client_seq 语义。

## 21. Runner Fleet 与远端握手

~~~typescript
interface RunnerTargetView { target_id:string; placement:'local'|'remote'; adapter:'local-docker'|'remote-agent'|'scheduler'; labels:string[]; capabilities:string[]; health:'online'|'offline'|'degraded'|'draining'; last_seen_at:string|null; config_revision:number }
interface ExecutionPlan { plan_version:1; project_id:string; job_id:string; run_id:string; lease_generation:number; runner_profile_id:string; config_sha256:string; image_digest:string; command:string[]; code_snapshot_id?:string; input_artifact_ids:string[]; output_contract:Record<string,unknown>; limits:JobExecutionLimits; network_policy:string; signature:string }
~~~

Remote Agent 以 mTLS service identity 注册 capability 和 heartbeat；claim 返回 Kernel 已创建的 run_id 与签名 ExecutionPlan。Agent 必须先验证 plan signature/expiry/capability，再断点拉取 CAS 并复算 hash。network partition 时本地 spool 只保留 fenced frames/finalize intent；lease/generation 过期后不得 complete。远端离线、capability 不足或 draining 均 fail closed，不自动回退本机/subprocess。

## 22. Config Schema

每项 canonical descriptor：`key/type/default/allowed_scopes/constraints/secret/hot_reload/restart_required/security_merge/ui{section,label_key,help_key,order,advanced}`。生成器从同一 registry 产生 Zod、JSON Schema、默认配置模板、env/CLI allowlist、HTTP Patch schema、Settings controls 和文档表。

layer 顺序 fixed：built-in < instance < user < project < workspace < session < target < one-shot action。字段只有 descriptor 允许才可覆盖；安全字段使用 `more-restrictive-only` 合并。effective response 对每项返回 value 或 redacted SecretRef、source scope/id/revision、schema version、effective revision/hash、restart_required。Patch 要 expected revision；未知 key、错误 scope 或放宽 security floor 返回 422。运行中 Job/PTY/Build 固定创建时 hash。

生成时必须登记以下 namespace 的每个运行时可调项；代码中不得出现未登记的用户可见 magic default：

| namespace | 最小字段与 desktop 默认 |
|---|---|
| `kernel.*` | listen=127.0.0.1、port=0/配置端口、dataDir、request/json limits、sidecar startup/timeout、WAL/backup/GC |
| `auth.*` | local/SSO mode、session TTL、CSRF/origin、rate/body/stream limits；security floor 不可下层放宽 |
| `project.*` | mode=gate-only、budget limits、data/network/release/integrity policies、retention |
| `runner.*` | defaultProfileId=local-docker、claim/heartbeat/lease/cancel/retry、CPU/memory/pids/tmp/disk/log limits、network policy |
| `runner.target.*` | adapter/capabilities/labels/health intervals/draining、endpoint SecretRef、mTLS identity/CA、CAS chunk/spool/reconnect；只在 instance/target scope |
| `workspace.*` | file/count/total limits、editable media、autosave=false、save debounce、search/watch limits、conflict policy=prompt、snapshot excludes |
| `terminal.run.*` | retention bytes/lines、channel=all、autoScroll=true、SSE reconnect/backpressure/download policy |
| `terminal.pty.*` | enabled、allowed presets/signals、default cols/rows、idle TTL、retention、sessions/user/project、reconnect/backpressure |
| `latex.*` | engine=pdflatex、bibliography=bibtex、maxPasses=4、image digest、preview enabled/debounce=600ms/concurrency=1、shellEscape=false、network=none、workspace limits |
| `onboarding.*` | enabled、intake/upload/archive/expanded limits、chunk size、TTL、scanner/parser timeout/versions、quarantine/secret policy |
| `trajectory.*` | page/max limits、virtual threshold=100、retention、summary/spill limits、rawDetail=false、SSE queue/reconnect |
| `subagents.*` | allowed role presets、max perspectives/concurrency/depth、default mode、summary/detail/continue ACL；browser spawn/stop=false |
| `orchestrator.*` | poll/lease/retry/backoff/concurrency、phase action enablement |
| `connectors.*` | per-source enable/timeout/retry/cache/query limits、endpoint allowlist；credential 为 SecretRef |
| `analysis.*` | algorithm schema version 和 worker profile；正式 resamples/rounding 不可由项目任意改写 |
| `ui.*` | locale=auto→zh、theme=system、density=normal、refresh=8s、Project Sidebar/tabs/layout；只影响展示。Panel Dock 的 open panel/position/right size/bottom size 是当前浏览器本地 preference，不进入 canonical Config Registry 或运行 config pin |
| `telemetry.*` | log level、redaction、metrics/export/retention；默认 loopback/no external export |
| `selfmod.*` | production 固定 false；dev overlay opt-in、vmTimeout/allowed services，不能由 project/session 开启 |

Schema descriptor 为每个字段指定 allowed scopes 和 security_merge；不能因为列入 Settings 就允许任意用户修改 instance/service 字段。只读/未安装 capability 仍在 Schema 中显示 unavailable reason，不能静默消失。

## 23. Intake、Grill 与 Adoption wire

~~~typescript
type IntakeStatus = 'draft'|'uploading'|'scanning'|'needs_input'|'grilling'|'proposal_ready'|'awaiting_human'|'accepting'|'accepted'|'rejected'|'expired'|'failed'
type ObservedPhase = 'brief'|'survey'|'idea'|'baseline'|'contract'|'experiment'|'evidence'|'writing'|'review'|'release'
interface IntakeQuestion { code:string; required:boolean; reason:string; question_revision:number; answer:{value:unknown;answered_by:string;answered_at:string;provenance:'human_assertion'}|null }
interface PhaseProposal { proposal_id:string; intake_id:string; revision:number; observed_phase:ObservedPhase; safe_project_status:string; confidence:number; unresolved_gaps:string[]; required_gate_types:GateType[]; mappings:Array<{source_id:string;target_kind:string;target_path?:string;provenance:'observed_unverified'|'legacy_unverified'}>; target_project_id:string|null; target_project_revision:number|null }
interface AdoptionReceipt { adoption_id:string; intake_id:string; proposal_id:string; project_id:string; project_revision:number; created_refs:Array<{kind:string;id:string}>; pending_gate_ids:string[]; request_hash:string; accepted_by:string; accepted_at:string }
~~~

Intake staged upload 复用 Content-Range/offset/hash 幂等规则，但绑定 intake Principal 而非 Runner lease。scan cache key 为 Blob hash + parser/detector versions。accept 仅 `intake_accept` Human Principal，并在单事务物化；proposal/target revision stale 均 409。精确映射和不可信边界见 research-onboarding.md。

Name-only Init 固定创建 `DRAFT/brief_status=collecting` + active Intake，零 Gate；Chat 每次只提交一个 `IntakeQuestion`。批量 stage 默认 8 MiB chunk、2 GiB/Intake，硬上限分别为 32 MiB/10 GiB；重放、gap、finalize 与 Provider/OCR wire 以 `init-grill-upload-models.md` 为准。

## 24. NextAction、Trajectory 与 Subagent wire

~~~typescript
interface NextAction { id:string; code:string; label:string; reason:string; required:true|string[]; route:string; capability?:string; revision:number|null; state:'ready'|'blocked'|'done'; blocking:boolean; refs:Array<{kind:string;id:string}>; required_by:'human'|'agent'|'runner' }
interface SubagentAddress { parent_session_id:string; child_session_id:string; mode:'one-shot'|'continuable' }
interface TrajectoryNodeSummary { node_id:string; parent_node_id:string|null; relation:'root'|'child'|'fork'; source:'kernel-outbox'|'dsh-session'|'external'; kind:'session'|'subagent'|'task'|'research-event'; label:string|null; mode:'one-shot'|'continuable'|'read-only'|null; status:string; has_children:boolean; children_count:number|null; duration_ms:number|null; tokens:{uncached_input:number;cache_read:number;cache_write:number;output:number}|null; permissions:{can_read_summary:boolean;can_read_detail:boolean;can_continue:boolean} }
~~~

Project projection 同时返回 legacy `next_actions: string[]`（由非 done 动作的 label 稳定派生）与权威 `next_actions_v2: NextAction[]`（GUIDE-01；字段语义见 domain-model.md §14，Zod schema 见 research-schemas `NextAction`）。动作由 Kernel 从 status/pending gates/jobs/budget/contracts/ideas/evidence 确定性生成；未知/未来状态退化 `code:'unknown'` 的只读动作，UI 不得为 unknown 构造 mutation。Trajectory event envelope、分页、SSE、retention、redaction、token/duration 聚合与 exact-parent follow-up 见 trajectory-subagents.md。

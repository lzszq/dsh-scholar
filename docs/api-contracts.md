# HTTP、流式事件与错误契约

> 规范性文档。目标接口版本为 v2。新 UI 只能调用 BFF；v1 仅作为迁移 adapter，不得承载新能力。

## 1. 通用协议

- Kernel 默认监听 127.0.0.1，可选 Unix socket；不得直接暴露公网。
- JSON 请求 Content-Type 为 application/json，默认上限 16 MiB；Artifact upload 可单独配置至 32 MiB。
- 成功 JSON 直接返回资源或明确结果对象，不再使用仅有 message 的响应。
- 所有 mutation 接受 X-Request-Id；创建类请求接受 Idempotency-Key。
- BFF 从登录会话解析 Principal，忽略浏览器提交的 actor 或 principal 字段。
- Kernel 内部调用使用短期 Bearer 或 mTLS/Unix identity；Token 使用恒定时间比较。
- `/internal/*` 的 service-token 判定基于解析后的 route class，不基于可被 `%xx` 或重复斜杠改变的原始 pathname；非规范路径不能绕过 service gate。
- 列表统一接受 cursor、limit，limit 默认 50、最大 200；响应为 items、next_cursor。
- 所有 project-scoped 路由先执行 membership/AuthZ，再查资源；跨项目不存在与无权限都返回 404，避免枚举。

## 2. 错误格式

~~~json
{
  "ok": false,
  "error": {
    "code": "revision_conflict",
    "message": "Project revision changed",
    "request_id": "req_xxx",
    "retryable": false,
    "details": {"expected": 3, "actual": 4}
  }
}
~~~

| HTTP | code 示例 | 语义 |
|---:|---|---|
| 400 | invalid_json、invalid_path | 协议无法解析 |
| 401 | unauthorized | 缺失或无效身份 |
| 403 | forbidden、csrf_rejected | 身份有效但不允许 |
| 404 | project_not_found、resource_not_found | 资源不可见或不存在 |
| 409 | revision_conflict、gate_already_decided、lease_stale、document_version_conflict、project_not_archived | 并发或状态冲突 |
| 413 | payload_too_large | 请求或上传超过上限 |
| 422 | validation_error、invalid_transition、container_execution_required | 可解析但违反契约 |
| 429 | rate_limited | 超过限流 |
| 500 | internal_error | 脱敏内部失败 |
| 502 | kernel_unreachable、connector_unavailable | 依赖不可用 |

稳定补充 code：invalid_cursor(400,false)、unsupported_media_type(415,false)、idempotency_conflict(409,false)、upload_offset_conflict(409,true)、artifact_stage_expired(409,false)、document_version_conflict(409,true)、tex_root_not_found(422,false)、lease_conflict/lease_stale(409,true)、job_finished(409,false)、manifest_invalid/signature_invalid(422,false)、project_required(422,false)、fixture_required(422,false)、fixture_image_mismatch(422,false)、fixture_artifact_outside_profile(422,false)、fixture_code_mismatch(422,false)、jobs_running(409,false)、project_not_archived(409,false)、project_delete_confirmation_invalid(422,false)、domain_unsupported(422,false)、idea_corpus_unknown(422,false)、idea_corpus_foreign(422,false)、passage_content_hash_required(422,false)。括号第二项是 retryable；未登记 code 默认 retryable=false。

Zod 错误 details 只返回字段路径和安全消息。上游 5xx、文件系统绝对路径、SQL、环境变量和 Token 不得传到浏览器。

> 错误面形状（如实记录）：**BFF 原生错误**按本节约定 envelope（`ok:false` + `error:{code,message}`，code 取自下表/稳定补充码）；**kernel 代理错误**由 BFF 原样透传 kernel 的 wire envelope（`{error:{code,message,request_id,retryable}}`，reconstruction-contracts.md §error envelope），BFF 不改写上游 body——两种形状客户端均已解析稳定 `error.code`。

## 3. Health 与能力发现

### GET /v2/health

返回 ok、instance_id、protocol_version、schema_version、database_id、capabilities、time。method 和路径必须精确匹配；错误百分号路径返回 400，不能使进程异常。

capabilities 至少包含 terminal_stream、interactive_terminal、workspace_files、tex_workspace、latex_compile、latex_live_preview、remote_runner、config_registry、research_onboarding、trajectory、subagent_topology、signed_manifest、clean_room 和 locales。

## 4. Project 接口

| 方法 | 路径 | 请求/结果 |
|---|---|---|
| POST | /v2/projects | 最小请求 `{name}`；Idempotency-Key + Human Principal；事务返回 DRAFT/collecting project、creator PI membership、budget、active Init Intake；不创建 Gate |
| GET | /v2/projects | 授权项目分页列表 |
| GET | /v2/projects/{id} | Project |
| PATCH | /v2/projects/{id} | name 或允许的配置 + expected_revision |
| POST | /v2/projects/{id}/archive | expected_revision |
| POST | /v2/projects/{id}/unarchive | expected_revision |
| DELETE | /v2/projects/{id} | PI-only；`{expected_revision, confirm_name, reason}`；返回 DeletionReceipt |
| POST | /bff/research/projects/{id}/stop | PI；expected_revision、reason |
| POST | /bff/research/projects/{id}/fail | PI/Policy；expected_revision、reason、failure_class |
| POST | /bff/research/projects/{id}/refine | PI；expected_revision、target phase、reason |
| GET | /v2/projects/{id}/projection | Project、pending gates、jobs、budget、counts、`next_actions`(legacy string[])+ `next_actions_v2`(NextAction[])、capabilities |
| POST | /v2/projects/{id}/transitions | to、expected_revision、reason；Gate 状态永远 422 |
| POST | /v2/projects/{id}/session-links | 只绑定调用 Principal 当前 session_id；客户端不能提交任意会话 |
| GET | /v2/session-links/current | 从调用 Principal 当前 session 返回 project_id |
| GET | /v2/projects/{id}/grill | 当前单个问题、revision、Brief draft、材料候选和 next action |
| POST | /v2/projects/{id}/grill/answers | 每次仅一个 `{question_code,question_revision,value}`，Human assertion |
| POST | /v2/projects/{id}/grill/confirm | PI-only；expected project/intake revisions；写 Brief 并创建唯一 Scope Gate |
| POST | `/bff/research/projects/{id}/chat/turns` | project-scoped 自然语言 turn；读取权威 projection，返回 assistant text、intent/effect、canonical operation/confirmation 状态与最新 `next_actions_v2`；不能直接决定 Human Gate |

Projection 是 UI 摘要，不承载完整日志、Artifact 字节、TeX 内容或大型 Evidence。

Standalone 当前使用两个同源、Bearer + CSRF 保护的本地 BFF route。`POST /api/chat/turn` 接收 `{project_id,session_id,text,locale,history,images}`；`images` 是最多 20 个 strict `{mediaType: image/png|image/jpeg|image/webp|image/gif,data: canonical-base64,name?}` 的当前轮瞬态视觉输入，整个 BFF/bridge JSON envelope 最大 16 MiB，且只允许出现在 `conversation` operation。一次选择/拖放/粘贴形成原子批次：浏览器先把新增项与当前 exact-session 队列合并，在任何 `arrayBuffer()` 前按媒体类型、数量与 encoded 上界整批预检，失败零项进入视觉队列；通过后才顺序编码。private bridge 对最终 `JSON.stringify` 字节数再次精确检查，超限保持 HTTP 413 / `payload_too_large`。发送端在首个 await 前冻结 exact project/session/history/quote/image ids，以独立于 DOM 重绘的 exact-session single-flight 提交，并将延迟文本/错误只写回原会话；显式关闭原会话后零写。浏览器图片编码阶段本身属于视觉请求边界：只要 `loadImages`/`File.arrayBuffer()` 抛错，即使尚未形成任何 `images[]` wire，也必须返回可操作的视觉错误并保留队列，禁止误判为无图片后进入确定性文本回答。BFF 先做 membership 并重读 project projection，再把 allowlist 后的 project context、最多 12 条有界 history 和图片 wire 发给 DSH 插件的 private loopback model bridge。插件解析 exact route 后必须确认模型接受 text；视觉 turn 还必须确认显式 image capability，再经 `ctx.attachments` 的 `admitEncodedImages` 得到 durable refs，LLM 消息只携 `ImageBlock`；image-only、unknown/text-only 视觉模型均在附件写与网络 I/O 前拒绝。开放对话的模型输出是纯文本流，插件负责封装为 strict `{operation:"conversation",assistant_text}` reply；不得要求模型把自然语言包装成 JSON，也不从模型文本解析或自动执行 mutation/suggested command。该 route 零 Kernel mutation；bridge metadata/credential 必须作为同一个 `0600 agent-bridge.json` 原子替换，包含同版本 loopback origin/pid/started_at/token，禁止 endpoint/token 分文件与兼容读取，浏览器永远拿不到描述文件或 token。Bridge 业务错误使用闭合 typed code，BFF 只 allowlist code，不依赖英文 message。无图片的普通桥接或模型不可用可返回稳定 `503 model_unavailable` 并允许客户端使用确定性阶段引导；任何携图请求的 `vision_model_required`、`vision_image_rejected`、`vision_attachment_service_unavailable`、`payload_too_large` 或通用模型失败都必须显示视觉错误并保留原会话图片，不能静默当成普通文本成功。

`GET /api/model` 投影 private bridge 的 live DSH discovery catalog，模型项包含 exact `id=provider/model`、provider、opaque model、name、可选 `input_modalities` 与可选 `available`；`inputModalities` 缺失保持字段缺失（unknown），显式空数组保持空数组（不接受 Scholar text），两者都不能使其他目录项消失。不得保留静态模型 fallback，也不得把 advisory catalog 当请求白名单。qualified route 只在第一个 `/` 分隔 provider，后续字符全部属于 opaque model id。已保存值不在目录时，BFF 必须通过 private `resolve_model` 调用所属 adapter 的 `ctx.llm.resolveModelInfo(provider, model)`：成功追加精确项并维持选择；失败保留同 id 的 `available=false` 禁用项，Plugin 也 fail closed，绝不显示/执行 Auto 或目录首项。即使 route 存在于 catalog，PUT 和每个实际 turn 也必须重新使用 exact resolver，而不能把 discovery capability 当 correctness metadata。旧的未限定模型名仍视为未选择且不得猜 Provider。`PUT /api/model` 继续要求 Bearer、same-origin 与 CSRF；`auto` 可在 bridge 不可用时清除用户偏好，并先回退显式插件 PI 默认；没有配置默认时才逐项 exact-resolve catalog，跳过离线或明确不含 text 的项。具体模型只能由 exact `resolve_model` 确认，未知/不可解析项 422、bridge 不可用 503。浏览器只有在模型未明确排除 text 时才允许用于 Scholar Chat；显式空/image-only 项禁用，只有显式 text+image 项以 `👁` 标记。选择 PUT 必须作为 Chat send 的 acknowledgment barrier；迟到初始化 GET 不得覆盖已开始的 PUT，保存失败恢复上一已确认值并阻止该 turn；用户显式选择优先于插件默认。Auto exact-resolution 收到取消后必须立即停止。

`POST /api/chat/ideas` 接收 `{project_id,text,count,locale}`，其中 `count` 为 1–5。BFF 必须重新核对 project membership/写角色、`idea_generate/state=ready/required=true/required_by=agent`、project revision 与最新非空 frozen Corpus Snapshot；随后要求 model bridge 返回数量精确的严格 `IdeaDraft[]`。草稿不得携带 id、project、status、version、timestamp 或 provenance；重复标题、schema 不完整、引用不在该 frozen corpus 的 paper id、模型失败、revision 冲突均不得部分写入。成功后只调用下述 Kernel batch route；它不选择 winner、不批准 Idea Gate。

`POST /api/chat/ideas/select` 接收 `{project_id,idea_id}`，只允许当前项目 PI/operator。BFF 重读 projection 与 IdeaCard 后，用候选 title/hypothesis/exact_delta 派生最多 3 个有界 counter-search query，并调用 Scholar connectors；connector 整体失败时返回 `502 connector_unavailable` 且零写。BFF 将 queries、结果、去重 overlap paper ids、风险和 `audited_at` 发送给 `POST /v2/projects/{project_id}/idea-gate`。Kernel 以 expected project revision + expected idea version 单事务校验 selected proposed idea、同项目 frozen corpus 和唯一 pending Idea Gate，保存 NoveltyAudit、推进 `SURVEYING→IDEATING`、创建 payload `{idea_id}` 的 pending Gate；任一冲突全部回滚。正常流程禁止 payload-less Idea Gate；该 route 不批准 Gate。

### 4.1 DSH plugin internal create/link 与 topology bridge

- `POST /internal/dsh-sessions/{session_id}/projects`：同时要求普通 Kernel bearer、共享 internal service token、仅注入 DSH plugin/kernel 的独立且非空 `x-dsh-plugin-token`，并固定 `x-service-principal: dsh-plugin`；配置缺失、空白、空 header、自报 principal 或被 Runner 持有的共享 service token 均不能单独满足该 route。请求还要求 `Idempotency-Key` 和严格 body `{name}`；session id 使用同一安全 opaque-id 语法。服务端只从 path session 派生 creator Principal，body/client 不能提供或覆盖 Principal/session。internal request hash 必须是以专用 DSH plugin token 为密钥、覆盖固定 route namespace/session/name 的 `HMAC-SHA256`；public v2 name-only adapter 可继续忽略 legacy 额外字段，但公开请求无法构造相同的凭证绑定 hash，任一方向的同 key 跨 route 碰撞都必须 409。创建事务内先核对 idempotency ledger 与原始 `session_links` 行，再原子创建 name-only `DRAFT/collecting` Project、active Init Intake、Budget、PI membership 和 exact session link，返回 `{project,intake,budget,membership,link}`。同 key+同 session/name 重放仅在 project.session、原始 link 和派生 PI membership 全部一致时返回同一资源；不同 hash 或不完整旧状态 409。`x-idempotency-replay-only: 1` 只允许读取同 key 的已提交回执，key 不存在时 404 且绝不创建，供 transport 在 fetch、响应头或成功响应体读取/解析阶段失败、超时或 abort 后对账；客户端超时和 caller abort 必须覆盖完整响应体消费过程。任何既有 session link（包括已删除 Project 的墓碑 link、悬空 link）、并发创建或 relink 竞争均稳定 409 且零新项目，绝不使用 upsert 改绑；public v2 create 不能接受任意 DSH session id。
- `GET /internal/dsh-sessions/{session_id}/project-options`：使用与 create 相同的 Kernel bearer、service token、非空 DSH plugin token 和固定 principal gate；session id 使用同一安全语法。响应只列出由专用 plugin token 派生的稳定操作员具有 membership 的未删除 Project 摘要，可包含 `ARCHIVED` 供 UI 解释但不得扩大绑定能力；不得返回其他 Principal 项目、成员表或 secret。
- `POST /internal/dsh-sessions/{session_id}/project-link`：使用相同四重 gate，严格 body 只有 `{project_id}`。事务内要求项目存在、稳定操作员具有 membership 且项目非 `ARCHIVED`；不存在 link 时 exclusive insert，已是同 pair 时幂等返回，任何不同 link、墓碑/悬空 link 或竞争写稳定 409，绝不 update/upsert 改绑。

- `POST /internal/projects/{project_id}/topology/children`：只接受 service token 与 `x-service-principal: dsh-plugin`；body 的 `session_id` 必须已精确链接 path project，且 `parent_id === session_id`。既有 `child_id` 若属于其他 project/parent 返回 409，终态 re-register 不复活；
- `PATCH /internal/topology/{child_id}/state`：同样要求 service token/service principal，body `session_id` 必须仍等于 child 的 parent 且链接 child project；terminal state 单调，同状态重放幂等，其他 terminal transition 返回 409；
- 百分号编码的 `internal`、重复斜杠或其他非规范等价路径必须与 canonical route 使用相同 service-token gate，不能退化为仅信任可伪造 header；
- public `/v1/.../topology` 仍使用 Human principal + membership 契约，不能用 internal bridge 替代浏览器授权。

Chat turn 请求最小为 `{session_id, turn_id, text}`，`turn_id` 在 project + session 内幂等；path project 是唯一 scope，body 中任何 project/principal/role 均忽略或拒绝。分派顺序为 direct slash、active Grill answer、natural intent。响应为 `{assistant_text, intent:{code,confidence,effect,canonical_command?}, execution:{status:'answered'|'executed'|'confirmation_required'|'blocked',refs:[]}, next_actions_v2}`。没有模型 adapter 时允许返回 phase-aware deterministic answer，但不得把 prose 交给 slash parser。BFF 必须在执行任何 connector/Job/write 前重新校验 membership、role、NextAction/revision 与 idempotency；Human-only intent 始终 `confirmation_required` 并导航专用 Human BFF 页面。

DSH Connection 的 `/dsh-scholar-view` 使用 `trusted-host` authority 且只暴露 `session-workspace`、`session-bind`、`session-create`；loopback-only `/dsh-scholar` 单独承载 settings snapshot/mutation 与显式 Token Clipboard，两个 handler 必须拒绝对方的 endpoint，不能仅靠客户端隐藏。View 请求和响应必须严格拒绝额外字段，不能携带 provider/model/principal/credential、原始日志、prompt 或 transcript；浏览器只提交当前 Host 给出的 session id、显式选择的 project id 或用户输入的 project name。

`DELETE /v2/projects/{id}` 是 Human-only governance 写面，Agent tool/command 不暴露。仅当项目为 `ARCHIVED`、无 active Job 且 revision/精确名称确认匹配时成功；成功后普通 GET/list/projection 和任何项目写入均返回/表现为 404，并保留 tombstone、成员、Decision、Outbox、finalized artifact 与受 retention 管理的证据引用。开放的 chunked-upload session 属瞬态数据：Kernel 必须在同一删除事务内删除 chunk 行并把 open session 变为 durable `aborted` cleanup ledger；提交后清理隔离 `.part`，成功或 ENOENT 后才删除 ledger row。进程崩溃或 unlink 失败时，常驻 sweep 立即重试 aborted ledger，通用 staged-file sweep 兜底历史 orphan；不能依赖 tombstone 后已无 membership 的浏览器 abort。相同 `X-Request-Id` 重放返回同一 `{project_id, deleted_at, deleted_by, revision, request_id}`。迁移期 `/v1/projects/{id}` DELETE 是同一 Kernel 方法的 adapter，不得拥有不同权限或物理清理语义。

成员接口为 GET/POST/PATCH/DELETE /bff/research/projects/{id}/members；角色和最后一个 PI 约束见 reconstruction-contracts.md。standalone 解锁、SSO、DSH Agent session 关联和 service identity 的 Principal 解析也以该文档为准。

POST /v2/projects 的 Idempotency scope 是 tenant_id + principal_id + route + key；同请求 hash 重放返回同一 project/intake/budget/membership，hash 不同 409。Grill confirm 另以 project_id + intake revision + request key 幂等；同一项目最多一个 pending Scope Gate。其余 project mutation 使用 project_id + route + key；Gate Decision 和 cancel 的业务对象本身也提供终态幂等。

## 5. Gate 与身份

### Agent/模块接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /v2/projects/{id}/gate-requests | 创建 pending Gate，不能含 Decision |
| GET | /v2/projects/{id}/gates | 过滤 status/type |
| GET | /v2/projects/{id}/decisions | 审计分页 |

### Human BFF 接口

POST /bff/research/gates/{gate_id}/decision

请求只有 `decision|reason|diff`业务字段。BFF 注入 Principal 和 request_id；Kernel 在单事务完成目标冻结、Decision、Gate、Project 与 Outbox。Agent Tool 和 DSH command 中不存在此路由的调用器。

Kernel 不再注册 `POST /v1/gates/{gate_id}/decisions`（一律 404）。standalone 只能用自己的 service token 和固定 `x-service-principal: standalone-human-bff` 调用 `POST /internal/human-gates/{gate_id}/decisions`；该 internal 路由不暴露给浏览器，且与 `research-orchestrator` 的 full-auto Gate endpoint 分离。所有 `/internal/projects/{project_id}/full-auto-*` route 除 Kernel bearer、共享 `x-service-token` 和固定 `x-service-principal: research-orchestrator` 外，还必须携带独立 `x-orchestrator-token`；Kernel 对从 0600 sidecar credential 文件加载的期望值做恒时比较。共享 service token、伪造 principal 或浏览器 bearer 不能单独执行；sidecar 只把 secret 作为 Kernel 的 spawn env 与插件自管 orchestrator 的专用构造参数，不交给通用客户端，也不进入 argv、日志、HTTP body/response、Settings 或 compact UI。BFF 保留 Kernel 的稳定 error code，并对自身预检/转发失败统一返回 `error:{code,message,request_id}`。Budget Gate 的 `resume_to` 不来自本次决策请求；Kernel 只接受与超额阻断同一事务写入、以 `gate_id` 绑定的 `budget_block_provenance` 精确相符的 target。

## 6. Corpus、Idea 与 Contract

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /v2/projects/{id}/corpus-snapshots | 冻结结构化 Snapshot |
| GET | /v2/projects/{id}/corpus-snapshots | 分页列表 |
| GET | /v2/corpus-snapshots/{id} | 完整快照或分页子资源 |
| POST | /v2/projects/{id}/ideas | Idea Draft |
| POST | /v1/projects/{id}/ideas/batch | standalone Chat canonical idea write；`{expected_project_revision,corpus_snapshot_id,ideas[1..5]}`，要求 SURVEYING + 同项目 frozen corpus，整批事务提交并由 Kernel 附加 identity/provenance |
| GET | /v2/projects/{id}/ideas | 列表 |
| GET | /v2/ideas/{id} | IdeaCard |
| POST | /v2/ideas/{id}/novelty-audits | 查询集与结果，产生新 Idea version |
| POST | /v2/projects/{id}/contracts | Contract Draft |
| GET | /v2/projects/{id}/contracts | 列表 |
| GET | /v2/contracts/{id}/versions/{version} | 指定不可变版本 |

Contract approval 只能由 Gate 事务发生，没有独立 approve 路由。

## 7. Artifact 与 Snapshot

### POST /v2/projects/{id}/artifacts

浏览器/用户上传只接受 <=32 MiB multipart/form-data；更大输入和研究包必须通过 `/v2/intakes` 的受控 staged upload，不能使用 Runner internal stage。服务端计算 SHA-256，不信任客户端 hash。请求 metadata 包含 kind、media_type、file_name 和 provenance。

### POST /v1/projects/{id}/uploads（UPLOAD-01 服务端/BFF 层，已实现）

当前提交实现为 **kernel 原生 multipart 端点 + standalone BFF 原样透传**（v2 artifacts 上传面由 `/v2/intakes` 的 intake staged upload 承接，属 ONBOARD-01，未实现）。standalone 同源直接暴露同一路径（`/v1/projects/{id}/uploads`），multipart 请求经 BFF 以原始字节与原 `multipart/form-data; boundary=…` Content-Type 转发，CSRF/Origin、bearer 与 project membership/role 检查与其它 `/v1` 写完全一致。

请求为 `multipart/form-data`，字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `kind` | 是 | 固定枚举：code/pdf/data/log/model/chart/paper/analysis/manifest/bundle/tex-source/bib/compile-log/compile-aux（v2 形状：TeX 构建产物用 tex-source/bib/compile-log/compile-aux 而非泛型 log/data）；非法 → 422 `invalid_kind` |
| `file` | 是 | 唯一文件 part（`filename=` 必填）；缺失 → 422 `missing_file`，多于一个文件 part → 422 `multiple_files` |
| `file_name` | 否 | 登记到 ArtifactRecord 的下载名；缺省用 file part 的 filename。必须是单段 basename |
| `media_type` | 否 | RFC 2046；缺省 pdf→`application/pdf`，其余 `application/octet-stream` |

约束与语义：

- **大小**：单文件 ≤ 32 MiB（`ResearchKernel.UPLOAD_MAX_FILE_BYTES`，可覆写）；请求体上限 = 32 MiB + 1 MiB multipart envelope 余量。超限 → 413 `payload_too_large`（流式读取中途即拒，不完整缓冲），错误消息含具体 limit 与实测字节数；
- **hash 绑定**：sha256 由服务端对实际收到的字节计算（stage 时计算、finalize 时复算并核对），客户端无法声明 hash；artifact_id=`sha256:<hex>` 与 CAS blob 一一对应；
- **路径与响应头安全**：`file_name` 拒绝绝对路径（POSIX 与 Windows 盘符）、`..`/`.` 段（两种分隔符）、NUL、C0/DEL 控制字符、路径分隔符和超过 255 UTF-8 bytes 的名称 → 422 `invalid_file_name`；下载响应使用安全 ASCII `filename` + RFC 5987 `filename*`，不得把原始名称直接拼入响应头。重复规范化路径与越界 symlink 属于研究包 archive 语义，由 code-snapshot walk（snapshotCodeArchive/unpackCodeSnapshot）在 archive 面强制；
- **staged → finalize 原子**：先写会话 id 命名的 staged 文件（CAS root 下 `staged-uploads/stage_<id>.part` + `.json` 元数据），finalize 时复算 hash、原子 rename 进 CAS blob 槽并插入 artifact 行；任何失败回滚 staged 文件，绝不留下半成品 artifact 行；
- **幂等**：同 project + sha256 + file_name 重传返回**原 artifact**（HTTP 200，响应体 `reused: true`；新建为 201 `reused: false`），不重复写 blob、不重复插行；同 project 不同 file_name 的同 blob 也返回既有记录（与 `POST /v1/artifacts` 语义一致，首登记名生效）；
- **恢复/GC**：过期 staged 文件由 `kernel.cleanupStagedUploads(maxAgeMs)` 清理（默认 TTL 24h，`ResearchKernel.STAGED_UPLOAD_TTL_MS`），grace-period 模型同 CAS 孤儿 GC；已 finalize 的 blob 永不被该 GC 触碰；
- **协议错误**：非 multipart Content-Type → 415 `unsupported_media_type`；boundary 缺失/畸形或 body 解析失败 → 400 `invalid_multipart`；未知 project → 404 `project_not_found`。

响应体为 ArtifactRecord（同 `POST /v1/artifacts`）附加 `reused: boolean`。浏览器拖拽上传 UI、intake quarantine/scan UI 属浏览器层，待 Playwright 类环境验收（见 hardening-v0.2-status.md §3 UPLOAD-01 行）。

### GET /bff/research/projects/{project_id}/artifacts/{artifact_id}

返回字节流，保留 Content-Type、Content-Length、Content-Disposition、ETag、Accept-Ranges 与 Content-Range。支持单 Range；合法范围返回 206，越界、反向、零长度 suffix 和空文件范围返回 416 + `Content-Range: bytes */N`，不得钳制为其他字节段。HTML、SVG、XML 等主动文档媒体类型强制 `attachment`；仅 PDF 与安全栅格图允许 `inline`。artifact_id 不能脱离 project_id 读取；不提供模糊的全局 artifact GET。

### POST /v1/projects/{id}/code-snapshots（P0-4 SNAPSHOT-01/API-01）

> v2 契约演进目标：POST /v2/projects/{id}/code-snapshots 与 /v2/projects/{id}/tex-snapshots 接受已登记 workspace/document、排除规则与 expected revision。当前实现（v1）已满足本行第一项：**不能接受 Runner 将读取的任意宿主绝对路径**——归档根由服务端从批准的项目 workspace 解析。

请求为 JSON（strict schema——任何未知字段 422 `validation_error`，旧 `{path: <host 绝对路径>}` 形状**已废弃并直接拒绝**，不做静默重解释）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `workspace_id` | 是 | 该项目已登记的磁盘 workspace（`POST /v1/projects/{id}/workspaces` 创建，kind=code/scratch）；跨项目或未知 → 404 `workspace_not_found`（与缺失不可区分，无跨项目枚举） |
| `root_relative_path` | 否 | 相对 workspace 根的 POSIX 路径，缺省/`''` = 整个 workspace；拒绝绝对路径、`..`/`.` 段、NUL、盘符、反斜杠与空段 → 422 `invalid_path`（复用 `normalizeWorkspacePath`）；尾斜杠裁剪后接受 |
| `description` | 否 | 归档描述 |

语义与约束：

- **根解析**：服务端从批准的项目 workspace 解析实际根（`dataDir/workspaces/{project_id}/{workspace_id}/`），并对解析结果做 realpath 容器校验——workspace 目录或子根被 symlink 替换指向 workspaces 区外 → 422 `snapshot_path_escape`；
- **walk 安全**：拒绝任何逃逸出归档根的 symlink（422 `snapshot_path_escape`，根内 symlink 跟随）；`.git`/`node_modules`/`.research-cas` 目录排除；
- **资源上限**：`SNAPSHOT_MAX_FILES`/`SNAPSHOT_MAX_FILE_BYTES`/`SNAPSHOT_MAX_TOTAL_BYTES` 保留（单文件超限在 stat 即拒、累计超限提前失败，均 422 `snapshot_too_large`）；
- **secret 文件不可快照**：匹配已知 secret 模式（`.env`/`.env.*`、`*_token`/`*-token`/`*.secret`/`*.password`/`*.credential*`、`*.key`/`*.pem`、`id_rsa`/`id_ecdsa`/`id_ed25519`/`id_dsa`、`.aws/credentials`、`service-token`/`kernel-token`、`.npmrc`/`.pypirc`/`.netrc`/`.htpasswd`）的文件**拒绝整个快照**并列出全部文件名（422 `snapshot_secret_file`）——fail closed，CAS/Artifact/manifest 零写；
- **溯源与泄漏**：响应 201 为 CodeSnapshot（`snapshot_id`、`archive_artifact_id`、`manifest_artifact_id`、`files`、`total_bytes`、`sha256`…），`path`/archive/manifest `root` 恒为显示占位符 `~`；宿主路径零泄漏；registry `code_snapshots.source_json` 记录 `workspace_id` + `root_relative_path` 溯源。

Runner/Worker 输出不能走浏览器上传。内部 artifact stage、分块上传、finalize 和 abort 的精确四步接口见 reconstruction-contracts.md；finalize 后才能把 Artifact ref 交给 complete。

## 8. Job 与 Runner 内部接口

| 方法 | 路径 | 调用者 | 说明 |
|---|---|---|---|
| POST | /v2/projects/{id}/jobs | Agent/Operator | 校验 JobSpec 和 Idempotency-Key |
| GET | /v2/projects/{id}/jobs | UI/Agent | 分页筛选 |
| GET | /v2/jobs/{id} | 授权用户 | 任务、lease 摘要、Manifest |
| POST | /bff/research/jobs/{id}/cancel | 人类 | reason；幂等取消 |
| POST | /internal/v2/jobs/claim | Runner | owner、limit、lease_ttl；返回 fenced jobs |
| POST | /internal/v2/jobs/{id}/heartbeat | Runner | owner、generation、token |
| POST | /internal/v2/jobs/{id}/terminal-frames | Runner | {frames:[TerminalFrame]}，1–256 个且 <=1 MiB |
| POST | /internal/v2/jobs/{id}/complete | Runner | signed RunManifest 与 Artifact refs |
| POST | /internal/v2/jobs/{id}/cancelled | Runner | 进程已停止的确认 |
| POST | /internal/v2/runner-keys | Runner admin | Ed25519 public key 注册和轮换 |
| POST | /internal/v2/recover/leases | Orchestrator | 过期 lease 恢复 |

当前 Fleet 使用 `POST /v1/jobs/{job_id}/artifacts` 登记运行产物，要求 `x-service-token` 与 strict `JobArtifactCreateInput`：`{project_id,run_id,owner,lease_generation,lease_token,kind,content_base64,metadata?,media_type?,file_name?}`。Kernel 以同一 SQLite 写事务校验项目、run、owner、generation、token、running 状态与未过期租约，并登记 CAS/Artifact/outbox；取消或恢复先提交、任一身份不匹配、租约过期均为 409 `lease_stale`，缺失字段为 422。成功/内容复用返回 201 ArtifactRecord；复用也须重新校验租约。租约凭据只用于提交校验，不写入 Artifact metadata 或事件；job_id/run_id 由 Kernel 绑定。

internal 请求使用 Runner service bearer/mTLS，再叠加 Job owner、generation 和 token。complete 必须校验 Manifest signature、Job/Project/Contract、快照、镜像、Artifact 所有权。任何失败都不得部分写入 succeeded。精确 wire 类型和算法见 reconstruction-contracts.md。

## 9. Terminal SSE

### GET /bff/research/jobs/{job_id}/terminal?after_seq=N&channel=all

响应 Content-Type 为 text/event-stream，Cache-Control 为 no-store，禁用代理缓冲。BFF 在连接前同时检查 project membership 和 job_log_read；连接建立后身份失效或权限撤销时关闭。

事件类型：

~~~text
event: subscribed
data: {"run_id":"run_x","last_seq":41,"retained_from_seq":1}

event: chunk
data: {"kind":"chunk","job_id":"job_x","run_id":"run_x","seq":42,"stream_seq":21,"channel":"stdout","text":"...","byte_offset":8192,"byte_length":128,"lease_generation":3,"time":"..."}

event: gap
data: {"kind":"gap","job_id":"job_x","run_id":"run_x","seq":43,"requested_after":10,"retained_from_seq":30,"dropped_bytes":2048,"lease_generation":3,"time":"..."}

event: exit
data: {"kind":"exit","job_id":"job_x","run_id":"run_x","seq":99,"exit_code":0,"signal":null,"cancelled":false,"timed_out":false,"truncated":false,"total_bytes":16384,"dropped_bytes":0,"lease_generation":3,"time":"..."}
~~~

规则：

- seq 在单次 run 内连续；客户端按 seq 去重，高序号覆盖低序号投影；
- after_seq 缺省时返回保留窗口快照后继续实时流；
- requested seq 已淘汰时必须先发 gap，不能假装完整；
- stdout/stderr 分开持久，channel=all 按全局 seq 合并；
- 服务端有界队列，背压导致删除时持久化 dropped_bytes 并发 gap；
- SSE 心跳使用注释帧，不能伪造 terminal heartbeat；
- exit 是权威终态并永久可重放；最终日志 Artifact 可另行下载。

## 10. Analysis、Evidence 与 Claim

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /v2/projects/{id}/analysis-requests | 创建 analysis Job，不直接返回正式结果 |
| GET | /v2/projects/{id}/evidence | 分页 |
| POST | /v2/projects/{id}/evidence-notes | 只创建 draft_unverified |
| POST | /internal/v2/projects/{id}/evidence | Analysis Worker 服务身份写 verified |
| POST | /internal/v2/evidence/{id}/accept | Verifier/Auditor 状态转换 |
| POST | /v2/projects/{id}/claims | Claim Draft |
| POST | /v2/claims/{id}/verification-requests | 触发确定性校验 |
| GET | /v2/projects/{id}/claims | 分页和状态过滤 |

公开 HTTP payload 不能自行提交 provenance_status=verified 或 accepted。Claim 验证只读取 accepted Evidence。

## 11. Manuscript 与 TeX Workspace

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /v2/projects/{id}/documents | 从稿件模板或现有稿件创建 TexDocument |
| GET | /v2/projects/{id}/documents | 文档列表 |
| GET | /v2/documents/{id}/tree | 文件树和每个 version/hash |
| GET | /v2/documents/{id}/files/{path} | text 或 binary；返回 ETag/version |
| PUT | /v2/documents/{id}/files/{path} | content、expected_version；原子保存 |
| POST | /v2/documents/{id}/files | 新建文件，create-if-absent |
| DELETE | /v2/documents/{id}/files/{path} | expected_version；生成 tombstone revision |
| POST | /v2/documents/{id}/moves | from_path、to_path、source/file version；原子 rename |
| POST | /v2/documents/{id}/assets | multipart binary asset upload |
| GET | /v2/documents/{id}/history | 文件和 workspace revision |
| POST | /v2/documents/{id}/snapshots | 冻结当前 manifest（含可物化字节，TEX-01） |
| GET | /v2/documents/{id}/snapshot-files | 冻结 revision 的单文件字节；?revision=&path=（当前实现 /v1/documents/{id}/snapshot-files，TEX-01 构建输入） |
| POST | /v2/documents/{id}/builds | 冻结 manifest 并创建 latex-compile Job（权威 Compile） |
| GET | /v2/documents/{id}/builds | 构建历史（仅权威 build；每条带 preview=false 与 stale 字段） |
| GET | /v2/builds/{id} | 状态、diagnostics、Artifact refs、freshness、preview/stale/superseded 字段 |
| POST | /v1/documents/{id}/preview-builds | 保存成功后调用：server 端 debounce（默认 800ms，body debounce_ms 可配置）创建 preview build（TEX-03，§12.1） |
| GET | /v1/documents/{id}/preview-builds | preview 投影：`{ pending, builds }`（pending=待处理 debounce，builds 每条 preview=true + stale + superseded_by/at） |
| GET | /v1/projects/{id}/manuscript-drafts | 只读打开（P0-3 TEX-01）：返回现有 workspace `{document_id, revision, files, created, regenerated}`；无内容时 404 `manuscript_not_found`，绝不建行/写字节 |
| POST | /v1/projects/{id}/manuscript-drafts | 创建/确保（P0-3）：默认只在首次创建时生成（文档已有文件即原样返回 created=false，不重写字节、revision 不变）；body `regenerate: true` 显式重写且生成前把当前内容冻结为历史 revision（旧字节 `GET snapshot-files?revision=&path=` 可回退）。目标 v2 面同语义（当前实现 /v1，与 snapshot-files 同款注记） |
| GET | /v2/projects/{id}/manuscript-review | 确定性检查 |

path 使用编码后的根相对 POSIX 路径，逐段 decode 后校验。保存冲突返回 409 document_version_conflict，不自动 last-write-wins。文本默认 UTF-8，保留原换行风格或在 metadata 中明确规范化。

文件读需要 document_read，保存/新建/删除/move/asset 需要 document_write，Build 需要 document_read + job_submit。精确 ETag、move 和 multipart 上限见 reconstruction-contracts.md。

Build 请求：

~~~json
{
  "expected_document_revision": 7,
  "root_file": "paper.tex",
  "engine": "pdflatex",
  "bibliography": "bibtex",
  "max_passes": 4,
  "idempotency_key": "latex:doc_x:rev7:pdflatex"
}
~~~

Build 提交（POST builds）在冻结与提交两处执行 document-revision CAS：expected_document_revision 过期或提交时 document revision 已前进 → 409 document_version_conflict，不创建 Job、不创建 build 行（保存冲突立即终止编译）。201 响应为 `{ build, job }`，其中 build.job_id、build.revision（输入 revision）与 job 供 UI 接入同一 Job 的 live Terminal（SSE GET /v1/jobs/{job_id}/terminal）与 stale PDF 判定（build.revision < document.revision）。

构建字节是冻结 revision 的可物化字节（TEX-01）：POST snapshots / POST builds 冻结时把每文件 content+hash 存入 snapshot store；Runner 通过 GET snapshot-files?revision=&path= 取该 revision 的字节并逐文件校验 manifest hash，绝不后取当前文件。snapshot-files 对未知 revision/path 返回 404、参数缺失/非法返回 422；Runner 对不可读或 hash 不匹配一律硬失败，不降级为当前文件。

构建日志通过同一 Terminal SSE 读取。Build 完成返回结构化 diagnostics、PDF、完整 log、aux/bbl/blg/fls 和输入 manifest。Artifact PDF 必须为 application/pdf。

### 11.1 实时 Preview（TEX-03）

保存事务成功后调用 `POST /v1/documents/{id}/preview-builds`（body 可选 `debounce_ms`/`root_file`/`engine`，engine 必须在固定白名单内否则 422 engine_invalid），返回 `{ pending: { document_id, revision, root_file, engine, debounce_ms, requested_at } }`。Kernel 持有 debounce 定时器（默认 800ms，KernelOptions.previewDebounceMs 或请求体可配置）并写持久化 `tex_preview_pending`；到期后冻结**当前** revision、复用 latex-compile runner 路径（同一固定 texlive image/禁网/no-shell-escape）提交 `payload.preview=true` 的作业并创建 `preview=true` 的 tex_builds 行。preview build 状态机：queued→running（claim 时同步）→succeeded/failed，或 queued→cancelled、running→superseded（新 revision preview 或权威 Compile 到达时，带 superseded_by/superseded_at，job 尽力取消）；终态不被改写。preview 不产 accepted Evidence、不参与权威 manifest 链；活跃权威 latex-compile（queued/running）存在时 preview flush 跳过。每条 build 记录（GET builds、GET builds/{id}、GET preview-builds）携带 `preview`、`stale`（build.revision < document.revision）与 `superseded_by`/`superseded_at`；GET preview-builds 的 `pending` 字段让 UI 重连/内核重启后可恢复 debounce 状态。显式 POST builds（权威 Compile）冻结自身 manifest 并 supersede 该 document 全部非终态 preview。

## 12. Release

POST /v2/projects/{id}/release-bundle-requests 创建 bundle/clean-room Job；GET /v2/projects/{id}/release-bundles 读取状态和私有下载；POST /bff/research/gates/{release_gate}/decision 才能决定 release。系统不提供自动提交外部平台的接口。

## 13. BFF 规则

- standalone 使用同源 Cookie/SSO，或使用 0600 文件生成的本地 bearer 解锁，并映射为本地 Human Principal；mutation 强制 Origin 和 CSRF token；
- DSH Session 只用于 Agent tool/command 的会话关联，不作为浏览器 Human Principal；
- BFF route 是 target-aware adapter，不能做无身份透明转发；
- 二进制和 SSE 必须真正流式传输，不能先调用 text() 或完整缓冲；
- 默认每 IP 60 请求每分钟，Terminal 长连接单独限制每用户和项目连接数；
- 浏览器永远看不到 Kernel 内部 Token。

standalone 同源直接暴露 `/v1`、`/v2`（当前 BFF 面；v2 = BFF adapter surface）并代理 kernel；`/bff/research/*` 为 v2 目标路径前缀（§16/§19/§20 中标注"剩余项"的写面落地时使用），当前未注册字面路由。`/research-api` 与 `/research-ui-api` 不存在，不得作为兼容别名恢复。

## 14. v1 兼容

迁移期间允许单独的 v1 adapter 支持现有只读投影和 Artifact 下载。新 UI、Terminal、TeX、Human Principal、accepted Evidence 与 Release 必须只走 v2。v1 write 默认关闭，任何开启都只能用于 fixture profile 并带明显审计标记。

## 15. Locale 与错误文案

zh/en 字典随 dsh-research-ui client bundle 发布，不由 Kernel 动态返回。health.capabilities.locales 返回 ['zh','en'] 和 locale_contract_revision。Kernel/BFF 返回稳定 error.code 和不含 secret 的英文诊断 message；UI 可翻译已知 code 的 chrome，但 details、论文、Terminal 和 TeX raw message 保持原文。Accept-Language 不得改变业务计算、hash、排序或持久化内容。

## 16. Research Onboarding、Upload 与 Grill Me

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v2/intakes` | Human/Agent request；begin，Idempotency-Key |
| GET | `/v2/intakes` | 当前 Principal 的可见 Intake 分页 |
| GET | `/v2/intakes/{id}` | 状态、upload/scan、questions、proposal、安全 refs |
| POST | `/v2/intakes/{id}/artifact-stages` | 创建 intake-scoped staged upload |
| GET | `/v2/intakes/{id}/artifact-stages` | 列出开放/完成 stage、committed offset、expiry 与文件队列状态 |
| PUT | `/v2/intake-artifact-stages/{stage}/content` | Content-Range 分块/幂等重传 |
| POST | `/v2/intake-artifact-stages/{stage}/finalize` | 复算 hash/size，进入 scanning |
| DELETE | `/v2/intake-artifact-stages/{stage}` | abort，幂等 |
| POST | `/v2/intakes/{id}/scan` | 启动/重用静态扫描结果 |
| POST | `/v2/intakes/{id}/grill-answers` | 每次一个 Human assertion + question revision；返回 next question |
| POST | `/v2/intakes/{id}/ocr-requests` | 显式 provider/model ID 的异步 OCR；Idempotency-Key |
| GET | `/v2/intakes/{id}/ocr-requests/{request}` | OCR 状态、安全错误、结果 refs 与来源/confidence |
| DELETE | `/v2/intakes/{id}/ocr-requests/{request}` | 取消 queued/running 请求并中止在途 OCR；终态请求幂等返回或明确冲突 |
| POST | `/v2/intakes/{id}/proposals` | 生成确定性阶段/映射 proposal |
| POST | `/bff/research/intakes/{id}/accept` | PI Human adoption；expected proposal/target revision |
| POST | `/bff/research/intakes/{id}/reject` | Human reject/cleanup request |

`accept` 只存在于 BFF Human 面；Agent tool schema 不生成该方法。scan/parser/LLM 永远不能直接 mutation Project。单文件 Artifact 上传与 research package intake 是两个明确入口，UI 不得把 internal Runner stage 暴露给用户。状态、映射、错误和幂等见 research-onboarding.md。

兼容基线仍包括 v1 项目域 begin/list/resume、≤32 MiB multipart、scan/questions/answers/propose/adopt/reject。v2 name-only Grill 与批量分块 stage 已实现；Provider Registry、MinerU 配置与项目 binding 使用当前 v1 adapter。上表 OCR request 已注册 exact route，并按 Intake 所属项目的 durable membership 授权；create/read/cancel、重启恢复、幂等、固定配置与 `observed_unverified` provenance 有自动测试。真实 MinerU transport 仍为 `NOT_RUN_MANUAL_PENDING`，不得用 mock worker 结果冒充外部服务验收。

当前 v1 chunk begin 的 2xx body 必须逐字段回显并绑定 project/intake/file identity；append 的 2xx body 必须包含与请求一致的 `upload_id`、`committed_offset` 与 `replayed`。顺序 append 返回 `end+1`；old-range 同字节/hash重放可返回已经进一步推进、但不超过 total 的当前权威 offset。浏览器对 identity mismatch、非法 JSON、无界/停滞 offset 一律 typed fail-closed，不能把合法 replay 误判为协议错误。

## 17. 通用 Workspace 与 Upload

| 方法 | 路径 | 说明 |
|---|---|---|
| POST/GET | `/v2/projects/{id}/workspaces` | 创建/列出 code、manuscript、scratch workspace |
| GET | `/v2/workspaces/{id}/tree` | 当前 revision 文件树 |
| GET/PUT/DELETE | `/v2/workspaces/{id}/files/{path}` | bytes/text 读取；版本化写/删 |
| POST | `/v2/workspaces/{id}/files` | create-if-absent text |
| POST | `/v2/workspaces/{id}/assets` | multipart binary upload <=32 MiB |
| POST | `/v2/workspaces/{id}/moves` | 原子 move/rename |
| GET | `/v2/workspaces/{id}/history` | 文件/workspace revision |
| POST | `/v2/workspaces/{id}/search` | 有界全文/路径搜索 |
| GET | `/bff/research/workspaces/{id}/events?after_seq=N` | watch subscribed/change/gap |
| POST | `/v2/workspaces/{id}/snapshots` | 冻结 archive + manifest |

所有 path、ETag、Revision 和 multipart 行为以 reconstruction-contracts.md 为准。TeX Document route 是绑定 manuscript workspace subtree 的领域 facade，不能维护第二套文件存储。

迁移期 v1 generic Workspace 路径 `/v1/projects/{project}/workspaces/{workspace}/nodes?path=...` 与 v2 files 路径必须投影相同 authority。对于 `ws_doc_*` manuscript facade，list/tree/read/readVersion/write/move/delete/search/watch 均转到 TeX store；tree 返回节点后，同一节点 read 不得因 generic store 无 workspace row 返回 404。wire node 大小字段统一为 `size`，客户端对缺失/非有限值显示 `0 B`。

**search 参数契约（POST `/v1/projects/{id}/workspaces/{wid}/search`，commit 98243ff）**：同一端点双模式，strict body——
- 路径搜索（legacy，不变）：`{prefix?, glob?}`（至少其一，AND；`*` 不跨 `/`）；响应 `{info, nodes}`；
- 内容搜索：`{q, mode?: 'content', case_sensitive?: boolean}`（`q` 出现或 `mode='content'` 即内容模式；`mode` 缺省时 `q` 出现即为内容）。响应 `{info, hits: [{path, match_count, matches: [{line, snippet}]}], truncated}`——`line` 为 1-based 行号，`snippet` 为所在行（超 240 字符以 `…` 居中截断），`match_count` 为该文件真实匹配总数，`matches` 最多返回前 20 个，`truncated` 表示 50 文件上限截断。语义：只扫文本节点（`binary=0` 且 media 文本类，NUL magic 硬跳过）；>512 KiB 文件整文件跳过（绝不部分扫描）；大小写不敏感默认；非法 UTF-8 字节按替换符容错（不抛错）。参数校验：空/纯空白 `q` → 422 `invalid_query`；`q` 与 `prefix`/`glob` 混用或 `mode='path'` 携带 `q` → 422 `invalid_search_params`。**无全文索引**——线性扫描，大数据集性能受限（如实记录，索引属后续增强）；并发搜索有简单槽位上限（超限 429 `search_busy`）。内容搜索与路径搜索同受 workspace 钉定与隔离语义约束（跨项目 404、隔离 503）。

**崩溃恢复语义（WORK-01 §5 P2，hardening §5 行，storage-migrations.md §10.1）**：kernel 启动与按需 `scanWorkspaceIntegrity()` 恢复扫描会把磁盘字节与 `workspace_nodes`/`workspace_ops` 收敛——可证修复（rename-before-row 前滚、CAS/历史恢复、孤儿回滚等）静默完成；不可证修复把 workspace 标记隔离，此后该 workspace 的全部路由（tree/nodes/assets/moves/history/search/events/snapshots/blob）返回 **503 `workspace_inconsistent`**，直到字节恢复后下一次扫描干净收敛自动解除。

## 18. Interactive Terminal

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/pty/contexts?project_id={project}` | 当前 Human 在项目内可用的 Research、DSH Chat 与其 exact-parent Subagent context；只返回安全投影，不返回 owner/tenant/凭据 |
| GET | `/v1/pty/contexts/{context}/sessions` | 列出该 exact context 的多个 PTY、标签与 `active_hint`；服务端重新解析当前 context authority |
| POST | `/v1/pty/sessions` | body 仅含 `context_id/workspace_id/label/purpose/preset/cwd/cols/rows`；project/owner/tenant/parent/profile/target 全由服务端解析 |
| HEAD | `/v1/pty/sessions/{id}` | 仅供可信 BFF 解析 owning project；仍要求 server-derived principal，不返回会话体 |
| GET | `/v1/pty/sessions/{id}?expected_generation=N` | state 与权限摘要；owner、lease、exact context、current generation 全部校验 |
| POST | `/v1/pty/sessions/{id}/attach` | `{expected_generation}`；成功后 generation 递增并返回新会话 |
| POST | `/v1/pty/sessions/{id}/detach` | `{expected_generation}`；断开 wire、保留进程，generation 递增 |
| POST | `/v1/pty/sessions/{id}/control` | `{expected_generation,client_seq,type,payload}`；bytes/resize/INT/TERM/KILL/close |
| GET | `/v1/pty/sessions/{id}/frames?after_seq=N&expected_generation=G` | 有界回放；gap/retention 明示 |
| GET | `/v1/pty/sessions/{id}/frames/stream?after_seq=N&expected_generation=G` | authenticated SSE；frame/gap/exit/heartbeat |
| DELETE | `/v1/pty/sessions/{id}` | body `{expected_generation}`；显式 close，幂等但不接受省略 generation |

浏览器唯一可提交的 authority reference 是由 contexts 列表取得的 opaque `context_id`。Kernel 必须实时从当前项目 membership、`session_links` 的 durable principal、`child_links` exact-parent 链和项目当前 Runner binding 重新解析 project/owner/tenant/parent/profile/target；旧的无 durable principal session link 不构成 PTY authority，也不得由当前登录者、项目 owner 或本机默认值推断。canonical context 仅有 Research、Chat、Subagent：Research context 使用 server-derived、principal-scoped opaque id；Chat 只属于其 durable link owner；Subagent 必须沿 parent 链收敛到同项目的有身份 Chat root。不存在 Operator context、project context 或旧枚举兼容 fallback。

`idle_ttl_s`、`retention_bytes` 与 lease TTL 是 Kernel runtime policy，不属于 open body。Kernel 每次 open 从 canonical Config Registry 的 `kernel.pty_idle_ttl_s`、`kernel.pty_retention_bytes`、`kernel.pty_lease_ttl_s` 读取当前 effective 值，并与 exact `config_hash` 一起钉定到新会话；Settings hot write 只影响此后的 open，已有会话不得被后台配置变化重解释。

attach/detach/input/resize/signal/control、轮询与 SSE 全部携带 `expected_generation`；stale generation、lease expired、membership 撤销、exact-parent 变化、project runner binding 变化、target disabled/draining/offline、adapter 与 target kind 不匹配或 context 越权均 fail closed。一个 context 可有多个带 label/purpose 的 PTY；切 context 时客户端必须先清空 active input target，服务端 `active_hint` 只是恢复提示，不能授权控制。

Standalone BFF 对所有 `/v1/pty/*` 请求只注入其可信会话解析出的 `x-principal-id`；不得再从 open body 读取或要求 `project_id`。Kernel 从 `context_id` 重新解析 Project 与当前 membership，并对 open/attach/detach/control/close 执行 `terminal_write`（仅 PI、Operator、Researcher）；Viewer/Auditor 不能产生 PTY 写入。BFF 解析已有 PTY 的 Project 时使用无 body 的 `HEAD /v1/pty/sessions/{id}`，不能调用需要 lease/generation 的 session GET。

Run Terminal `/jobs/{id}/terminal` 保持只读且永远不接受 input。PTY 每个 control 操作执行 Project AuthZ、terminal_write、generation/client_seq 和 target policy；revoke 关闭连接。浏览器不能提交 SSH endpoint/credential、Docker socket、host path 或任意 argv。

## 19. Runner Target、Profile 与 Config

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/runner-targets`、`/bff/research/runner-targets` | 可见 target kind/health/capability/config hash 与 SecretRef availability，不返回 endpoint/credential 值 |
| GET/POST/PATCH | `/bff/research/runner-profiles` | profile、资源/网络/image policy；revision CAS |
| GET | `/bff/research/config/schema` | canonical schema/UI metadata |
| GET | `/v1/config/effective?project_id={id}` | scope filters + value/source/revision/hash；Project 读取要求 membership |
| GET | `/v1/config/layers/{scope}/{scope_id}` | redacted layer 与 revision CAS 当前值 |
| GET | `/v1/config/revisions/{scope}/{scope_id}` | redacted provenance/audit |
| POST | `/v1/settings/transactions` | 唯一 Settings mutation；最多 64 个 Config/OCR/Runner operations，统一 CAS、权限和 SQLite transaction，任一失败全部回滚 |
| GET | `/v1/providers`、`/v1/providers/{id}` | Provider safe view；SecretRef metadata only |
| GET | `/v1/projects/{id}/model-binding` | 项目 OCR binding safe view；要求 membership |

OCR-CONFIG-01 的首个内置 descriptor 为 `provider_id=mineru`、`kind=mineru`、默认 `base_url=https://mineru.net/api/v4`，模型目录固定为 `flash/pipeline/vlm`；credential 可省略（MinerU Flash）或为严格 SecretRef（精准模式），任何明文 token/value/password 继续拒绝。Provider create/update 与可选 Project binding 必须放在同一个 `ocr-mineru` Settings operation 中。`/v2/intakes/{id}/ocr-requests` 只接受与当前 binding 完全一致的 provider/model，并把 provider revision/config hash、source hash、页和语言固定进持久请求；配置成功或请求入队都不能被解释为 OCR 已执行，只有带结果 provenance 的 `succeeded` 状态表示 worker 已完成。

Remote Agent internal 面提供 enroll/heartbeat/capability/claim/CAS fetch/stage/complete；全部使用 mTLS service identity 与 ExecutionPlan signature。任何 target/profile/config 修改只影响新动作，不能改变运行中 Job/PTY/Build 的 pinned hash。

Experiment/Job/Reproduction public body 只接受 `runner_profile_id` 与 `runner_target_id`。Settings 当前项目选择器通过统一 transaction 写 project-scope `execution.runner_target_id`；Kernel 在同一事务中校验 Target 并派生匹配的 RunnerProfile。Chat `/run` 与 `/reproduce` JSON 中的 `runner_target_id` 作为 Job 顶层字段发送，优先级为 Job > Project。Target Registry 的 local-docker/remote-ssh endpoint、known-hosts、SSH/mTLS credential 由 Settings + SecretRef 管理；提交时固定 profile/target/environment revision/hash。claim 可由服务端 `runner_target_kinds` 过滤，runner/adapter 仍须执行前二次校验；offline/draining/capability mismatch 返回 blocked/retryable，不做 implicit local fallback。

## 19.1 论文复现

| 方法 | 路径 | 说明 |
|---|---|---|
| POST/GET | `/v2/projects/{project}/reproduction-specs` | 创建/分页列出 PaperReproductionSpec；Idempotency-Key |
| GET/PATCH | `/v2/projects/{project}/reproduction-specs/{spec}` | projection/revision CAS 更新 |
| POST | `/v2/projects/{project}/reproduction-specs/{spec}/attempts` | 固定 Contract/Code/Data/Environment 并提交 attempt |
| GET | `/v2/projects/{project}/reproduction-attempts/{attempt}` | attempt、Job/Run、pins、NextAction |
| POST | `/internal/reproduction-attempts/{attempt}/reports` | verifier service identity 写不可变报告 |
| GET | `/v2/projects/{project}/reproduction-reports/{report}` | 安全报告 metadata/Artifact refs |

精确 schema、metric/table/figure/PDF 比较和错误语义见 `reproduction-contracts.md`。Chat `/reproduce` 是这些接口的 adapter，不直接构造 Evidence/Report。

## 20. Trajectory 与 Subagent Topology

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/bff/research/projects/{project}/trajectories` | Research/Session roots，cursor/source/status |
| GET | `/bff/research/trajectories/{id}/nodes` | parent_id 的 direct children，懒加载 |
| GET | `/bff/research/trajectories/{id}/nodes/{node}/history` | message-aligned 安全 history；不激活 Agent |
| GET | `/bff/research/trajectories/{id}/events?after_seq=N` | subscribed/event/gap SSE |
| POST | `/bff/research/trajectories/{id}/nodes/{child}/followups` | exact parent + continuable + capability |

每个全局 trajectory/node ID 先解析 project，再做 summary/detail/continue AuthZ。history 默认 safe summary；raw tool args/results/prompt/env 不得透明透传。地址、事件、token/duration、retention 和 DSH 移植边界见 trajectory-subagents.md。

Standalone v1 adapter 兼容面（当前 Scholar UI 使用）包括 `/v1/projects/{project}/trajectory`、`/trajectory-lanes`、`/topology`、`/topology/children` 与 `/v1/topology/{child}*`。BFF 必须对上述全部路由执行成员预检，并从服务端 operator session 注入 `x-principal-id`；客户端同名 header 不可信、不得透传。Kernel 继续 fail-closed：缺 principal=`422 principal_required`，非成员/未知 project 或 child=`404`。轮询 JSON 与 SSE 的身份转发不得分叉。

## 21. NextAction 兼容

`GET /v1/projects/{id}/projection`（v2 同路由）只返回 `next_actions_v2: NextAction[]`（GUIDE-01 权威结构化投影，wire 字段见 reconstruction-contracts.md §24 / domain-model.md §14）。旧 `next_actions: string[]` 已删除；缺失或畸形结构化字段不得由 display label 推导可执行操作。

NextAction 由 Kernel 从 project status、pending gates、jobs、budget、contracts、ideas、evidence、claims 确定性生成（`nextActionProjection` 纯函数，无 DB、无副作用、不抛错）。状态、reason、required 缺口、revision、capability 和 target route 都由 Kernel 产生；UI 只负责翻译 label、解析白名单交互与路由，不能直接执行未声明 mutation。未知/未来状态退化 `code='unknown'` 的只读动作（state=blocked、required=['state_mapping']），UI 不得为 unknown 构造 mutation。`required` 是前置条件，`required_by` 才是执行者。Intake/Grill 阶段动作在 ONBOARD-01 落地后由同一投影扩展。

Contract 批准后的 baseline handoff 使用专用 `POST /v1/projects/{id}/baseline-runs`，普通 `POST .../jobs` 不接受 `kind=baseline`，也不允许浏览器用“先 POST Job、再 POST transition”的两步写法。请求严格为 `{expected_revision,idempotency_key,contract_id,code_snapshot_id,seed?:integer,data_artifact_ids?:string[0..1],command:string[],runner_target_id?,image_digest?,output_contract?}`；`command` 至少一个非空 argv，CodeSnapshot 必须属于 path project，Contract 必须已由 Human Gate 冻结且属于同项目。可选 seed 与 Data Artifact 用于 matched-seed 复现，必须进入请求 hash；Data Artifact 必须属于 path project、可按内容 hash 重验，并同时固定到 Job `payload.seed`/`payload.data_hash`、`data_artifact_ids` 与签名 RunManifest，不能只存在于 argv。Kernel 以项目默认 Runner/Profile/target 为基础解析环境；显式 override 仍走同一 registered target 与 digest pin 校验。首次调用从 `CONTRACT_APPROVED` 原子创建 queued Job 并推进到 `BASELINE_REPRO`；matched-seed 追加运行仍调用同一端点，只能绑定首个 baseline 的同一 approved Contract，并保持阶段/revision 不变。成功 `201` 返回 `{project,job}`；任何失败零半写。相同 project + idempotency key + 相同请求可重放，异请求必须 409。

`ExperimentContract.baseline_run` 只保存科学约束/描述，绝不是 shell argv。它无论是否非空都不能满足 `baseline_command`；调用方不得从该字段猜命令。只有上述请求中的非空 `command:string[]` 通过 schema 与 Kernel 校验后，才建立 executable baseline。

Remote Runner 通过双重身份保护的 `POST /v1/runner-targets/{target_id}/heartbeat {expected_revision,health:'online'|'offline'}` 写入观测状态与 `last_seen_at`：共享 `x-service-token` 仅允许进入 internal route；另一个只发送到本端点的 `x-runner-target-token` 必须与 URL target 在 Registry 中绑定的 `service_identity` SecretRef 恒时匹配。一个 target 的 token 不能更新另一个 target，自报 principal/target header 不参与身份判定。该 target-token wire 只接受 Node `req.socket.remoteAddress` 为 loopback 的直接连接，`X-Forwarded-For` 等调用方可控转发头不能放宽限制；非 loopback/生产必须由受信 mTLS 终止器把证书 peer identity 映射到同一 target allowlist，并经 loopback 转发，当前 plaintext Kernel listener 对非 loopback 直接请求返回 403 `loopback_only`。配置 revision 不一致返回 409；配置修改把状态重置为 unknown。readiness 的远端 heartbeat TTL 固定 60 秒，超时、unknown/offline、service identity/连接 SecretRef unavailable 或 capability mismatch 都不得投影 ready，也不得接受新远端 Job。

`GET /v1/projects/{id}/code-snapshots` 只列出该项目的不可变快照摘要，供运行准备任务选择；不得返回宿主绝对路径或跨项目记录。`POST .../code-snapshots` 仍是从批准 Workspace 冻结实际内容的唯一创建路径。

当 projection 为 `CONTRACT_APPROVED`、baseline Jobs 为空时，`next_actions_v2` 必须包含 `baseline_reproduce`，并通过 `required` 精确报告 `baseline_command`、`code_snapshot`、`runner_environment` 缺口。Runs UI 将其显示为 projected preparation task，但 `jobs.length` 与各 Job filter count 保持 0；不得用假 queued Job 填充列表。

合同阶段使用 `POST /api/chat/contracts/draft {project_id}`。BFF 仅在 Kernel projection 声明 `contract_register/ready/required=true` 时读取唯一 approved IdeaCard，从其 MVE 生成严格 ExperimentContract 输入，再调用 PI/operator-only `POST /v2/projects/{project_id}/contract-gate`；Kernel 输入钉定 expected_project_revision、idea_id、expected_idea_version 和 contract body，在单事务校验 Idea Gate 结果、登记 draft Contract、`IDEA_APPROVED→CONTRACT_PENDING`（若已在 CONTRACT_PENDING 则保持）、创建唯一 payload-bound pending Contract Gate。响应返回 contract/project/gate；跨项目、无 approved idea、已有 pending Contract Gate、revision 冲突或 schema 错误均零部分写。浏览器不得自行串联 register/transition/create-gate 三个写请求。

`survey_run` 固定 `route='chat'`、`required_by='agent'`。Overview CTA 打开当前 project-scoped Chat 并预填 `/survey <Brief.problem>`（Brief problem 为空时预填 `/survey `），等待用户确认发送；不得跳转空 Runs、不得自动发起 connector 请求。`POST /api/chat/survey` 成功写入 SCOPED 项目的 Corpus Snapshot 时，同一 Kernel 事务完成 `SCOPED→SURVEYING`，响应后 projection 必须给出 `idea_generate`；citation edges 必须随 snapshot 保存，connector 每源结果必须聚合为权威 `source_status`（任一来源失败=`pending`，全部成功=`complete`），部分失败不得伪装成 complete。

## 22. SSE 实时流端点（增量流替代轮询）

三个 v1 stream 端点与 §9 Terminal SSE 同模式（Content-Type `text/event-stream`、`Cache-Control: no-store`、`x-accel-buffering: no`、连接前完成鉴权——错误以 JSON 返回、绝不半开 SSE；`after_seq`/`after_revision` 重放、live 尾随、命名 `heartbeat` 事件（服务端周期发送，`data: {"time": …}`，客户端不得伪造/依赖其语义）。服务端以 ~200ms 轮询**既有轮询数据源**（pty frames store / workspace op-ledger listSince / trajectory outbox 投影）并推送增量——stream 与 poll 读同一份数据，永不漂移。轮询端点全部保留（向后兼容），客户端自行选择流或轮询。

### GET /v1/pty/sessions/{id}/frames/stream?after_seq=N&expected_generation=G

PTY-01 帧流（对应轮询 `GET /v1/pty/sessions/{id}/frames?after_seq=&expected_generation=`）。鉴权与轮询 frames 完全一致（fail-closed）：缺 `x-principal-id` → 422 `principal_required`、非 owner → 403 `pty_principal_mismatch`、未知会话 → 404 `pty_session_not_found`、`after_seq` 非法 → 422 `pty_after_seq_invalid`；`expected_generation` 与当前 generation 必须精确相等，缺失或过期均拒绝；`x-pty-lease` 必填，缺失 → 403 `lease_required`，错误或过期 → 403 `lease_invalid`。事件：

~~~text
event: subscribed
data: {"session_id":"pty_x","last_seq":41,"retained_from_seq":1}

event: frame
data: {"session_id":"pty_x","seq":42,"type":"output","payload":{"text":"…","byte_length":128,"channel":"stdout"},"time":"…"}

event: gap
data: {"session_id":"pty_x","seq":5,"gap_from_seq":5,"gap_to_seq":40,"dropped_bytes":2048,"dropped_frames":36,"retained_from_seq":41,"time":"…"}

event: exit
data: {"session_id":"pty_x","seq":99,"exit_code":0,"signal":null,"time":"…"}

event: heartbeat
data: {"time":"…"}
~~~

规则：`seq` 为会话内单调 server_seq，客户端按 seq 去重；`gap.seq` 取首个被淘汰序号（与 Terminal SSE 约定一致），游标推进到 retained 窗口；`exit` 是权威终态并结束该连接（可经 `after_seq` 重放续接）；心跳为命名事件（服务端周期发送）。

### GET /v1/projects/{id}/workspaces/{wid}/watch/stream?after_revision=N

WORK-01 workspace 变更流（对应轮询 `GET …/workspaces/{wid}/nodes?after_revision=` watch feed）。鉴权同 project-scoped 读（fail-closed）：缺 `x-principal-id` → 422 `principal_required`、非成员 → 404 `project_not_found`、`after_revision` 非法 → 422 `invalid_revision`；workspace 钉定路径项目（跨项目 → 404 `workspace_not_found`）。事件：

~~~text
event: subscribed
data: {"workspace_id":"ws_x","project_id":"rsp_x","revision":7,"after_revision":0}

event: change
data: {"workspace_id":"ws_x","revision":7,"node":{"path":"src/a.ts","kind":"file","version":2,"etag":"…","hash":"…","size":…,…}}

event: delete
data: {"workspace_id":"ws_x","revision":7,"path":"src/old.ts"}

event: heartbeat
data: {"time":"…"}
~~~

规则：`change` 携带该路径**当前**节点（与 listSince 投影一致——中间 revision 收敛为最新状态），`delete` 为 tombstone；每批推送后游标前进到 workspace 当前 `revision`，重连以 `after_revision` 续传无重复。文本节点不随事件携带 content（节点字节另经 `GET …/nodes?path=` 读取）。流无自然终态（open-ended），断开由客户端按 `after_revision` 重连。

### GET /v1/projects/{id}/trajectory/stream?after_seq=N&after_event_id=…&lane=research|session

TRAJ-01 trajectory 增量流（对应轮询 `GET …/trajectory`，同一 keyset 投影——redaction 由投影保证，raw payload 永不出现）。鉴权同 trajectory 轮询（fail-closed）：缺 `x-principal-id` → 422 `principal_required`、非成员 → 404 `project_not_found`。`lane` 过滤 research/session 双泳道（缺省 = 双泳道合并）。事件：

~~~text
event: subscribed
data: {"project_id":"rsp_x","lane":"research","after_seq":11,"after_event_id":"evt_…"}

event: entry
data: {"entry_id":"evt_…","event_seq":12,"event_version":1,"project_id":"rsp_x","aggregate_type":"project","aggregate_id":"rsp_x","kind":"job.submitted","lane":"research","source":"kernel-outbox","occurred_at":"…","session_id":null,"summary":"…","status":"running"}

event: heartbeat
data: {"time":"…"}
~~~

规则：keyset 与轮询页完全一致——`(after_seq, after_event_id)` 以 (event_seq, event_id) 排序，相等 seq 跨 bucket 由 event_id 续传；**精确续传必须同时携带 after_event_id**（最后一条 entry 的 `entry_id`，subscribed 事件回显当前游标）；仅带 `after_seq` 时与轮询语义相同（同 seq 平局条目会重放，客户端按 `entry_id` 幂等去重，绝不漏数据）。`summary` 为白名单 redacted 投影。流无自然终态，断开按 keyset 重连。

### BFF 透传

standalone BFF 对三个 stream 路由与 Terminal SSE 同等处理：bearer 401、CSRF GET 豁免、project/global-id 路由在**首字节前**完成 membership（非成员/未知 → 404 JSON，零 SSE 字节）、`x-service-token` 注入同现有、`x-principal-id` 注入（pty 流走 `/v1/pty/sessions` 既有规则；watch/trajectory 流由 BFF 对 `…/watch/stream` 与 `…/trajectory/stream` 注入 server-derived 身份）；`proxy_buffering off` 由 nginx 层处理（响应头含 `x-accel-buffering: no`）。

## 23. DSH 原生 Scholar 对话与阶段投影

### Agent Tool `dsh_scholar`

输入为 `{text: string, project_name?: string, project_id?: string, locale?: "zh"|"en"}`，`text` 去首尾空白后 1–4000 字符。调用上下文必须提供 DSH agent/session id；该 id 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`，ResearchClient 将其 `encodeURIComponent` 后作为一个 path segment 发送。未提供 `project_id` 时只按该 session link 解析项目，提供时必须与 link 精确一致。`project_name` 必须等于确定性创建语法从本次原文命令后缀解析出的完整 1–120 字符名称（可去掉一对包裹引号），不能只是其中子串；它不能由模型补写、改写或从历史消息推断。输出为：

~~~json
{
  "linked": true,
  "session_id": "session_abc123",
  "assistant_text": "…",
  "intent": {"kind": "status", "confidence": "deterministic"},
  "execution": {"status": "read_only", "operation": "research_status", "suggested_command": null},
  "project": {"project_id": "rsp_…", "name": "…", "status": "SCOPED", "revision": 2, "brief_status": "confirmed"},
  "stages": [
    {"id":"init","state":"done"},{"id":"survey","state":"current"},{"id":"idea","state":"upcoming"},
    {"id":"reproduce","state":"upcoming"},{"id":"contract","state":"upcoming"},{"id":"experiment","state":"upcoming"},
    {"id":"evidence","state":"upcoming"},{"id":"writing","state":"upcoming"},{"id":"review","state":"upcoming"},
    {"id":"release","state":"upcoming"}
  ],
  "next_action": {"code":"survey_run","label":"Run survey","reason":"corpus required","route":"chat","state":"ready","blocking":false,"required_by":"agent","required":true,"revision":2},
  "summary": {"pending_gates":0,"jobs":{"total":0,"queued":0,"running":0,"succeeded":0,"failed":0},"counts":{}}
}
~~~

`assistant_text` 按 `locale` 或 CJK 输入检测选择 zh/en；wire enum/id、Kernel 提供的 NextAction label/reason 不翻译，浏览器阶段 label/state 由 UI 字典本地化。未关联时，只有整句锚定的肯定创建指令且 `project_name` 等于确定性语法解析出的完整名称才执行 `project_create`；名称子串、疑问句、否定/取消/避免语义、主题讨论、仅模型填入名称或名称不一致全部零写。肯定创建但缺名称时返回 `execution.status="needs_project"` 并用自然语言追问名称，不强制用户先输入 slash；普通未关联对话仍可建议 `/new <项目名>`。`dsh_scholar` 是 unknown role 唯一可执行一般研究意图/创建/Survey 的公共 façade；另有 §24.2 一组 exact-session methodology tools 只允许读取或追加当前会话绑定项目的严格记录。除此以外，unknown role 仍默认拒绝普通研究工具。其余自动执行集合固定为权威 ready `survey_run`，且要求本次文本含锚定的正向开始/继续/执行动作。检索后重新读取并核验相同 project、revision、session link 与 `survey_run/ready/agent`，Corpus Snapshot 请求携带 `expected_revision` 和 `expected_session_id`，Kernel 在同一事务内核对 revision 与 session→project 绑定；调用 mutation 前检查取消，mutation 开始后进入不可回滚 commit boundary。创建 POST 若在提交后断线、超时或收到 AbortSignal，adapter 必须用同一幂等 key、相同 request hash 和无 caller signal 的 replay-only 请求读取已提交回执；不存在回执时保持原错误与零写，只有回执及权威 link/投影全部一致才返回 executed，绝不能把恰好同名的其他 link 当作本次成功，也不能重建第二个项目。非输入类 Kernel/网络错误统一为稳定 `dsh_scholar is temporarily unavailable`，不得暴露 endpoint/path/upstream message。其他 mutation 返回 `suggested`/`blocked`/`needs_human`，Human-only 永远不执行。

### Connection RPC `/dsh-scholar-view`: session workspace

`session-workspace` 请求严格为 `{session_id}`。未关联返回 `{session_id, projection:{linked:false,session_id,stages:[…]}, available_projects:[…]}`；已关联返回相同 root、`projection:{linked:true,…,methodology:{…}}` 与空 `available_projects`，其中 methodology 是与该 session link 同 project 的 compact Protocol/Synthesis/Assurance/Writing/Knowledge/NextRecommendation 摘要。Host 在列表/projection 读取后再次核对 link，不一致则重试后 unavailable。`session-bind` 请求严格为 `{session_id,project_id}`，调用 internal link route 后返回已关联 workspace；`session-create` 请求严格为 `{session_id,project_name}`，使用确定性 idempotency key 调用 internal name-only create+link 后返回 workspace，transport 丢失只允许 replay-only 对账。客户端必须精确校验 root/project option/projection/stage/NextAction/methodology/summary/jobs，不允许额外字段；methodology 的 `project_id` 必须等于 linked project，响应 session 精确相等、十阶段固定顺序、完整 NextAction/jobs 结构，动态 counts 全为非负有限整数。session 切换的 AbortSignal 必须传到底层 fetch，旧读取和 mutation 被取消且 UI busy 复位。

## 24. Methodology / Knowledge API

**当前实现边界。** 下列 HTTP route、typed `ResearchClient` 方法与 standalone 通用 `/v2` BFF 转发已注册。浏览器不能提供或覆盖身份头；BFF 注入自己的 principal，Kernel 再从 durable project membership 读取实际角色。项目读取要求 member，普通写入要求 `pi|researcher`，Audit acceptance、Direction adoption 与 Pack activation 要求 `pi`，global Package 注册/读取/评测要求至少具有一个未删除项目 durable `operator` membership。缺 principal 返回 422 `principal_required`，无 membership/跨项目对象返回 404，角色不足 403，revision CAS 冲突 409，strict Schema/未知字段 422。

进程内领域 seam 仍是规则的唯一实现：

- `verifyAssurance(...)` 与 `AssuranceStore.record(...)|accept(...)|get(...)|list(...)|project(...)`；
- `evaluateResearchMethodology(...)`，以及 `MethodologyStore.recordProtocolRevision(...)|getProtocolRevision(...)|listProtocolRevisions(...)`、ResearchSynthesis 与 Direction Proposal/Adoption 对应的 record/get/list；
- `resolveKnowledgeActivation(...)`，以及 `MethodologyStore.registerKnowledgePackage(...)|recordKnowledgeEvaluation(...)|activateKnowledgePackage(...)|getKnowledgeActivation(...)|listKnowledgeActivations(...)`；
- `assessWritingMethodology(...)`，以及 ReverseOutline/ReviewFinding 对应的 record/get/list 与 `MethodologyStore.assessWriting(...)`。
- `buildResearchGraph(...)`：只从已解析 Protocol/Synthesis/Direction/Adoption 重建 stable typed nodes/edges；不拥有数据库或 mutation。

Store 负责 strict parse、append-only、CAS、跨项目 404 和领域规则；HTTP adapter 只负责 route body、principal/role、path/project identity 与稳定 status。二者不得互相复制判定逻辑，也不提供通用 JSON、Chat transcript 或 config blob 写入。

### 24.1 Live HTTP contract

- `GET /v2/projects/{project_id}/methodology`：返回 verifier-backed Assurance、最新 Protocol、按 live Project/NextAction revision fence 复核的 Synthesis、激活 Pack、live TeX/Claim–Evidence hash-backed Writing diagnostics，以及 Audit/Research Graph topology count 的 compact projection；当前 adapter 不重算 Synthesis 内容 `input_hash`，也不含 Direction 列表、第三方正文或秘密。
- `GET /v2/projects/{project_id}/methodology/graph`：返回从该项目 Protocol/Synthesis/Direction/Adoption 重建的只读 `nodes[]/edges[]`；typed `ResearchClient.getMethodologyGraph(...)` 使用相同 wire。跨项目记录或 ref pin 冲突 fail closed，Graph route 不提供写操作。
- `GET /v2/projects/{project_id}/assurance-audits`、`POST .../assurance-audits/{audit_id}/accept`：读取 append-only Audit 与独立 Human acceptance。不存在通用 raw Audit POST；调用方不能直接提交 verdict、reviewer independence、provider 或 topology 事实。
- `POST /v2/projects/{project_id}/assurance-executions`：public strict body 仅为 `{expected_revision,audit_kind:"writing"|"claim-evidence",mode:"deterministic",semantic_review:null}`，project 只来自 path。只分派已注册 deterministic producer；不支持的 kind/mode、未知字段、错误 AuthZ 或 stale CAS 均零写。`claim-evidence` producer 在 Claim 集为空时仍写 immutable findings Artifact 与 `NOT_APPLICABLE` Audit，并固定 paper/tex-source 及 `claim-evidence:{project_id}` hash；新增 Claim/accepted Evidence 变化后 compact live resolver 将旧 Audit 判 stale。
- `POST /internal/dsh-sessions/{session_id}/assurance-executions`：只接受 service token + `dsh-plugin` audience/token，并重新解析 exact durable session-project link。semantic receipt 只作为受控 producer 输入；Kernel 从 immutable findings Artifact、durable StageSubagent topology 和 child execution identity 派生 Audit 的 provider/independence，忽略 caller 声明的 independence。缺 execution identity、空 reviewers、未完成/错误 child、错项目/session/action 或 stale CAS 全部在任何 Artifact/Audit/rollout consumption 前失败；provider unavailable 返回 503 `semantic_reviewer_unavailable`，其他空 panel 返回 422 `semantic_reviewer_required`，均不保存 BLOCKED Audit。合法 partial/complete panel 才可产出 provisional Audit；same-model/same-family 只能 provisional，Human acceptance 仍走独立 endpoint。
- `GET|POST /v2/projects/{project_id}/protocols`：POST 只接受完整 `ProtocolRevision`；frozen revision 不可更新。正式或 `confirmatory` Job 必须显式携 `protocol_pin` 与 `run_intent`，Kernel 在零 Job 写入前复核 project/intent/hash/Contract/Code/Data/Environment pins。
- `GET /v2/projects/{project_id}/run-outcome-observations`：member-only、project-scoped 返回 strict execution-only observation ledger 及 `pending[]/pending_count`。每条观察固定 `job_id/run_id/attempt_no/lease_generation/manifest_sha256/protocol_pin/job_execution/failure_class/intent`，不含 scientific outcome/validity；`manifest_sha256` 对完整 manifest 使用共享递归 canonical JSON（所有 object depth 排序、array 保序），必须覆盖 nested `resources/environment/outputs/lease`。分类前以同一规则复算，任一嵌套变化返回 409 `research_run_observation_stale` 且分类/outbox 零写；缺 principal 为 422，outsider/cross-project 为 404。typed Client 使用 `listRunOutcomeObservations(...)`，不得从 Job exit 自行推断科学分类。
- `GET|POST /v2/projects/{project_id}/research-runs`：GET 返回 immutable classified outcomes；POST 要求 durable PI/researcher，body 的 `record` 只允许 `run_ref/project_id/outcome/validity/analysis_artifact_id/evidence_refs/recorded_at`，execution、intent、Protocol、attempt 与 manifest 由 Kernel 从 exact pending observation 反查。成功记录分类 principal；不存在 observation 为 404 `research_run_observation_not_found`，stale attempt/lease/manifest/Protocol 为 409 `research_run_observation_stale`，execution 与分类冲突为 422 `research_run_execution_classification_mismatch`，run stream CAS 冲突为 409。分类、`research.run.classified` 与命中的 `research.synthesis.requested` 在同一事务提交；任何一步失败全部回滚。
- 未分类 observation 投影 `run_outcome_classify`；确定性 trigger 命中后只投影 `synthesis_record`。request 固定 trigger 与窗口内完整 `source_run_refs`、Project revision 和 NextAction revision；它不生成 ResearchSynthesis 内容、不改变 Project phase/Gate/Release。infrastructure failure 不创建 NegativeFinding，exploratory positive 只能创建 proposal-only hypothesis；full-auto 不执行科学分类。
- `GET /v2/projects/{project_id}/synthesis-requests` 与 typed Client 向项目成员返回 append-only `requests[]` 及仍待处理的 `pending[]`，使 Agent 能取得 exact window/source/pins，不从 NextAction label 猜参数。`GET|POST /v2/projects/{project_id}/syntheses` 的 POST strict body 为 `{request_id,record,expected_revision}`。Kernel 必须先从 request ledger 找到同项目仍 pending 的 request，再要求 ResearchSynthesis 的 project/window/snapshot pin、当前 Project/ready `synthesis_record` NextAction revision 及 `inputs.run_refs` 集合与 request 完全一致；不存在、已消费、stale revision/window 或增删/替换 Run ref 均返回 typed 422 且 Methodology stream/telemetry 零写。成功才 append Synthesis 并消费其 window；DSH `research_methodology_status` 返回 pending request details，`research_synthesis_record` 必须提供其中的 request id，不能只凭当前 Store CAS 写入任意内容。
- `GET|POST .../directions`、`POST .../directions/{proposal_id}/adopt`：proposal append-only；adopt 由 durable PI 派生 Human actor并使用当前 Project/NextAction revision。adapter 从 `gate_decision_ref` 解析 durable Decision，沿其 `gate_id` 读取同项目专用 `direction` Gate，strict 校验 payload 的 `purpose=direction_adoption`、当前 proposal id、source synthesis id 与 direction，并确认 approved Decision principal 是项目 Human PI/operator；随后只把该 verified receipt 交给 evaluator。pivot/broaden 必须携此 receipt。错误 Gate type、空/畸形/错 proposal/synthesis/direction payload、跨项目、非 Human、非 PI/operator 或非 approved Decision 均 422 且零 Adoption 写。成功只追加 Adoption，不直接修改 Project/Scope/Contract。
- `GET /v2/projects/{project_id}` 的 `next_actions_v2` 同时包含 fresh Methodology overlay。需治理且未 adoption 的 Direction 使用 `direction_gate_review`：exact pending Direction Gate 时 `ready` 并 refs 精确包含 gate/proposal/synthesis；Gate 缺失或 payload/wiring 错误时同 code `blocked`，`required` 给出稳定 diagnostic，且不得引用错误 Gate。stale project/基础 NextAction/input hash 或跨项目记录使用 `direction_overlay_stale|direction_overlay_invalid` blocked diagnostic，绝不产生 mutation CTA。
- adopted Direction 产生 revision-bound `direction_deepen_continue|direction_broaden_intake|direction_pivot_intake|direction_conclude_prepare|direction_pause_review`。需 Gate 的 adoption 在每次投影时以 `gate_decision_ref` 重新 join durable Decision + Gate，复核 decision/gate 同项目、approved、gate id 一致和 strict proposal/synthesis/direction payload；缺失/错绑返回 blocked `direction_overlay_invalid`，不产生 continuation。每个合法 action refs 固定 adoption/proposal/synthesis/project，revision 固定当前基础 NextAction revision；broaden/pivot route=`overview` 且只进入已有 Intake continuation proposal seam。compact `GET .../methodology` 的 `next_recommendation` 直接选择这些 Kernel action 并返回固定 `label_key`；standalone/DSH 只做 exact code/label-key allowlist 映射，不从 direction 或自由文本推断。
- `GET /v2/projects/{project_id}/knowledge-activations`：读取项目 Activation。`POST` body 只接受 exact package name/version/manifest+payload hash、`explicit_human_activation=true` 与 activation/registry/project/NextAction CAS；不接受 `project_id`、`session_id`、`phase` 或任一 capability 数组。浏览器 BFF 以可信 session context 注入 principal session，Kernel 从 durable session-project link、当前 Project/NextAction、durable PI membership、Scholar 本地 policy 和当前 capability envelope 派生完整 resolver request；unlinked/foreign/stale/forged authority fact 均零写。
- `POST /internal/dsh-sessions/{session_id}/knowledge-activations`：DSH exact-session adapter 只接受 service token + `dsh-plugin` audience/token及上述 identity-only body，不接受 principal/project/session 覆盖；Kernel 从 path session 的 durable link 派生全部 authority。成功仍只激活 Operator 已注册、已评测、内容 hash 精确一致且未 revoke 的本地 Pack。
- `POST /internal/methodology/native-packs/reconcile`：DSH plugin 启动期 reconcile 专用；同时要求正确 `x-service-token`、固定 `x-service-principal: dsh-plugin` 与独立 `x-dsh-plugin-token`。Kernel 对专用 token 恒时校验；缺失/错误任一凭据均 403 且 Registry revision 不变。`ResearchClient.reconcileNativeKnowledgePacks()` 只从构造时的 `dshPluginToken` 发专用 header，不接受 caller principal/token 参数。共享 service token 或自报 audience 不能单独写 Registry；Operator public `/v2/methodology/native-packs/reconcile` 保持独立 durable membership 路径。
- `GET|POST /v2/projects/{project_id}/writing-reviews`：只接收 revision/hash-bound ReverseOutline 与 ReviewFinding diagnostics；不直接写 canonical TeX。
- `GET|POST /v2/projects/{project_id}/writing-patches`、`POST .../writing-patches/{proposal_id}/apply`：proposal 绑定 exact reviewer child/input/compile/file hash；apply request strict body 只含 `{expected_revision,expected_document_revision,expected_tex_sha256,expected_claim_evidence_sha256,expected_compile_pin}`，删除 `actor` / `auth_method`。standalone BFF 从 bearer session 解析 Human Principal、fresh project membership 与 PI/Writer capability，再由可信 server session 传给 Kernel；Kernel 只接收 server-verified Human principal。浏览器 body/header 伪造、Agent/service principal、direct bearer 或自报 researcher/PI 不能获得 apply 权限；由可信 session 解析出的 PI/researcher 正常可写。Kernel 在 TeX mutation 前写 `writing_patch_intents`，重启时只对“精确旧 hash/version”或“精确 replacement hash/next version”进行确定性完成，其他状态 loud fail；application receipt 与 intent completion 在 Kernel SQLite 单事务提交。

full-auto Gate approval 的 `idempotency_key` 属于 Kernel 全局命名空间。Kernel 在任何 Gate/Decision 写之前计算 canonical request digest，精确绑定 operation version、path project、path Gate 与 strict body 的 expected project revision，并以 key 持久 ledger：同 key + 同 digest 仅重放原 receipt；同 key + 不同 project/gate/revision/body 恒为 409 `idempotency_conflict`。ledger 跨项目、跨 Gate 且 close/reopen 后仍生效，不能由某 Gate 局部 receipt 查询绕过。
- `GET|POST /v2/methodology/packages`、`POST /v2/methodology/packages/{name}/{version}/evaluations`：Operator-only global registry。首版 source 固定 `transport=local`，remote URL/branch/tag/短 SHA 均拒绝。

`POST /v1/projects/{id}/jobs` 的 request/response schema 接收、保存并回显 `run_intent` 与 `protocol_pin`。`ResearchKernel.submitJob(...)` 对 `kind=formal` 或 `run_intent=confirmatory` 先从 `MethodologyStore` 读取 path project 的 frozen Protocol，再用权威 approved Contract、Code/Data Artifact、Runner target/config、预算和网络边界调用 `evaluateResearchMethodology(run_admission)`；任何 blocker 都发生在 Job/Run/outbox 写入前。成功 Job 持久化 evaluator 已复核的 exact pin，Runner/Manifest 不能替换它。

### 24.2 DSH exact-session methodology tool contract

插件 canonical catalog 中下列 methodology 工具允许 root/unknown role 使用，但每次都从调用 DSH `session_id` 解析持久 project link，参数中没有可任选 `project_id`，缺 session/link 或 cross-project record 均在 HTTP mutation 前失败：

- `research_methodology_status`：只读 §24.1 compact projection；
- `research_protocol_record`：strict `ProtocolRevision` + methodology stream CAS；frozen Protocol 可由工具生成 deterministic canonical receipt，显式 hash 必须精确匹配；
- `research_synthesis_record`：只接收 strict `generated_by=agent` Synthesis，不冒充 Human/panel/model execution；
- `research_writing_review_record`：只追加 revision/hash-bound ReverseOutline 或 ReviewFinding，不执行 reviewer、不写 TeX；
- `research_knowledge_activate`：参数只含 exact package identity 与 activation/registry CAS；工具在调用前读取当前 Project/NextAction CAS，DSH Host 必须确认，internal adapter 从调用 session 派生 durable link，Kernel 再派生 PI、phase、NextAction、policy 与三组 capability。模型不能提交或覆盖 project/session/principal/phase/capability authority fact。
- `research_knowledge_deactivate`：Host-confirmed exact-session 撤销同一 activation，typed reason 与 append-only/idempotent 语义由 Kernel 执行。
- `research_assurance_run`：Host-confirmed exact-session 调用；参数只允许已注册 `audit_kind=writing|claim-evidence` 与 `mode=deterministic|semantic`，Store revision 由工具读取，不能指定任意 project。semantic reviewer 的 provider/family/independence 从 durable child execution identity 与 topology 派生，不信模型字段；缺 identity、空/未完成 panel 或 provider unavailable fail closed，后者只返回 typed diagnostic且零 authority write。合法 panel 才记录 findings/Audit/StageSubagent topology；工具不决定 Gate/Release、不改 TeX。

`skills/research-core/SKILL.md` 已说明这些工具在自然对话、Protocol、两层循环、Knowledge/Writing 和 Assurance 中的使用顺序；Skill 不能制造 stream revision、hash、Human activation、Gate Decision 或 reviewer identity。除上述 bounded tools 与 `dsh_scholar` façade 外，unknown role 对普通 research tool 仍 fail closed。

### 24.3 当前未闭环语义

- focused HTTP 测试覆盖 principal 缺失、跨项目 404、viewer/researcher/PI/Operator 核心矩阵、strict body、CAS、typed Client 和 compact projection；standalone 通用 BFF 已能转发，但尚无 methodology 专用 BFF/browser E2E 证据。
- focused Kernel admission 测试覆盖 formal 无 Protocol 零写和 exact frozen boundary；跨项目、draft/superseded、各类 pin mismatch、并发 revision 与完整环境矩阵仍需补齐。local-process Runner fixture 已覆盖 completion→pending classification→outcome→synthesis action、old attempt、原子回滚、重放与 reopen；真实本机 Docker formal positive fixture 进一步验证 signed Manifest 的 `run_id` observation、scientific-only request 与 replay。两者均不替代远端 SSH/GPU、生产 Docker 或真实科学判读验收。
- Direction adoption、Graph 和 compact freshness 已有 focused adapter 证据，但不自动派生/批准 Gate、不修改 Project/Scope/Contract，也不构成真实 reviewer orchestration 或 Human workflow 浏览器验收。
- compact `GET .../methodology` 已通过 Store/verifier/assessor 复算 Assurance 当前可解析 inputs 和 Writing 的 live TeX/Claim–Evidence hashes；无法解析的 Assurance ref 会 stale/missing，而不是信任旧 pin。Synthesis 当前只复核 live Project/NextAction revision，仍复用 persisted `input_hash`。该只读投影不能替代 submission、Gate 或 canonical TeX 权威判断；真实浏览器/ARIA/TeX 交互尚未验收。
- deterministic producer、immutable findings Artifact、StageSubagent semantic seam 与 DSH exact-session Assurance tool 已实现；生产 Host/model 执行与真实 DSH confirmation 仍待人工验收。Runner completion 已原子记录 execution-only observation，scientific outcome/run validity 只由授权 Human/Agent 显式分类；Kernel 不提供自动科学推断。三份 Scholar-owned native Pack 的 exact-context Chat/reviewer delivery 与 deactivate/revoke suppression 已实现，External Knowledge 只返回不可信 metadata。生产 Docker/SSH/GPU NegativeFinding、真实 reviewer/model、项目激活 UI、自动 Release 与专项 BFF/browser 仍待验收。
- 先前提出的八个 `methodology.*` / `knowledge_registry.*` 配置键没有 runtime consumer，现已从 Config Registry 删除；它们不是 live API/schema，写入必须作为 unknown key 拒绝。只有未来连同 consumer、持久化、config pin 与 file/HTTP/UI parity 一起实现时才可新增。

### 24.4 Rollout policy 与 redacted telemetry

- `GET /v2/methodology/rollout-policy`：durable Operator-only；返回当前 `{revision,mode,policy_hash,actor_ref,created_at}`。没有 durable Operator membership 时 403，缺 principal 时 422。
- `POST /v2/methodology/rollout-policy`：strict body `{mode,expected_revision}`；actor 只能来自已验证 Operator principal。成功追加新 immutable revision，stale CAS 为 409，未知字段为 422；不更新旧行。
- `POST /v2/projects/{project_id}/rollout-policy`：project PI-only；strict body `{expected_project_pin_revision,expected_policy_revision,expected_policy_hash}`。只允许 pin 当前全局 policy，actor 来自 path project 的 durable PI membership；成功追加 project pin event。
- `GET /v2/projects/{project_id}/methodology` 的 `rollout` 为 `{mode,policy_revision,project_pin_revision,telemetry}`。`telemetry.counters[]` 只含 `key,tags,value`，histogram 只含 `key,tags,count,sum,min,max`；只返回 `methodology.*` series，不返回 buckets、uptime、policy hash、actor、任意 identity、路径、hash、prompt、正文、token 或 secret。

Knowledge Activation 与 Assurance execution 的成功 response 对应一条数据库同事务 consumption pin。Kernel wrapper 在返回前核对 consumption pin 与执行前 project pin；不匹配按一致性错误 fail closed。Synthesis record/freshness、Knowledge delivery/deactivation、reviewer aggregate、Writing patch apply/recovery 和 Assurance execution 只写闭合枚举遥测，不新增 mutation authority。`methodology.rollout_mode` 不是 Config API key，file/env/UI Settings 写入仍按 unknown key 拒绝。

## 25. Chat scope 关闭与上传线性化

- `POST /v1/projects/{project_id}/chat-scopes/{scope_id}/tombstone`：关闭 exact Chat session。`scope_id` 使用 1–160 位安全 opaque-id；Kernel 以 `(project_id,scope_id)` 幂等持久化 tombstone，并在同一事务删除 chunk 行、把该 scope 的 open/finalized upload 转为 durable aborted ledger，文件 unlink 在提交后执行且失败/崩溃由 sweep 重试。重复请求返回成功，不能重新开放 scope。
- Chat 取得 Intake 时必须始终调用 `POST /v1/projects/{project_id}/intake` 并携带 `owner_scope_id`，禁止先 GET 后在客户端无 scope 选择 active Intake；Chat 发起 `POST /v1/projects/{project_id}/intake/{intake_id}/upload-sessions` 同样携带该值，普通 Intake 页面上传可省略。Chat 新建 Intake 持久化 scope provenance；scoped begin 只能复用 unscoped Intake 或同一 scope 的 Intake，禁止跨 Chat scope 复用，显式拿 scoped Intake 发起另一 scope upload 得到 `409 chat_scope_mismatch`。未显式给 upload owner 时必须继承 Intake owner，不得写 NULL 逃离 tombstone。已 tombstone 的 scope 返回 `409 chat_scope_closed`，且不得创建 Intake、session、chunk 或 artifact；multipart/direct stage 及 unscoped upload 也必须按 Intake 持久化 owner 在写事务内重检。tombstone 同时覆盖 upload 自身 owner 或所属 Intake owner 命中的 session。scoped Intake 的 tombstone check、idempotency replay、active reuse、insert，以及 upload begin 的 Project/Intake/scope/quota check + reservation，各自在一个 `BEGIN IMMEDIATE` 内线性化。
- Intake `Idempotency-Key` 是全局 key，但 exact replay authority 同时包含 path `project_id`、持久化 `owner_scope_id` 与 request hash；三者任一不同都返回 `409 idempotency_conflict`。服务端不得从另一 project/scope 返回已有 Intake，也不得仅依赖 caller hash 表达 path authority。
- append 在文件写入与 committed offset 更新所在的同一写事务内重读 upload、Project、scope 与 offset；finalize 在 hash 完成后、artifact promote 前的写事务内再次重读这些状态。这样 tombstone、abort 或 project delete 已先提交时，迟到 continuation 必须零权威写。
- 只有本 upload 新建仍为 `staged` 的隔离 artifact 时，session 才持有 `owns_artifact=1`。关闭后的补偿 abort 可删除该 artifact；去重命中、已扫描 artifact 不归本 session 所有。共享 staged artifact 的所有权在 abort 时转移；重复 abort 不得清零未完成的 ownership ledger。direct/multipart same-SHA stage 与 cleanup 使用同一写锁，stage 先接管新 generation，cleanup 只有在当前 artifact row 不存在时才 unlink，从而禁止旧账本删除后来重建的材料。
- 浏览器关闭 session 时由单一 lifecycle coordinator 先发布独立于 transcript 的 page-lifetime exact-scope tombstone，同步封死 turn、attachment、vision 与 upload continuation，再写 durable local outbox；若 storage 写失败，则保留可见 session 直到 Kernel ACK，但该可见项也不能重新提交或接受迟到 transcript/attachment 写。outbox 在项目激活和成功 project-list refresh 时自动重放，只有 tombstone route 的 2xx 才确认该条 close；route 404 同时可能表示防枚举 membership denial，不得当作物理删除 ACK。真正的项目删除由成功 project-list + projection authority reconciliation 调用 project discard，并在那里清理项目全部 outbox。网络/4xx/5xx 均不得丢单条 close outbox。
- page lifetime 只有一个 session/project tombstone authority；turn、attachment、upload、vision 与 transcript 都读取它，但每类资源独立持有自己的 controller/driver map。hydrated outbox 在远端请求前必须重建 tombstone。上传 queue failure wire 为 `{code,status?}`，2xx begin/append 也需 strict shape 与单调 offset 校验；malformed 或 offset regression 立即 fail-stop。

2026-09-06 remote/OCR runtime 补充：Fleet 注册与心跳必须转交 Agent 的 Target 专属凭据并等待 Kernel heartbeat 成功；`POST /v1/agents/{agent_id}/runs/{run_id}/heartbeat` 接收 claim_id/job_id 与 owner/generation/token，返回权威 running/cancelled 和最新租约 expiry，详见 [wire 规范](remote-runner-wire.md)。正常 Kernel HTTP 入口默认消费 OCR 队列，结果允许在缺少真实页/置信度元数据时仅有 Markdown 和空 observations，仍关联原始请求 pin，详见 [OCR 规范](init-grill-upload-models.md)。

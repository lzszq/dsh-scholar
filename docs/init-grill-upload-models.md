# Init、Chat Grill、批量上传与模型接入契约

> 规范性文档，覆盖旧文档中“创建时必须提交完整 Brief 并立即创建 Scope Gate”“Intake 只支持整文件 multipart”“模型只能从内置目录选择”的描述。实现、测试、UI 与使用指南必须同时遵守本契约；未通过真实浏览器、模型服务和大文件环境验证的能力标记为 `NOT_RUN_MANUAL_PENDING`，不能伪装为已验收。

## 1. Name-only Init

`POST /v2/projects` 的最小且默认请求只有 `{"name":"My research"}`。

- name 去除首尾空白后长度 1–120；`Idempotency-Key` 与 Human Principal 必填。
- Kernel 在一个事务中创建 `status=DRAFT`、`brief_status=collecting` 的项目、creator PI membership、默认 Budget 和一个 active Init Intake；不得创建 Scope Gate。
- workspace、预算、安全策略和 runner profile 使用服务端安全默认值。浏览器不得让用户在创建弹窗填写 endpoint、credential、host path 或高级配置。
- brief 数据库字段在 collecting 期间使用有明确标记的内部占位值，仅为旧读模型兼容；它不是用户确认的 Research Brief，不能进入 Gate、Run、Evidence、检索 prompt 或导出包。
- 相同 idempotency scope + 相同请求返回同一 project/intake；同 key 不同请求 hash 返回 409。
- v1 完整创建接口只作为兼容 adapter 保留，独立页面和 Chat 新流程只调用 v2 name-only 接口。

`brief_status` 只有 `collecting | confirmed`。collecting 项目的 NextAction 只能指向 `intake_answer`/`intake_resume`，不得显示可提交的 Scope Gate；Orchestrator 也不得为其自动补 Gate。

## 2. Chat Grill Me

创建成功后自动打开项目绑定 Chat，并恢复该项目 active Init Intake。Grill 是确定性状态机，不用自由文本 LLM 决定问题、完成度或权限。

“自由对话”不改变 Grill 的确定性：存在 current Grill question 时，普通文本只作为该题一个 Human answer 提交；用户要讨论而不回答时必须显式选择跳过/未知或切换会话。Brief confirmed 后，普通文本才进入 natural turn/intent router。模型可以改写问题或解释材料，但不能把聊天推断自动写成 Human answer、确认 Brief 或创建 Scope Gate。

Chat composer 必须持续显示带文字的“上传文件”按钮以及选择/拖放/粘贴提示，不能把入口隐藏为难以识别的单独图标。附件进入同一 active Intake 的批量分块队列；若当前项目没有 active Intake，composer 先为该项目创建一个隔离 Intake 再上传，不要求用户离开对话页。上传队列显示在 composer 内部，消息只保存 attachment/stage ref；scan/OCR 与 Human 确认前不写 Project Artifact。命令直接使用 `/new`、`/confirm-brief`、`/reproduce` 等一级 slash command；DSH 与 standalone 都不注册、不解析或兼容旧聚合 descriptor/prefix。

首版问题顺序固定且可版本化：

1. `brief.problem`：研究问题；
2. `brief.scope`：范围、明确不做什么；
3. `brief.questions`：待回答的研究问题；
4. `brief.primary_metrics`：主要指标及方向/口径；
5. `brief.target_outputs`：期望产出；
6. `brief.constraints`：数据、隐私、成本、算力和时间约束；
7. `brief.material_context`：已上传材料与从哪个阶段继续。

每轮 Chat 只返回一个当前问题，并携带稳定 `question_code`、`question_revision`、required、reason 和下一步提示。用户可回答、编辑历史答案、`skip` 或 `unknown`；每次提交只接受一个 code/revision/value。回答记录 Human Principal、时间和 `human_assertion` provenance。OCR/parser 发现只能作为带来源的候选答案，不得自动成为 Human answer。

所有必答问题处理后，Chat 展示完整 Brief 预览、unresolved gaps、材料引用和“确认并创建 Scope Gate”按钮。只有 PI 的显式确认事务可以：

1. 校验 project/intake/question revisions；
2. 写入 canonical ResearchBrief 并把 `brief_status` 改为 `confirmed`；
3. 创建且只创建一个 pending Scope Gate；
4. 写 Outbox/audit，返回 project、brief、gate 和下一步。

非 PI、Agent tool、parser、OCR worker 和模型均无 confirm/adopt/Gate Decision 能力。确认前刷新、重连或换设备必须从服务端 Intake 投影继续，不能依赖浏览器 localStorage 推断完成度。

## 3. 多材料与可恢复上传

用户可一次选择/拖入大量 PDF、图片、Office、TeX、代码、数据、日志和 archive。UI 使用批量队列，每个文件独立显示 hashing、queued、uploading、paused、scanning、needs-input、ready、quarantined 或 failed；队列级显示总配额、进度、失败数与下一步。

- 默认 chunk 为 8 MiB，instance 可收紧，最大 32 MiB；默认单 Intake 预留总量 2 GiB，instance 可配置但硬上限 10 GiB。
- stage 绑定 intake、project、Principal、文件名、media type、expected size/hash、expiry 和 committed offset；创建 stage 时事务性预留配额。
- chunk 使用 `Content-Range` 和 SHA-256。`start == committed_offset` 才追加；旧范围同字节/hash 重放成功且 `replayed=true`；gap、overlap 不同内容或 total 不同返回 409。
- finalize 只在 offset 等于 expected size 时进行，服务端流式重算完整 size/SHA-256；不一致返回 422 且不产生 IntakeArtifact。重复 finalize 返回同一 artifact。
- abort 幂等；开放 stage 至少保留 24h 并能查询 offset，浏览器刷新或断线后继续。扫描前字节只在隔离 Intake staging，不能写项目 Artifact/CAS authority。
- archive 的条目数、展开总量、单条目与压缩比限制独立于 Intake 总上传配额。

浏览器恢复契约：队列 metadata 只按 exact project/session 持久化，禁止保存 File、base64 或本地路径；普通项目切换不得清空 page-lifetime File。hard reload 后通过服务端 upload-session list 对账 status、committed offset 与服务端协商的 `chunk_size`，并提示用户重新选择文件；只有名称、大小、媒体类型及重新计算的 whole-file SHA-256 与原 stage 全部一致才可从 offset 继续。缺失、expired、aborted 或身份不匹配的 stage 必须清除旧 upload id/offset/chunk cap，重选后重新 begin，不能循环请求失效 stage。显式关闭 session 必须先 tombstone scope，拒绝迟到的 Intake/hash/chunk/finalize continuation，并 best-effort abort 已创建的 server stage；begin 或 append 在途返回后都必须重新检查 pause/liveness，不能覆盖用户暂停，owner 已关闭时须 best-effort abort 刚创建的 stage。项目删除还必须建立 project tombstone、清除 transcript 和全部 queue metadata、取消活动模型 turn；Kernel 在 tombstone 事务内删除 chunk 并把 open session 变成 durable aborted cleanup ledger，提交后清理隔离 `.part`，成功后才删 ledger，失败由 sweep 重试，浏览器不得在项目不可读后补发 abort。其他 tab/API/DSH 删除项目时，只有成功项目列表与目标 projection 404 的组合才允许清本地 scope；transport/5xx 保留恢复数据。旧 render 只有 frozen project target 仍被选中时才可提交可见 state，不能用 A 的迟到响应覆盖 B。

上传错误是 strict `UploadFailure { code, status? }`，队列不得持久化 raw `Error.message`、额外字段或 `"code:status"` 字符串；未知/旧形状直接丢弃损坏 row，不维护兼容读取。driver 读取单个 chunk 的 File slice/`arrayBuffer()`/SHA-256 失败进入 `upload_chunk_failed`；上传前 whole-file 增量校验失败进入 `upload_hash_failed`。begin/append 的 2xx body 必须是合法 JSON，并由 browser transport 与 injected driver 共用的 canonical validator 验证 exact project/intake/upload/file identity、正整数 chunk size 与有界前进的 committed offset，不得复制部分规则。合法 begin offset 是续传起点，old-range replay 可返回已进一步推进的当前权威 offset。malformed/identity mismatch response 或 offset 未前进/回退/越界将当前文件置为 failed 并立即停止 driver，不得重试同一确定性协议错误或继续写后续 chunk。

## 4. Model Provider、SecretRef 与项目绑定

后台上传 scope 同样参与外部删除回收：成功 project list 后枚举本页所有 page-lifetime scope store（transcript、upload、vision、turn、attachment-flight）持有的项目，列表缺失且 projection 404 时执行完整 project discard；不能只枚举成功写入 localStorage 的 transcript，也不能只清当前选中项目，storage quota/private-mode 写失败和网络/5xx 都不得造成错误释放或漏清仍在内存中的 File/queue。

关闭 exact Chat session 是服务端可恢复的 authority event，而非纯浏览器清理：本地先 tombstone exact project/session并同步取消 attachment-flight/turn/vision/upload，再把关闭意图写入独立 local outbox；outbox 已持久化或 Kernel 已 ACK 后才删除 transcript session，storage 失败则保留可见 session，项目激活/成功 project-list refresh 自动重放。Chat 创建的 Intake 和 upload session 均携带并持久化 `owner_scope_id`；Kernel 在同一事务写 durable tombstone并把相关 upload 转 aborted ledger，拒绝迟到 begin/append/finalize。客户端 AbortSignal 覆盖 Intake、分片 hash 与上传，且对取消交错的成功 finalize 做幂等补偿 abort。仅本 session 新建且仍 staged 的 artifact 可由补偿删除；重复 abort 不丢 ownership ledger，direct same-SHA stage 在写锁内接管新 generation，预存、去重、已扫描和后来重建的材料必须保留。

Model Provider 是 instance/global 资源；项目和 Intake 只能引用 opaque `provider_id` 与 `model_id`，不能携带 endpoint、API key、环境变量名或任意连接参数。

Provider descriptor 至少包含 provider_id、display_name、kind、base_url、enabled、capabilities（chat/vision/ocr/embedding）、可选 models 目录、revision 和 credential `SecretRef`。自定义 base URL 由服务端执行 URL 解析、scheme/host/redirect/DNS/代理 allowlist 与 SSRF 校验。浏览器响应只显示 SecretRef metadata 与 available 布尔值，不返回 secret value。

OCR-CONFIG-01 的首个内置 descriptor 是 MinerU：固定 `provider_id=mineru`、`kind=mineru`、官方 Open API 默认值 `https://mineru.net/api/v4` 和 `flash/pipeline/vlm` 模型目录。MinerU Flash 可省略 credential；Pipeline/VLM 绑定前必须存在 SecretRef。该固定契约由 Kernel 与 UI 双重校验，API 不能通过伪造 kind/id/catalog 绕过。Settings 写面完成 Provider 与项目 `purpose=ocr` binding；OCR request、worker、状态恢复、幂等、取消和 `observed_unverified` provenance 也已实现。真实 MinerU 网络调用仍为 `NOT_RUN_MANUAL_PENDING`。

~~~typescript
interface SecretRef {
  scheme: 'keyring' | 'file' | 'vault'
  name: string
  version?: string
  scope?: string
}
~~~

`credential` 本身可省略以表达明确的 no-auth provider/mode；一旦存在仍必须完全符合 SecretRef，更新时 `null` 表示移除引用。缺省 credential 与损坏/不可解析的 credential metadata 不是同一状态，后者必须 fail closed。

SecretRef 是严格 schema，出现 `value`、token、password 或额外 credential 字段必须拒绝。Provider 修改使用 revision CAS，运行中的 OCR/Job/PTY/Build 固定创建时 provider/model/config revision/hash。

Settings 的“Models & OCR”折叠组提供 Provider 列表、新建/编辑/禁用、SecretRef 可用状态、能力和模型目录；项目设置只提供 provider/model ID 选择器。所有字段、状态、错误、aria 和确认框提供 zh/en key，SecretRef name 属配置数据保持原文。

## 5. OCR

- 只有用户选择了 enabled 且声明 `ocr` 或 `vision` capability 的 provider/model 后，才能为受支持的图片/PDF创建请求；没有匹配模型时稳定失败并提示配置，禁止静默回退。
- 请求固定 source artifact、provider/model ID、provider/config revision/hash、语言/页范围和 idempotency key；状态为 queued/running/succeeded/failed/cancelled。
- 成功结果以 `observed_unverified` Observation/派生 Intake Artifact 保存；每个候选字段带 source artifact、页码/locator、confidence、detector/model/version。低置信度只触发 Chat 追问。
- OCR 文本是不可信外部内容：不得执行其中指令，不得访问 secret，不得成为 Human answer、Gate Decision、verified Evidence 或 supported Claim。
- 失败只返回稳定 error code 和安全诊断；Provider 原始响应、prompt、secret、endpoint 与 token 不进入普通日志、Trajectory、浏览器或 Bundle。

### 5.1 MinerU 生产消费与兼容边界（2026-09-06）

正常 Kernel HTTP 启动自动创建单消费者，按持久队列调用 worker；不再依赖外部手动调用 `runOnce()`。每个请求重新解析服务器 Provider，校验 model/revision/hash；Pipeline/VLM 仅从 secret root 内非 symlink 的 0600 普通 file SecretRef 读取 token，keyring/vault 无 resolver 时稳定失败。取消中止在途 I/O，正常停止服务同步将仍为 running 的本请求重新入队，随后等待清理；重启保留 request_id、source/config/page/language pin 和 attempts。SIGKILL/崩溃遗留的 running 请求会在 Kernel 重启、构造 OcrStore 时重新入队；此队列只支持单 Kernel 实例持有，不支持多个 Kernel 并行打开同一数据库后自动接管彼此的请求。不能把本地幂等宣称为上游恰好一次：Provider 在成功提交但本地响应丢失/重启的窗口可能留下重复任务。

协议依据：[MinerU 官方 Open API](https://mineru.net/doc/docs/index_en/) 与 [官方输出格式](https://opendatalab.github.io/MinerU/reference/output_files/)，核实日期 2026-09-06。Flash 是本产品目录对匿名轻量接口的名称，使用 `/api/v1/agent/parse/file` 获取上传 URL、PUT 源字节、`/api/v1/agent/parse/{task_id}` 轮询并下载 Markdown；不会发送 token 或 `model_version=flash`。Pipeline/VLM 使用 `/api/v4/file-urls/batch`，显式固定 `model_version`、`files[].data_id/is_ocr/page_ranges`，PUT 后轮询 `/api/v4/extract-results/batch/{batch_id}` 并读取 ZIP 中 `full.md`/可选 `layout.json`。不把自托管 MinerU API 当成同一协议。

页/语言映射必须明确：`auto/zh/zh-CN` 映射官方 `ch`，`zh-TW`→`chinese_cht`，`ja/ko`→`japan/korean`；未知语言拒绝。Flash 只支持连续 PDF 页范围且最多选择 20 页，不连续选择拒绝而非扩大到整文；精准模式发送精确页集合。页选择对图片只能表示单页 1。Flash 源文件最多 10 MiB，精准模式最多 200 MiB；上游实际页数/配额限制仍可能拒绝请求。

只保存规范化 Markdown 与真实带 page_idx/score 的结构化文本 span；页码使用上游零基索引加一，超出请求 pin 拒绝且不猜测重编号。Flash 只有 Markdown、或结果缺 score 时，observations 可为空，source/model/config/页选择仍由持久请求关联；不得从 Markdown 推测页码或填造 confidence=1。缺失/低置信度信息只能保留为未核实，不能自动生成 Human answer/Gate/Evidence。

连接期只允许官方 API origin 与文档中的三个精确传输主机：`mineru.oss-cn-shanghai.aliyuncs.com`、`oss-mineru.openxlab.org.cn`、`cdn-mineru.openxlab.org.cn`。HTTPS、无重定向、无环境代理；DNS 所有答案必须为可接受公网地址，连接固定已校验地址；Authorization 只发 API，不随签名上传 URL 或 CDN 下载转发。JSON/Markdown/ZIP 上限分别为 1/8/32 MiB，ZIP 使用现有路径/解压数量/大小/比例约束且只在内存读取，整体调用默认 10 分钟超时。错误只持久化安全 code，不保存上游 envelope、URL 或 token。

本地 HTTP 协议 fixture、真实 Kernel 二进制消费与取消/重启测试只证明实现和接线。真实 MinerU Flash/Pipeline/VLM、配额、跨网络下载与中英扫描质量继续为 `NOT_RUN_MANUAL_PENDING`。

## 6. Chat 视觉模型

Scholar Chat 的图片输入复用同一个上传入口，但“研究材料接入”和“当前轮视觉上下文”是两个相互独立的结果：文件继续进入项目 active Intake，Chat 消息只持久化 Intake stage ref；受支持图片的原始字节仅在当前自由对话请求中瞬态编码，不写入 Chat state/localStorage，也不得自动变成 OCR Observation、Evidence、Claim、Brief answer 或任何 Gate Decision。slash command 与确定性 Grill answer 不消费待发送图片；只有视觉模型成功完成自由对话轮次后，客户端才清除本轮视觉标记。待发送图片及其 `File` handle 必须由当前 project/session 的 live client state 持有，上传进度、附件消息或普通投影触发的局部/全页 render 不得清空；只有成功消费、用户显式移除、切换到不再持有该 live session 的页面或 hard reload 才可 fail closed。不得把 render-local `Set` 当作该状态的权威所有者。

浏览器到 standalone BFF 的闭合 wire 为 `images: Array<{mediaType,data,name?}>`，只接受 PNG、JPEG、WebP 与 GIF、最多 20 项，整个 JSON 请求受 16 MiB envelope 约束。一次选择、拖放或粘贴形成一个原子视觉批次：客户端必须先把该批次与当前 exact-session 队列合并，在读取任何 `File` 字节前一次性校验媒体类型、数量、原始大小与 base64 envelope 上界；任一项失败时本批零项进入视觉队列，也不得先读取前 20 项再在第 21 项失败。通过后才按顺序有界编码，并在最终 JSON 序列化后由 private bridge 再做精确 envelope 检查；不得并发读取全部图片再等待 BFF 拒绝。研究材料 Intake 上传与本轮视觉上下文相互独立，视觉批次拒绝不得伪装为视觉成功。每个待发送图片必须有可键盘访问的显式移除动作，移除只影响下一次视觉对话，不删除已进入 Intake 的材料。BFF 只做严格形状与媒体类型校验；canonical base64、实际字节类型、单图/聚合大小、像素、宽高和持久化由当前 DSH `AttachmentStore.imageLimits` 与 `admitEncodedImages` 权威执行。插件只把返回的 opaque `ImageAttachmentRef` 作为 DSH LLM `ImageBlock` 交给适配器，绝不把浏览器 data URL、文件路径或 base64 直接拼入 prompt、日志、Trajectory 或 Kernel 数据。

模型发现目录必须来自当前 DSH `ctx.llm.listProviders/listModels`，standalone 不维护静态模型名单；但目录只用于 discovery，绝不是请求白名单。模型选择值由 provider 与 opaque model id 组成，只在第一个 `/` 处分隔，后续 `/` 属于 model id。未限定模型名不再兼容且不得猜测 Provider；已保存的限定 route 即使不在 advisory catalog，也必须由所属 adapter 的 `ctx.llm.resolveModelInfo(provider, model)` 精确解析，成功则仍按原 route 使用，失败则显示不可用并 fail closed，绝不能静默改跑 Auto 或目录第一项。每个真实 turn 都必须重新解析 exact adapter metadata，不能直接信任 catalog 中可能过期的 capability。`inputModalities` 字段缺失表示 unknown；显式数组是权威声明，因此空数组或不含 text 的数组表示不能承载 Scholar 固定的 text prompt，必须禁用且不能拖垮其他目录项。视觉模型还必须同时显式包含 text 与 image，选择器才用 `👁` 标记。Auto 仅在用户没有显式选择时使用插件 PI 默认；两者都没有时才按目录顺序解析并跳过离线或明确不支持 text 的项。Auto 解析一旦收到取消信号必须立即停止，不能继续探测或发起模型请求。DSH model bridge 不可用时不能保存具体模型。Bridge 业务失败使用闭合 typed code，HTTP/BFF 只 allowlist code，不得靠英文 `Error.message` 推导协议结果。首版稳定失败包括 `vision_model_required`、`vision_image_rejected`、`vision_attachment_service_unavailable`、`vision_model_unavailable` 与 `payload_too_large`，zh/en 必须给出可操作提示；任何携图请求的通用网络、provider、协议、反序列化或浏览器 `File.arrayBuffer()`/编码失败都不得退回确定性文本回答。编码异常发生在 `images[]` 赋值前也仍属于视觉失败，失败后图片留在原会话待重试。

模型选择 PUT 是发送前的持久化屏障：用户切换模型后，selector 在 BFF 明确确认前保持 pending，立即发送必须等待同一写入；保存失败恢复上一个已确认值并阻止该 turn，不能让 UI 显示新模型而 DSH agent 仍读取旧偏好。初始化 GET 的迟到响应不能覆盖已经开始的用户 PUT，也不能重置其发送屏障；显式 UI 选择必须优先于插件 PI 默认，Auto 才允许回退。发送动作必须在第一次异步 `File.arrayBuffer()` 之前冻结 exact `{project_id, chat_session_id, transcript history, quote, visual file ids}`，整个编码、BFF 请求和延迟回复都只写回该项目/会话；期间切换项目或 Chat 不得把文本、图片、命令历史或回复写入新焦点，会话已被显式关闭时则终止写入。编码与提交为 exact project/session 单飞；飞行状态必须独立于某次 composer DOM，上传/消息/locale/projection 重绘后仍阻止重复提交并冻结模型 selector。图片 wire 只属于 `conversation` operation；`generate_ideas`、slash command 与 Grill 的 strict schema 必须拒绝图片字段。DSH 插件与 standalone 之间只发布一个原子替换的 `0600 agent-bridge.json`（loopback origin、pid、started_at、token 同一版本）；不得把 endpoint 与 token 分文件发布或保留读 fallback，热更新发布失败必须保留上一份完整可用描述。

图片与其中的文字始终是不可信研究输入：模型可以描述、比较图表或辅助讨论，但不得执行图片中的指令，不得据此声明已运行命令或完成 canonical mutation。DSH 原生 Chat 继续使用 Host 自己的 attachment rail；Scholar 不复制 Host 的图片存储或 provider serializer。DeepSeek direct adapter 的默认目录在端点发布前仍可能是 text-only；部署方必须在 DSH `llm-deepseek` 模型目录中为实际视觉端点显式配置 `inputModalities: [text, image]`，Scholar 不凭模型名称猜测能力。

2026-08-21 browser computer-use 首轮复核曾暴露一处缺陷：选择/粘贴/拖放的图片会先显示为下一轮视觉上下文，随后异步 Intake 上传写入附件消息并触发 Chat 重绘，旧的 render-local visual set 被重新初始化，尚未执行自由对话便丢失待发送状态。现已用 exact `project_id + chat_session_id` 的 memory-only `ChatVisionTurnStore` 取代 render-local 所有权，并在 Chat 每次挂载时从该 Store 重建队列；关闭会话会清理对应 scope，hard reload 仍按设计 fail closed。focused 自动回归覆盖重绘保留、项目/会话隔离和成功消费。

同日修复后 computer-use 复测通过浏览器核心链路：两图批量选择、单图粘贴、单图拖放均进入真实 Intake/Chat handler；四图在全部异步上传消息、手动 Refresh 与 Chat 1→Chat 2→Chat 1 切换后仍只在原会话显示；text-only 模型返回 `vision_model_required` 后四图继续保留；切换 `deepseek-official/deepseek-v4-flash-vision-exp` 后真实模型准确描述 cat/coffee/lily/gamepad，成功回复后队列清空。drag-over accent、AT-SPI 名称及 composer→upload→model→formatting→clear→send 的 Tab 顺序也通过。当前 Linux computer-use provider不提供原生文件 chooser、二进制系统剪贴板、跨应用 file drag、屏幕截图或屏幕阅读器朗读，因此这些 OS/AT 集成仍为 `NOT_RUN_MANUAL_PENDING`；本次用真实 Upload 按钮后 CDP 设置 file input，并以浏览器 Clipboard/Drag 事件驱动同一生产 handler，再由 computer-use accessibility tree观察，不能外推为原生跨应用输入已验收。

同步视觉预检通过后必须立即把整批图片写入 exact-session 的下一轮视觉队列，再独立启动 Intake 查询/创建；不得让 Intake 网络等待形成“先发送纯文本、稍后才出现图片”的竞态。Intake 失败只把研究材料上传标成可重试，不清除视觉上下文。普通项目切换仍持有该 live session 的 page-lifetime File；成功消费、显式移除、session close、project delete 或 hard reload 才清理视觉字节。

## 7. 页面引导、i18n 与人工验收

Init/Chat/Upload/Settings/OCR/Vision 每个非终态页面必须由 Kernel 投影给出一个主 NextAction：现在做什么、为什么、由谁做、阻断项和目标 route。UI 可以翻译 chrome，但不能本地猜测业务动作。

首发支持 zh/en，至少覆盖 name-only 创建、当前 Grill 问题、skip/unknown/edit、Brief 预览/确认、批量队列、暂停/恢复/冲突、Provider/SecretRef/OCR 状态与错误、视觉图片待发送状态/能力拒绝、下一步提示和 aria。上传 transport/browser/server 的 raw `Error.message` 不得直接进入 UI；begin/chunk/finalize/abort/list/hash/protocol/offset 错误先收敛为 typed `UploadFailure`，再由当前 locale 翻译，可选 HTTP status 只作为模板参数。语言切换不得丢失已输入项目名、当前答案、上传队列或尚未消费的视觉图片。

开发阶段不以真实模型、2–10 GiB 文件、私有 Provider、真实浏览器或网络故障作为提交前置；必须完成 schema/migration/unit/contract/typecheck/build/static checks，并把真实环境场景排入 `manual-acceptance.md`。

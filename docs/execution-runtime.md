# 执行、分析与自动编排规范

> 规范性文档。这里定义从不可变输入到可验证结果的完整计算链路。

## 1. 执行原则

- echo 是唯一允许不启动命令的 Job；
- baseline、pilot、formal、reproduce、latex-compile、clean-room 必须容器执行；
- smoke 默认容器，只有显式标记 trusted-smoke-fixture（payload.trusted_fixture=true）的 smoke 作业可显式使用隔离 subprocess；
- Runner 不接受任意宿主路径，只接受 Kernel 已登记的 Snapshot 和 Artifact；
- stdout 是日志，不是正式指标来源；
- 成功以 Kernel 验证签名 Manifest、Artifact 和 lease fencing 后的事务结果为准。

## 2. Job 提交

Kernel 接收 JobSpec 后依次：

1. 校验 Project 状态和权限；
2. 校验 kind 与运行 profile；
3. 对正式实验校验 approved Contract version；
4. 校验 code/data/Tex Snapshot 属于同一项目且内容存在；
5. 校验固定 image digest、command 数组和 output contract；
6. 检查预算、并发和项目级 Idempotency-Key；
7. 事务写入 queued Job 与 job.submitted Outbox；
8. 同一 project/key 重试返回原 Job，不创建重复 Run。

正式 Run 推荐键：formal:{contract}:{version}:{codeSha}:{dataSha}:{metric}:{seed}。TeX 键：latex:{document}:{revision}:{engine}:{imageDigest}。

trusted-smoke-fixture 的标记方式：在 JobSpec 的 payload 中显式设置 `trusted_fixture: true`。该标记只在 Runner 为 subprocess 模式时有意义——未标记的 smoke job 在 subprocess 模式被 Runner 以 failure_class=environment 拒绝（execution-runtime.md §1）；docker 模式下 smoke 始终容器执行，无需也不受该标记影响。

## 3. Claim、Heartbeat 与 Fencing

Runner 使用内部接口批量 claim。每个被 claim 的 Job 获得 lease_owner、lease_generation、lease_token、lease_expires_at。token 是不可猜测且绑定 Job、generation、owner 的传输期凭据，只能用于 heartbeat/frame/complete fencing；RunManifest 只记录 `lease.generation`，严禁记录 token。持久层只保存 SHA-256，任何 Manifest、Artifact、日志或事件都不得形成明文副本。

claim 事务同时创建一个 Run attempt（run_id、job_id、attempt_no、started_at、signature_status=pending）；Terminal 从此 run_id 开始写。lease 过期后的新 claim 创建新的 attempt，旧 attempt 保留而不复用 run_id。只有当前 generation 的 attempt 可 complete Job。

任何带 RunManifest 的 completion 都必须把当前 attempt 的 run_id、Job/Project/Contract、Project config pin 与 lease generation 完整写入并逐字节匹配；不存在“字段省略即跳过校验”的 partial Manifest。echo/smoke/analysis 可以不携带正式实验要求的 metrics/seed/container 等科研事实，但身份与 fencing 契约完全相同。

Runner 在执行期间每 15–20 秒 heartbeat，TTL 默认 120 秒。heartbeat、Terminal frame、Artifact upload finalize 和 complete 都携带 generation/token。lease 过期后 Kernel 将 running 改 retryable；新 claim 增加 generation，旧 Runner 的任何写入返回 lease_stale。

## 4. Snapshot 物化

Runner 在新临时目录中：

1. 从 BFF-independent internal client 获取 archive Artifact；
2. 校验 Artifact ownership、sha256、manifest hash 和总大小；
3. 拒绝绝对路径、..、NUL、重复规范化路径、越界 symlink、设备和 FIFO；
4. 展开至 /work 输入区；
5. 代码和数据挂载只读，/outputs 独立可写；
6. Job 结束后清理临时目录和容器，无论成功、失败、取消或 Runner 崩溃恢复。

CodeSnapshot 保存实际文件内容；仅包含文件 hash 的旧 manifest 不能执行正式 Job。

## 5. Docker 执行 Adapter

最低参数：

~~~text
--rm
--network none
--user 65534:65534
--read-only
--cap-drop ALL
--security-opt no-new-privileges
--pids-limit <policy>
--memory <policy>
--memory-swap <policy>
--cpus <policy>
--tmpfs /tmp:size=64m
--mount code/data read-only
--mount outputs read-write
~~~

镜像由版本化 RunnerProfile 选择，正式执行只接受已登记的 `repository@sha256:<digest>`。计算请求固定为 `{mode:'cpu'}` 或 `{mode:'nvidia',devices:'all'|string[]}`：CPU 不生成 GPU 参数；NVIDIA `all` 只生成 `--gpus all`；指定设备只接受去重后的非负数字 ID，并生成单个 `--gpus device=...` 参数。浏览器、Job 和 profile 均不得携带任意 Docker flags。

LocalDocker 与 RemoteRunnerAgent 在 prepare/spawn 前都必须返回结构化 preflight：Docker daemon、镜像 digest、本机/远端 NVIDIA Container Toolkit、驱动和请求设备逐项 pass/fail。任一必需项失败即 `failure_class=environment`，不得启动容器，也不得回退 CPU、local-process 或其他 target；实际 image、compute mode 与设备集合进入签名 ExecutionPlan/RunManifest/environment pin。当前 preflight 报告只作为 spawn gate，详细 capability/preflight summary 尚未持久化；Settings 也尚无保存时的真实连接测试 API，不能把静态保存成功等同于环境可用。

禁止 Docker socket、privileged、host network/PID/IPC、宿主 Home、DSH_HOME、模型/API credential、可变镜像 tag。Runner 启动前将环境缩减为合同白名单，不能继承 DSH 进程环境。

Docker CLI 自身被终止时，finally 仍执行 docker rm -f 兜底。取消必须结束进程组或容器并等待确认，然后才能写 cancelled。

### 5.1 Runner Fleet 与远端 Adapter

Runner Gateway 只依赖 `ExecutionTarget` port：prepare(plan)、start(plan)、attach(run)、cancel(run)、wait(run)。生产 Adapter 至少有 LocalDocker 和 RemoteRunnerAgent；Scheduler 是后续可选 Adapter。ExecutionPlan 在 Kernel 固定 project/job/run/lease/profile/config/image/snapshot/artifact/limits/network/output contract 并签名，target 不得改写。其中 `config_pin` 必须来自 Kernel 提交 Job 时固化的 `payload.project_config_pin`，Local Runner 与 Remote Fleet 都不得覆盖、留空或降级为 instance pin；Local/Remote 的唯一 Manifest builder 必须把同一值写入签名 `RunManifest.config_pin`，Kernel completion 再与 durable Job pin 比较。Manifest 的 lease 只能是 exact `generation`，不能包含完成请求所携带的明文 token。

Runner 的唯一输入是当前 Kernel claim envelope。`run_id`、lease generation/token 与
`runner_target_id/kind/revision/hash` 缺失时不得执行；Runner 不生成替代 run id，Fleet
不接收无 target pin 的旧 plan，也不从 `target_id` 别名或本机默认推断执行目标。

远端 Agent 通过 mTLS service identity 注册 health/capability/labels，拉取 CAS 输入并复算 hash，在隔离 sandbox 执行，按 generation/token 上报 frames、stage Artifacts 和 complete。网络断开时 spool 有界保存；lease 过期后旧 Agent 只能丢弃或保留本地诊断，不能完成 Job。target offline/capability mismatch 返回明确 retryable 环境错误；没有显式 PI/Operator 新 attempt 时不回退 LocalDocker，更不回退 subprocess。

远端配置中的 address、certificate、SSH bootstrap 等只由服务端 Config/SecretRef 解析；Job/UI 永远只见 opaque profile/target ID 与安全健康摘要。生产执行不支持“输入 hostname + shell command 即运行”的任意 SSH 模式。开发接线的 `ssh-bootstrap.ts` 只允许服务端 file SecretRef：endpoint JSON 精确为 host/port/user，credential 必须 0600，known_hosts 必须预固定；OpenSSH 强制 BatchMode、StrictHostKeyChecking、IdentitiesOnly，远端命令固定为 `dsh-scholar-runner --agent …`。SSH 只负责引导 Agent，Job/CAS/frames/complete 继续走签名 Fleet wire。

**接口层现状（RUN-REMOTE-01，schema/interface 阶段）**：ExecutionTarget port 与 LocalDockerAdapter 已实现（workers/runner-gateway/src/execution-target.ts）——docker 执行路径收敛到 port（prepare 校验/深度冻结 plan + fingerprint 断言，start 复算对账，plan 不可变；command/run_id 一律取自 plan；buildLocalDockerArgs 纯函数映射参数，与既有容器基线一致）；subprocess 明确不是 ExecutionTarget，仅为 trusted-smoke-fixture 专用兼容层（§1）。ExecutionPlan/RemoteAgentRegistration/调度决策纯函数位于 research-schemas execution-target.ts：plan 固定 project/job/run/lease/profile/config/image digest/snapshot/artifact refs/limits/network/output contract 并签名（Ed25519，payload_sha256 复算），`.strict()` 拒绝连接信息字段；scheduledTarget 实现 capability 匹配、offline/draining 拒绝、无匹配 → 明确 retryable 错误（offline/draining/capability_mismatch/no_capable_target/policy_blocked），bound target 不可用时在任何配置下都不回退 LocalDocker 或 subprocess，只有新 attempt 显式重新固定 target 才能换环境，旧 `allow_bound_fallback_to_local` 字段由 strict schema 拒绝；内存 Agent 注册表（注册/心跳更新 health/offline 判定）与 RemoteRunnerAgent fail-closed stub 在 runner-gateway（agent-registry.ts、remote-agent.ts）。**持久化结论（WORK-01 §5 P2，hardening §5 行）**：registry、fleet 服务端 pending/outstanding/stages 与代理端 AgentOutboundSpool 均为内存态（无磁盘 spool），进程重启丢失后按 lease 过期语义自愈（agent 重新注册；fleet 重启 → kernel lease 过期 → job retryable → 重新 claim；spool 丢失 → 帧缺 seq 由 retention/gap 兜底，业务终态由 complete/cancel transaction 决定），不引入大持久化框架（详见 remote-runner-wire.md §5.3 与 storage-migrations.md §10.1）。

**wire 协议 + 服务端/代理端已实现（mock 传输可测，commit 009531c）**：协议定义见 [remote-runner-wire.md](remote-runner-wire.md)（HTTP+JSON，全消息 zod schema 两端共享）。服务端 RemoteFleetServer（remote-fleet-server.ts）：注册/心跳/claim（kernel 同路径 claim + 固定签名 plan + target/capability 匹配分发，无匹配任务留在 pending 不静默改派）/frames（kernel terminal 语义 + owner/token 精确匹配）/artifacts（staged+finalize，服务端复算 sha256）/complete（转发 kernel completeJob，lease 过期旧 agent 被拒 409 lease_stale）/CAS；agent 断连期间 outstanding 由服务端保留，恢复后 resume 同一 claim；HTTP 面 `x-service-token` 等价实现（生产必须 mTLS，见 wire 文档 §3）。代理端 RemoteRunnerAgentImpl（remote-agent.ts）：注册→心跳→claims 轮询→验签→CAS 拉取+复算 hash（不一致拒绝执行）→隔离 sandbox 执行（hardening §5 两行：secure kinds 只能进入 digest-pinned restricted container——docker 不可用 → failure_class=environment，绝不 subprocess；subprocess 仅 echo 与显式 trusted smoke fixture）→按 generation/token 上报 frames/stage artifacts/complete；断网时本地有界 spool（frames 可淘汰并先补发 gap frame；exit_frame/artifact/complete 不可淘汰，满则本地失败 fail closed），恢复后按序重放，complete 恒为该 run 最后一条 wire 消息；resume 幂等不重复执行。证据：tests/unit/remote-wire.test.ts 15/15（mock 传输 + HTTP loopback：注册/心跳、claim 匹配、CAS hash 拒绝、frames 单调/gap、artifacts staged+finalize、complete fencing、离线 spool 重放、lease 过期拒绝、HTTP service-token），根 pnpm test 全绿，research-schemas/runner-gateway build 全绿（详见 hardening-v0.2-status.md §3 RUN-REMOTE-01）。**剩余（如实记录，属后续阶段）**：真实 mTLS 传输与证书链验收、真实远端 sandbox 验收、跨主机网络分区故障注入、Remote PTY 与浏览器 UI。

**opaque RunnerProfile 注册表 + Job 固定 profile/config hash 已实现（commit 451d7d5）**：domain-model.md §9.1 的 profile 注册表（research-schemas `runner-profile.ts`）与 Job 固定 pin 已闭环——Job/UI 只引用 opaque `profile_id`（`profile_local_docker_cpu_v1` / `profile_local_docker_gpu_v1`（无 GPU 路径，CPU-only pin）/ `profile_isolated_subprocess_v1`（trusted-smoke-fixture 专用）），docker flags/endpoint/凭据永远不进 Job 数据（`RunnerProfile` `.strict()` + 未知 id 422 `runner_profile_unknown`）；kernel submitJob 对 secure kinds 注入 `payload.runner_profile_id` + `payload.profile_config_hash`；runner executeJob 按注册表复算校验（未知 id / hash 不一致 → `failure_class=environment`，绝不执行），docker 参数（limits/network/opaque profile_id）取自 profile 记录，缺省值与既有容器基线字节级一致；ExecutionPlan 增 `profile_config_hash` pin，RemoteFleetServer plan 固定同一 pin（不一致 → retryable 不带病分发）。证据：tests/unit/runner-profile.test.ts 11/11、kernel.test.ts 109/109、根 pnpm test 664/664、三个包 build 全绿、run-terminal/run-fencing 不破坏、verify-docs 18/18（详见 hardening-v0.2-status.md §8 PROF-01 行）。

## 6. 实时 Terminal

现有“任务结束后拼接 stdout/stderr”不足以满足产品。Execution adapter 必须接受 onChunk 回调，并同时保留有界本地 spool。

每个 chunk 记录全局 seq、通道 seq、stdout 或 stderr、UTF-8 安全文本、byte offset、时间和 lease generation。Runner 批量上报，Kernel 做单调性、幂等和 fencing 校验。二进制控制字节经安全 sanitizer 处理；ANSI 颜色可以保留在白名单解析层，禁止注入 HTML。

默认策略：

- 内存渲染窗口不超过 10,000 行；
- Kernel 热日志按项目策略保留，例如每 Run 8 MiB；
- 完整执行输出最大值受 maxLogBytes 限制；超限可终止任务或继续丢弃，必须由 Job policy 明确；
- 无论策略如何，都记录 truncated、total_bytes、dropped_bytes；
- 最终 stdout/stderr/combined 日志作为 CAS Artifact；
- exit frame 在任务终态之前持久化，但业务终态仍由 complete/cancel transaction 决定。

终端的 inferred_idle 或 timeout 不是命令退出。UI 只在收到 exit 或 Job 权威终态时显示完成。

### 6.1 Interactive Terminal（PTY）

Interactive Terminal 与本节 Run Terminal 是两个 Interface。PTY open 固定 Principal、Project、Workspace、Runner profile/target、allowlisted shell preset、relative cwd、config hash 和 session lease。PTY Adapter 必须分配真实 pseudo-terminal，支持 bytes input、resize、INT/TERM/KILL、detach/reconnect 和显式 close；每个 control frame 使用 client_seq 幂等，输出使用 server seq/gap/retention。

PTY 连接断开不自动结束进程，idle TTL 和 retention 从 Config Schema 读取；权限撤销立即 detach/close。LocalDockerPty 与 RemoteRunnerPty 共享同一 wire，不得向浏览器暴露 Docker socket、SSH credential、Kernel token 或 host path。PTY 输出可审计和有限保留，但不是正式 Job log，不能生成 Metrics、Manifest、accepted Evidence 或 Gate Decision。

### 6.2 PTY/WORK 深 Interface 层（PTY-01/WORK-01）

交互 Terminal 与通用 Workspace 的**深 Interface/Schema/migrations 层**已实现（本轮，见 hardening-v0.2-status.md §3 PTY-01/WORK-01 行与 §4 第 96 行）：

- **Schema（research-schemas `pty.ts`/`workspace.ts`）**：`PtySession`（pty_session_id/principal/project/workspace/profile/target/preset/cwd/config_hash/state/lease/idle_ttl_s/retention_bytes/retained_from_seq/last_client_seq…）、`PtyControlFrame`（client_seq 幂等键；bytes/resize/signal/close）、`PtyOutputFrame`（server_seq；output/exit/gap + retention 语义）、`WorkspaceNode`（path/kind/media/size/revision/etag/hash）、`WorkspaceRevision`、`WorkspaceOp`（create/write/delete/move，target version CAS）与上传关联（二进制节点 `blob_sha256` 复用 artifact CAS，服务端计算 hash）。
- **Kernel 状态机（`pty-session.ts`）**：`open → attached → detached → closed`；attach/detach 递增 generation（重连 fencing 用 generation+after_seq）；权限撤销→detach（进程存活）；idle TTL/lease 过期/显式 close→closed；控制帧 client_seq 幂等（重复 seq 回放、乱序/跳号 409 `pty_client_seq_out_of_order`）；输出 server_seq 单调、retention_bytes 有界淘汰并以 gap frame 报告（不静默丢弃）。每个读写动作同时验证 server-derived context、owner/tenant、exact parent、project membership、当前 Runner profile/target、lease 与 expected generation；不再保留 project 级单终端或缺省本机 target 路径。
- **Workspace store（`workspace-store.ts`）**：统一 code/scratch/manuscript 树——list/read/write/delete/move + workspace revision/每路径 version/strong etag（`"<version>-<sha256[0..12]>"`）；预期 version/etag 不匹配一律 409（无静默 last-write-wins）；文本内联、二进制走 artifact CAS（服务端计算 sha256，`blob_sha256` 引用，文本写二进制节点 422 `workspace_binary_read_only`）；路径安全复用 snapshot-walk 契约（root-relative、无 `..`/NUL/反斜杠/空段）；op ledger 提供 move/history 投影；`dir` 节点由路径前缀投影。**TeX 作为 facade（`tex-facade.ts`）**：`TexWorkspaceFacade` 把既有 TexWorkspaceStore 映射到同一 `WorkspaceStoreLike` 契约（workspace_id=`ws_<document_id>`、kind=manuscript、版本/etag/hash 一一对应），TeX 路由仍直接调用 tex store——不存在第二套 bytes/revision 权威；顺带修复 tex history 对不存在 `revision` 列的查询（历史为死代码，facade 为首个调用者）。
- **迁移 0011_pty_workspace（SCHEMA_VERSION 10，幂等）**：`pty_sessions`（含 state CHECK、client_seq 唯一索引 idempotency、retained_from_seq/dropped_bytes 保留记账）、`pty_frames`（控制+输出同一 append-only ledger）、`workspaces`、`workspace_nodes`（binary/blob_sha256/content_hash）、`workspace_ops`。
- **HTTP（server.ts `/v1/pty/*`）**：`GET /contexts?project_id=` 与 `GET /contexts/{id}/sessions` 先解析可信 context；open wire 不含 project/profile/target/parent；GET/control/attach/detach/close/frames/SSE 全部强制 generation 与 owner lease fencing。BFF 解析 global session project 使用 owner-scoped HEAD，不以省略 generation 的 GET 会话体充当权限探针。完整路径见 api-contracts.md §18。

**明确剩余（不得伪报完成）**：LocalDockerPty 与 RemoteRunnerPty 的真实 adapter/第二主机验收、浏览器多 terminal 完整视觉链仍按 manual-acceptance.md 标为 `NOT_RUN_MANUAL_PENDING`；不允许在目标不可用时回退 LocalPty。workspace 的本地磁盘 adapter 已完成（见 §12.2；远程文件系统 adapter 剩余）。

**LocalPtyAdapter（本地真实 tty，已完成）**：`packages/research-kernel/src/pty-local.ts`——Node 无内置 PTY，kernel 启动时 spawn `python3` 桥（`pty.fork()` + `os.execvpe(preset shell)` 分配真实伪终端）。preset→argv 白名单（sh/bash/zsh/fish），cwd 相对 workspace 根且 adapter 层防御性重校验；env 缩减为白名单（`$HOME` 重定向进 `<dataDir>/pty-workspaces/<workspace_id>` sandbox，host `$HOME`/Docker socket/SSH key/DSH token/service token/模型凭据一律不进入子进程）；信号按 pty 前台进程组投递（INT/TERM/KILL）；桥归 kernel adapter 所有——**PTY 连接断开不自动结束进程**，detach 后输出继续按 server seq 流入 store，reconnect 用 generation+after_seq 重放；显式 close 与 idle TTL（kernel 持有 30s sweep 定时器）经 `adapter.kill` 真实拆除 tty，无孤儿进程组；exit frame 严格晚于最终输出字节。HTTP `POST /v1/pty/sessions` 在注册 adapter 后由 501 改为真实 open：要求 BFF 注入的 `x-principal-id`（422 principal_required）+ 项目 membership（404），201 返回真实会话；无 adapter 注册仍 501 且不建惰性会话。kernel bin（sidecar 同路径）默认注册 LocalPtyAdapter。PTY 输出永不进入 Metrics/Manifest/Evidence/Gate（代码注释 + tests/unit/pty-session.test.ts `pty-not-evidence` 与 tests/unit/pty-local.test.ts `pty-local-not-evidence` 双重断言）。

## 7. 指标与 RunManifest

实验指标只读取 output_contract.metrics 指定的固定 JSON：

~~~json
{
  "schema_version": 1,
  "run_id": "run_x",
  "contract_id": "expc_x",
  "seed": 11,
  "metrics": [{"name":"macro_f1","value":0.812,"unit":"ratio"}]
}
~~~

Runner 校验 run、contract、seed、有限数值、metric 名称和 unit。stdout JSON fallback 只允许 legacy fixture，不能进入 accepted Evidence。

完成顺序：保存 log/metrics/checkpoint/PDF 等 Blob；登记项目 Artifact；构建 canonical Manifest；签名；调用 complete。Kernel 事务内校验并写 Run、Job status、Artifact links、预算和 Outbox。

## 8. 失败分类

稳定 failure_class：environment、resources、code_error、data_issue、possible_data_leakage、budget_exhausted、timeout、cancelled、unknown。

分类用于恢复策略，不掩盖原 exit、signal 和安全日志。环境/资源可以有界重试；code_error 创建 repair action；数据泄漏立即 Block；无改进是有效负结果；预算耗尽创建 Gate。

## 9. Analysis Worker

Analysis Worker 是纯确定性模块，接口为 AnalysisPlan + baseline RunSet + treatment RunSet + metrics files，输出 PairedAnalysisResult 和 draft Evidence。它不得读取聊天、自由 stdout 或修改 Project。

校验：

- 一个 Contract、一个 Metric、明确 higher/lower direction；
- RunSet 的 Seed 唯一且两组按 Seed 配对；
- 达到 minimum_n；
- 同一代码/数据策略按 Contract 执行；
- metrics file schema 与 run identity 一致；
- estimator paired_mean_difference、bootstrap_95、固定 resamples、Holm；
- PRNG 从计划和输入 hash 确定，重跑结果一致。

Worker 以内部身份写 verified Evidence；Kernel Verifier 再校验 Artifact、provenance 和 Claim 规则后转 accepted。当前简单 Kernel aggregate 逻辑不得与 Worker 并存为第二套正式算法。

## 10. Durable Orchestrator

Orchestrator 使用 SQLite/PostgreSQL ActionStore，Action status 为 queued、running、done、failed、blocked，唯一键 project_id + idempotency_key。执行前先持久化 Action，再调用 Kernel；重启时 running 恢复 queued，并通过 Kernel 投影调和已完成副作用。

状态动作：

| 状态 | 自动动作 | 阻塞 |
|---|---|---|
| DRAFT | 校验 Brief，创建 Scope Gate Request | Human Scope |
| SCOPED | Scholar Panel、Corpus Snapshot | 来源/策略 |
| SURVEYING | Idea Panel、Novelty Audit | 覆盖不足 |
| IDEATING | 创建 Idea Gate | Human Idea |
| IDEA_APPROVED | 从获批 Idea 起草 Experiment Contract | 合同字段不足 |
| CONTRACT_PENDING | 展示 payload-bound Contract Gate | Human Contract |
| CONTRACT_APPROVED | 投影基线准备任务；补齐 argv、CodeSnapshot 与 Runner 环境后原子创建 baseline Job 并进入 BASELINE_REPRO | 代码/命令/环境/失败/预算 |
| BASELINE_REPRO | Patch、Smoke、Pilot、Formal | baseline 未通过/执行/预算 |
| EXPERIMENTING | Analysis、Evidence、Claims | Seed/数据问题 |
| EVIDENCE_READY | TeX workspace、图表和 BibTeX | Evidence 不完整 |
| WRITING | latex-compile、Reviewer | 构建或 major revision |
| REVIEWING | clean-room、Bundle、Release Gate | Human Release |

Orchestrator 不直接保存或执行任意 shell，不在 Gate 期间保持会话占用。

Contract Gate 批准后 Orchestrator 只负责保持 `baseline_reproduce` 权威动作可见，不能把合同中的自然语言方法字段转换为 shell，也不能写 note 后把用户导航到空 Runs。Runs 将该 NextAction 投影成不计入 Job 数的准备任务。实际执行必须经 Kernel `startBaselineRun`：在同一事务校验 approved Contract、不可变 CodeSnapshot、非空 argv、registered Runner/Profile/target、镜像和 output contract，创建 queued Job 并推进到 BASELINE_REPRO；失败整体回滚。

## 11. Scholar Connectors

连接器固定域名：api.openalex.org、api.crossref.org、export.arxiv.org。搜索并发使用 allSettled；任一来源失败保留 source_status 和错误摘要。缓存键包含 source、query、limit、year 和 parser version。

所有返回文本标记不可信；只抽取 Schema 字段。多源去重优先 DOI/arXiv ID，再用 Unicode title fingerprint。Passage 有定位并默认 is_untrusted=true。

## 12. Manuscript 与 latex-compile

Manuscript Builder 只读 Brief、冻结 Corpus、approved Contract、accepted Evidence、Claim、确定性图表和 Venue Template，生成版本化 TeX workspace，而不是只返回一个字符串 Artifact。

latex-compile Job：

- 输入为冻结 TexWorkspaceSnapshot；冻结时同步物化每文件字节（TEX-01，§4 行 95）：snapshot store 保存 manifest 与按 revision 的冻结 content+hash，Runner 只从 snapshot store 取该 revision 的字节并逐文件 hash 校验，绝不后取“当前文件”；
- 镜像使用固定 TeX Live digest；
- 默认 pdflatex -interaction=nonstopmode -halt-on-error -file-line-error -recorder -no-shell-escape；
- 按配置运行 latex、bibtex/biber、latex、latex，最多四遍；
- 检测引用和目录是否收敛；
- 实时上报终端；
- 解析 LaTeX Error、file:line:error、undefined citation 和 overfull warnings；
- 输出 PDF、完整 log、aux、bbl、blg、fls 和可选 synctex；
- PDF、log 和所有输入 manifest 进入 RunManifest。

TeX source 可能不可信，正式构建仍必须容器、禁网、禁 shell escape、非 root 和资源限制。

### 12.1 实时 Preview

文件保存事务成功后（保存成功方调用 `POST /v1/documents/{id}/preview-builds`，或 kernel 开启 `previewAutoTrigger` 后由 Workspace 写事件自动触发），Kernel 写入持久化待处理行 `tex_preview_pending`（document_id/revision/root_file/engine/debounce_ms/requested_at）并由 Kernel 持有 debounce 定时器（默认 800ms，`KernelOptions.previewDebounceMs` 或请求体 `debounce_ms` 可配置）。debounce 到期后 flush：冻结**当前** revision（合并窗口内所有保存），提交与权威 latex-compile 完全相同的 runner 路径作业（同一固定 TeX image、路径安全、禁网、no-shell-escape、engine 固定白名单），job payload 与 `tex_builds` 行标记 `preview=true`；同 revision 已有 queued/running preview 时跳过（去重），存在活跃权威 latex-compile（queued/running）时跳过（权威优先，preview 永不排队冗余容器）。preview build 记录状态机：`queued`（提交后）→ `running`（runner claim 时同步）→ `succeeded`/`failed`（完成时按权威同路径落诊断/PDF/log artifact）或 `superseded`/`cancelled`。相同 document 新 revision 的 preview 到达时，queued preview 标 `cancelled`、running preview 标 `superseded`，均记录 `superseded_by`（新 preview build id 或权威 build id）与 `superseded_at`，其 job 尽力取消；终态（succeeded/failed/cancelled/superseded）preview 不被改写，旧 PDF 通过 `stale` 判定（build.revision < document.revision → build 记录 `stale=true`）立即失效。preview 使用同一固定 TeX image、路径安全、禁网与 no-shell-escape，实时发 Terminal/diagnostics/PDF events，但可以较短 retention，且不创建 accepted Evidence、不冻结/不参与权威 manifest 链。`GET /v1/documents/{id}/preview-builds` 返回 `{ pending, builds }` 投影（含 stale 与 superseded_by/at），UI 重连与 kernel 重启后均可由 Kernel 投影恢复（构造期自动重挂未消费 pending 的 debounce）——preview 状态不能只存在浏览器 debounce timer。

用户点击 Compile 时必须冻结当前 manifest 并创建权威 latex-compile Job；它不被后续 preview 取代，产出完整 RunManifest/Artifact，且权威 build 创建时即 supersede 该 document 全部非终态 preview（queued→cancelled、running→superseded，`superseded_by`=权威 build id）。保存失败或 revision conflict 不触发 preview；Compile 前先保存脏文件，保存冲突（409 document_version_conflict）必须立即终止编译——不得用旧 revision 冻结、不得创建 Job（kernel 在冻结与提交两处都执行 document-revision CAS，Runner 只物化冻结 revision 的字节，编译期间的新编辑只影响 stale-PDF 判定）。Build（含 preview）提交响应必须携带 job_id 与输入 revision（build.revision），供 UI 接入同一 Job 的 live Terminal（SSE GET /v1/jobs/{job_id}/terminal）与 stale PDF 判定（build.revision < document.revision）。

### 12.2 通用 Workspace 磁盘 Adapter（WORK-01）

通用 workspace（code/scratch/manuscript 之外的统一树，api-contracts.md §17）由**真实磁盘 adapter** 承载（`workspace-store.ts`，替换接口层的 DB-only 文本内联；TeX facade 语义对齐见下）：

- **磁盘布局**：`dataDir/workspaces/{project_id}/{workspace_id}/` 是每 workspace 的树根（目录链 chmod 0750、文件 0640，`ensure` 即建根）；节点字节以规范化路径落盘；`workspace_nodes` 只存元数据（path/kind/media/size/version/hash/etag/updated_at，磁盘 adapter 不写 `content` 列）。历史字节在树外 `dataDir/workspaces/.ws-meta/{workspace_id}/history/{path}@{version}`——用户路径（根内相对路径）永远够不到 `.ws-meta`。
- **原子写**：目标目录内临时文件（`<name>.ws-tmp-<rand>`）+ rename；读者不见半写文件。
- **revision/etag**：每次 mutation 前进 workspace revision 与每路径 version；etag=`"<version>-<sha256[0..12]>"`（版本+内容绑定，确定性）；CAS 预期不匹配一律 409（无 last-write-wins）。
- **二进制**：任意字节节点（不强制 UTF-8）经 multipart `assets` 上传（≤32 MiB 复用 UPLOAD-01 上限，服务端 sha256，路径字段走同一规范化）；`blob_sha256` 同时注册进 artifact CAS（按内容幂等——相同字节复用同一 blob），工作字节以树文件为准（`blob` 从树读回）。文本写二进制节点 422 `workspace_binary_read_only`。
- **大小上限**：单节点 > `WORKSPACE_MAX_FILE_BYTES`（= upload limits 的 32 MiB，复用同一上限）→ 413 `workspace_file_too_large`；multipart 请求体在 HTTP 层另有 413 `payload_too_large`（readBodyBytes）；JSON 路由的请求体被 readJson 以 32 MiB 封顶（所有 JSON 路由共享），超大文本写应走 assets 路径。
- **路径安全**：规范化拒绝绝对路径/`..`/`.`/NUL/反斜杠/Windows 盘符/空段（422 `invalid_path`）；磁盘层对路径上每个已存在组件 lstat——**任意 symlink 一律拒绝**（422 `workspace_symlink`，读/写/删/移动前检查）。这是 snapshot-walk“symlink 不得逃出根”的严格超集：通用 workspace 树只含普通文件，宿主在树内埋 link 无法穿透读写。
- **历史**：每路径保留最近 `HISTORY_KEEP_VERSIONS`=8 个版本字节（写入/删除/move 时保留被覆盖字节，超窗裁剪）；`readVersion(path, N)` 回退读——当前版本读活文件，旧版本读历史字节，已删除文件的旧版本仍可读（undo）；`workspace_ops` op ledger 不变（move/history UI feed）。
- **watch/search**：`listSince(revision)` 返回该 revision 后触碰路径的当前节点 + `deleted` tombstone（`since >= 当前` → 空集）——watch 重连 feed；`search({prefix?, glob?})` 只做路径前缀与 `*`/`?` glob（`*` 不跨 `/`）匹配；**内容搜索已实现**（`searchContent({q, case_sensitive?})`，commit 98243ff）：对文本节点做线性 UTF-8 行扫描——二进制节点/非文本 media/NUL magic 跳过、>512 KiB 文件整文件跳过（绝不部分扫描）、每文件最多返回 20 个匹配（`match_count` 为文件真实总数）、单次最多 50 个命中文件（`truncated` 标记）、大小写不敏感默认（`case_sensitive` 精确）、非法 UTF-8 字节按替换符容错；**无全文索引**——性能随 workspace 线性退化（大数据集受限，索引属后续增强，如实记录）。
- **TeX facade 对齐**：`tex-facade.ts` 实现同一 `WorkspaceStoreLike` 扩展（listSince/search/readVersion）——TeX 文档经通用接口可读（workspace_id=`ws_<document_id>`、kind=manuscript、版本/etag/hash 与 tex 权威一致，无第二套字节/revision 权威）；tex store 无 per-op ledger 与 per-file 版本历史，故 facade 的 `listSince` 保守整树上报、`readVersion` 仅当前版本（取舍如实记录）。
- **HTTP（v1，项目域路由，BFF 透传保持鉴权）**：`POST/GET /v1/projects/{id}/workspaces`（创建/列出，含 manuscript facade 工作区）、`GET .../workspaces/{wsid}/tree`、`GET .../workspaces/{wsid}/nodes`（`?path=` 读 / `?path=&version=` 回退 / `?after_revision=` watch）、`POST .../workspaces/{wsid}/nodes`（写，expected_version/expected_etag CAS）、`DELETE .../workspaces/{wsid}/nodes`（删）、`POST .../workspaces/{wsid}/moves`、`POST .../workspaces/{wsid}/search`、`POST .../workspaces/{wsid}/assets`（multipart 二进制）、`GET .../workspaces/{wsid}/blobs?path=`（原始字节 + media type + etag 头）。跨项目 workspace → 404 `workspace_not_found`（路径项目绑定）；BFF 按路径项目做 membership/role 检查，multipart 以原始字节/原 boundary 透传（与 UPLOAD-01 同一通道）。
- **证据**：tests/unit/workspace-store.test.ts 15/15（原子写/无 tmp 残留/0750 根、revision-etag、409、move/delete CAS、二进制 round-trip + CAS 引用、路径安全负向 + symlink、历史回退 + 保留窗口、listSince/search、大小上限、per-project 根、facade）、tests/security/run-workspace-tests.sh 38/38（真实 curl 全链路 + BFF 透传/鉴权负向，已接入 run-all-v2-blocking-tests.sh）。浏览器编辑器 UI 与桌面/窄屏浏览器验收剩余（无 Playwright 类环境）。

## 13. Release Bundle 与 clean-room

Bundle 包含 manifest、TeX/PDF/BibTeX/figures、源代码、数据 manifest、锁文件、镜像 digest、contracts、RunManifest、metrics、analysis、licenses、AI usage、reproduce 和 verify 脚本。

Clean-room 在新 dataDir 和 Runner 中验证所有 hash，物化、重跑关键实验、重算分析、重建 PDF，比较合同容差并生成 reproducibility-report。只有 Pass 后才创建 Release Gate Request；Bundle 默认 private/unapproved。

## 14. Self-referential Cordis 与执行面的隔离

开发模式的 cordis_mount 运行在 DSH 进程内，不是 Runner，也不是安全沙箱。它不能用于正式 Job、TeX 编译、Evidence 或 Gate。动态工具不得拿到 Runner key、Kernel internal token 或数据库路径。完整开发开关与限制见 dsh-integration.md 和 security-baseline.md。

## 15. Config Registry

所有运行时配置项由 canonical Config Registry 管理（CONFIG-01）：单一 Zod schema 注册表
（scope 层次、secret/security-floor 标记、来源）、`validateConfig` 合并默认 + 拒绝未知键 +
security floor 违规拒绝 + 对 effective config 计算 sha256 pin；JSON Schema / 默认值
template / CLI 帮助文本全部由注册表生成。Kernel 与 standalone 的 HTTP 响应携带
`x-config-pin` 头、health 暴露 `config_pin`，配置变更后 pin 必然变化。详见
[config-registry.md](config-registry.md)。

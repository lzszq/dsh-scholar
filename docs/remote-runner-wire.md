# RemoteRunnerAgent Wire 协议

> 规范性文档（RUN-REMOTE-01，execution-runtime.md §5.1 的实现契约）。
> 定义受控远端 Runner Fleet 的服务端（RemoteFleetServer，runner-gateway）与
> 代理端（RemoteAgent 客户端）之间的 HTTP+JSON wire 协议。全部消息 schema
> 为 zod（`@dsh-scholar/research-schemas/remote-runner-wire`），两端共享同一
> 份 schema——协议层完整可测。

## 1. 目标与非目标

目标：

- 同一 ExecutionPlan / lease / run_id / Manifest 跨 Local/Remote 一致：远端
  路径与本地 runner 走同一 kernel claim/frames/artifact/complete 路径；
- 离线 fail closed 且不静默降级：target offline / capability mismatch 返回
  明确 retryable 环境错误；没有显式 PI/Operator 新 attempt 时不回退
  LocalDocker，更不回退 subprocess；
- 协议层（schema + 服务端 + 代理端 + mock 传输）完整可测。

非目标（本阶段如实记录，属后续阶段）：

- 真实 mTLS 证书链与 CA 签发/吊销（本阶段用 `x-service-token` 等价实现，
  见 §3）；
- 真实远端 sandbox 的隔离验收（容器/虚机/裸金属差异）；
- 网络分区故障注入的集群级验证（mock 传输层已覆盖断网/恢复语义）。

## 2. 角色与生命周期

```
┌─────────────────────────┐   wire（HTTP+JSON）   ┌──────────────────────┐
│  Research Kernel        │◄──────────────────────►│  RemoteFleetServer   │
│  (job/lease/frames/     │   kernel client        │  (runner-gateway)    │
│   artifacts/manifest)   │                        └──────────▲───────────┘
└─────────────────────────┘                                   │ /v1/agents/*
                                                              ▼
                                              ┌──────────────────────┐
                                              │  RemoteAgent 客户端   │
                                              │  (register/heartbeat/ │
                                              │   claims/执行/spool)   │
                                              └──────────────────────┘
```

- 服务端从 kernel 按既有 `claimJobs` 路径拉取 Job（同一 lease owner/
  generation/token/run_id），固定并**签名 ExecutionPlan**，按 agent 的
  target_id + capability 匹配分发；
- 代理端验签 → 拉取 CAS 输入并复算 hash（不一致拒绝执行）→ 执行（secure
  kinds 只能进入 digest-pinned restricted container；subprocess 仅 echo 与
  显式 trusted smoke fixture，hardening §5 两行）→ 隔离 sandbox
  执行 → 按 generation/token 上报 frames、stage/finalize Artifacts、
  complete；
- 服务端把 frames/artifacts/complete 原样转发 kernel（与本地 runner 同路径，
  kernel 的 lease fencing 是最终权威）。

## 3. 传输与认证

生产必须双向 mTLS service identity（服务端持有 CA 签发证书，客户端持有
service 证书；撤销即断开）。**本阶段环境无 CA/mTLS 设施**，本地 wire 用
`x-service-token` 头等价实现——与 kernel 内部路由（API-01/EVID-01）同一
机制：配置 serviceToken 后所有 `/v1/agents/*` 路由要求该头，常数时间比较，
缺失/错误 → 403 `service_token_required`。

生产差异（如实记录）：

- `x-service-token` 只证明"持有共享密钥"，不证明 agent 身份；生产必须替换
  为 mTLS 证书指纹校验（`RemoteAgentRegistration.cert_fingerprint` 已为远程
  Agent 预留必填语义）；
- 真实证书吊销/轮换/跨租户隔离未验收。

注册与心跳还必须携带 Agent 专属的 `x-runner-target-token`。Fleet 读取当前 Target revision，原样转交该凭据到 Kernel 的 Target heartbeat 端点；Kernel 校验 `service_identity` SecretRef 后才允许 Fleet 更新注册表与 `last_seen_at`。不得用 Gateway 自己的 Target token 补齐缺失 Agent 凭据；失败保持原状态。注册时绑定 agent_id→target，并在异步 Kernel 鉴权后再次核对绑定，防止并发注册跨 Target 覆盖；后续 Agent 路由核对同一身份；共享 service token、自报 target 或证书指纹均不能替代该证明。凭据不进入 Job、Plan、注册记录和回执。该机制没有完成真实 mTLS 证书映射/轮换的验收。

## 4. 端点

所有路径前缀 `/v1/agents`。除 CAS 外均为 JSON POST；错误面统一
`{ "error": { "code", "message", "retryable" } }`（§7）。

| 方法 | 路径 | 请求/响应（wire schema） | 语义 |
|---|---|---|---|
| POST | `/v1/agents/register` | `AgentRegisterRequest`/`AgentRegisterResponse` | 注册（capabilities/labels/health/cert_fingerprint）；`acknowledged=true` 表示服务端认可该 target |
| POST | `/v1/agents/{agent_id}/heartbeat` | `AgentHeartbeatRequest`/`AgentHeartbeatResponse` | 心跳（可携带 draining、更新 capability/labels）；未注册 → 404 `agent_not_registered` |
| POST | `/v1/agents/{agent_id}/claims` | `AgentClaimRequest`/`AgentClaimResponse` | 拉取匹配 claim（含签名 ExecutionPlan + lease generation/token）；空数组 = 无工作 |
| POST | `/v1/agents/{agent_id}/runs/{run_id}/heartbeat` | `RemoteRunHeartbeatRequest`/`RemoteRunHeartbeatResponse` | claim/job/owner/generation/token 精确匹配，Kernel Job 续租并返回 running/cancelled 与最新 expiry |
| POST | `/v1/agents/{agent_id}/runs/{run_id}/frames` | `RemoteFramesRequest`/`RemoteFramesResponse` | terminal frames（kernel 语义：全局 seq 单调、chunk/gap/exit、retention 记账） |
| POST | `/v1/agents/{agent_id}/runs/{run_id}/artifacts` | `RemoteArtifactStageRequest`/`RemoteArtifactStageResponse` | stage：声明 sha256/size/kind/元数据，不携带内容 |
| POST | 同上（finalize 分支） | `RemoteArtifactFinalizeRequest`/`RemoteArtifactFinalizeResponse` | finalize：携带内容，服务端复算 sha256 比对（不一致 → 409 `cas_hash_mismatch` 不落库） |
| POST | `/v1/agents/{agent_id}/runs/{run_id}/complete` | `RemoteCompleteRequest`/`RemoteCompleteResponse` | 完成：签名 run_manifest + fencing 字段；kernel 拒绝 → 409 |
| GET | `/v1/agents/{agent_id}/cas/{sha}?project_id=` | `CasFetchResponse` | CAS 拉取：响应携带服务端复算的 sha256，代理端必须复算比对 |

`/v1/agents/{agent_id}/runs/{run_id}/artifacts` 按 body 区分分支：含
`stage_id` + `content_base64` → finalize；否则 → stage。

## 5. 语义

### 5.1 claim：匹配、保留与 fencing

- 分发条件：`plan.target_id === agent.target_id`（精确）+ `matchesTargetCapability`
  （images/os/arch/runner_ver 下限）+ agent 在线（`isTargetAvailable`）；
- **无匹配 target → 任务留在服务端 pending（retryable），绝不静默改派到其它
  target / LocalDocker / subprocess**；pending 有界（`maxPendingJobs`），
  lease 过期后由 kernel 侧 `recoverExpiredLeases` 回收为 retryable；
- claim 分发的任务进入 outstanding（按 agent 保留）：**agent 断连期间服务端
  保留任务，恢复后 resume 返回同一 claim（同一 claim_id/run_id/lease）**；
  单 agent outstanding 有界（`maxOutstandingPerAgent`）；
- claim 响应中的 ExecutionPlan 由服务端签名（Ed25519，§12.7 同源语义）；
  代理端必须验签，缺签名/验签失败/未配置公钥 → 拒绝执行。

终态 claim 必须立即释放 outstanding 容量（默认 8）；终态回执独立限量/限时保存（每类默认 1024 条、15 分钟）。去重键绑定 job_id/run_id/lease_generation，只保留活跃 attempt；pending/outstanding 租约过期先清理再检查容量。Kernel 恢复后的新 generation 必须重新分发，不能因旧 job_id 丢弃。Plan 保持不可变签名，续租后的 expiry 单独保存在 claim envelope。

Agent 心跳独立于执行循环，间隔不超过 Fleet offline 窗口的三分之一。运行监督按 `min(heartbeat-ms,cancel-poll-ms,剩余租约/3)` 调用 run heartbeat（默认监督 5 秒）：读取 Kernel 当前 Job、校验 attempt 并续租；cancelled 或 fencing 失败终止执行进程树。网络错误不得延长本地已确认租约，独立 expiry watchdog 在断网/请求挂起时停止执行。结束、取消与停止循环必须清除定时器和取消监听；Kernel 不得续租终态或已过期 Job。

HTTP 成功响应头不代表请求已完整返回：响应体读取阶段的断连和超时也归为可重试的 `transport_unreachable`，不得因此取消仍持有有效租约的实验。完整但非法的 JSON 仍是协议错误；无 JSON envelope 的 429/5xx 继续按临时错误重试，显式 fencing 拒绝不重试。

### 5.2 frames：kernel terminal 语义复用

- 全局 seq 单调（幂等回放/乱序跳过由 kernel 执行）、stream_seq 按通道、
  chunk/gap/exit、byte offset/length、`lease_generation` 逐帧携带；
- `owner`/`lease_token` 在请求级携带——服务端逐条核对 claim 的 lease，
  kernel 侧再按 job 当前 lease 精确匹配（409 `lease_stale`）；
- 服务端转发复用本地 runner 的 lease 头路径（`appendTerminalFramesWithLease`）；
- 淘汰/溢出由 kernel retention 记账（truncated/total_bytes/dropped_bytes）。

### 5.3 代理端离线 spool（有界）

网络断开（`transport_unreachable` 等 retryable 传输错误）时代理端把
frames/stage/finalize/complete 保存到本地有界 spool（`maxEntries`/
`maxBytes`，默认 256 条 / 4 MiB），恢复后按序重放：

- 同一 run 的新 chunk/exit 不得越过已缓冲的帧或待确认 gap；恰好满 64 帧的批次也必须等待发送链完成。gap 未确认时保留后续帧和 complete，直到重放成功；并发 flush 期间不允许新发送或队列修改越过在途重放。
- 只有 `frames`（chunk 数据）条目可淘汰；淘汰时记录该 run 的 overflow 区间，
  **重放前先补发 gap frame**（`frame_kind='gap'`，payload 带
  dropped_from_seq/dropped_to_seq/dropped_bytes/reason=`agent_spool_overflow`）
  ——kernel retention 记账可见，不静默丢弃；
- `exit_frame` / `artifact_*` / `complete` 条目不可淘汰——spool 满时 push 被
  拒绝，该 run 本地失败（fail closed，无合成成功）；
- **complete 必须是该 run 的最后一条 wire 消息**：发送 complete 前先冲刷
  spool；若该 run 仍有 spool 条目（网络仍断），complete 强制入队（顺序保证）；
- 重放时 `lease_stale` 条目视为死条目丢弃并继续（该 run 已被新 attempt
  接管，留在队列只会阻塞后续条目）；该 run 的 log artifact 与 complete 是
  权威输出记录；
- resume 幂等：断连恢复后 poll 回放同一 claim 时，代理端按 run_id 返回已存
  结果，不重复执行。

> **持久化结论（WORK-01 §5 P2，hardening §5 行）**：spool（`AgentOutboundSpool`）
> 与注册表（`InMemoryAgentRegistry`）、fleet 服务端的 pending/outstanding/
> stages 状态全部为**内存态**，无磁盘 spool——进程重启即丢失，不引入大持久化
> 框架。自愈依赖既有 lease 过期语义：agent 重启后重新 register/heartbeat；
> fleet 重启后 kernel lease 过期（默认 300s TTL）→ 旧 claim 的后续写入 409
> `lease_stale`、job 回 queued retryable → fleet 重新 claim 分发；spool 内存
> 条目随 agent 进程丢失 → terminal 帧缺 seq（kernel retention/gap 语义兜底），
> 业务终态仍由 complete/cancel transaction 决定；内存幂等只覆盖同一 Agent 进程，不能保证重启后的同一 run 恰好执行一次。

### 5.4 artifacts：staged + finalize + sha256

- stage 只声明 `sha256`（64 位小写 hex）/`size`/`kind`/元数据；finalize 携带
  内容，服务端复算 sha256 并与 stage 声明比对——不一致 → 409
  `cas_hash_mismatch`（不落库）；size 不一致 → 409 `cas_size_mismatch`；
- stage 表有界（`maxStages`）；finalize 内容上限 32 MiB（与 UPLOAD-01 同一量级）；
- 代理端自生成 `stage_id`（跨 spool 重放保持一致）；同 id 的重复声明必须完全一致，否则 `stage_conflict`。
- finalize 成功前保留 stage；上游 5xx/429 可重试；并发 finalize 合并一次注册；成功后保留有界回执，响应丢失后返回相同 artifact_id/hash 与 `reused=true`。已恢复/终态 attempt 不得写入产物。
- Fleet finalize 必须调用 Kernel 的 `POST /v1/jobs/{job_id}/artifacts`，携带 project/run/owner/generation/token。Kernel 在 `BEGIN IMMEDIATE` 事务内验证 running 状态、完整身份和未过期租约，再写 CAS、Artifact 与 outbox；取消或恢复先提交时返回 409 `lease_stale`，不会新增 blob、Artifact 或事件。普通 `/v1/artifacts` 不用于远端 run 的 finalize；租约字段不进入产物 metadata。
- Agent spool 中的失败 stage 必须先于对应 finalize 重放，complete 等待 frames/artifacts；完全相同的 complete 重放使用终态回执，不能重复完成。回执过期或 Fleet 重启后的 unknown claim 不得解释为成功。

### 5.5 complete：manifest 签名 + fencing

- `run_manifest` 必须携带 `signature`/`payload_sha256`/`signed_by`（§12.7，
  kernel 验签）并携带 `lease.generation/token`；secure kinds 还须携带
  required facts（`container_digest=docker:<plan digest>`、`data_hash`、
  `code_snapshot_id`、`seed`、`metrics_artifact`、`run_id`——kernel
  completeJob 缺失/不一致 → 422，见 hardening-v0.2-status.md §5 两行）；
- **run_id 全链绑定**（hardening §5 两行）：complete 顶层 `run_id` 必须与
  claim 的 `plan.run_id` 一致（旧 attempt → 422 `run_id_mismatch`）；
  stage/finalize 请求体 `run_id` 同样必须与 URL run_id 一致；
- lease 过期后旧 agent 的 complete 被 kernel 拒绝（409 `lease_stale`）——
  服务端把该 claim 置 settled，旧 agent 的后续 frames/stage/finalize/
  complete 一律 409；**旧 agent 只能丢弃或保留本地诊断，不能完成 Job**。

### 5.6 CAS

- 按 artifact id/sha 寻址（支持 `sha256:<hex>` / 裸 64-hex；注册 id 由 kernel
  侧解析，当前 mock 按 id 直查）；
- **字节流**：服务端以 kernel artifact 原生字节 → base64 响应（fleet client
  经 `fetchArtifactBytes` arrayBuffer 读取，**绝不经过 UTF-8 text 编解码**——
  二进制内容往返无损，hardening §5 两行 / acceptance remote-cas-binary-auth）；
  响应携带服务端对内容的 sha256；代理端复算内容 hash 并与响应比对，再与
  寻址 hash（当 id 为内容 hash 形态时）比对——任何不一致 → 拒绝执行；
- **project binding**：`?project_id=` 必须落在该 agent 的 outstanding claim
  所属项目内（越权 → 403 `cas_project_forbidden`）；kernel 鉴权失败（401）
  非 retryable fail fast，不静默当 `cas_missing`；
- 404 `cas_missing` 由代理端视为输入缺失（拒绝执行）。

## 6. 服务端离线判定

`AgentRegistry`（内存实现）持有注册记录（opaque target_id/agent_id/
capabilities/labels/health/cert_fingerprint；`.strict()` 拒绝
address/certificate/SSH bootstrap——连接信息只由服务端 Config/SecretRef
解析）。离线判定与调度纯函数同一规则：`health.status !== 'online'` 或
`last_seen` 超过 `offline_after_ms`（默认 30s）。offline agent 的 claims →
409 `agent_offline`（retryable）；心跳恢复 last_seen 后重新可用。

## 7. 错误面

统一 envelope：`{ "error": { "code", "message", "retryable" } }`。

| 状态 | code | retryable | 说明 |
|---|---|---|---|
| 403 | `service_token_required` | false | 缺/错 x-service-token（生产为 mTLS 校验失败） |
| 404 | `agent_not_registered` | true | 未注册 agent 的任意调用 |
| 404 | `claim_unknown` | true | 无 outstanding claim 的 run 写入 |
| 404 | `stage_unknown` | false | finalize 未知 stage |
| 404 | `cas_missing` | true | CAS 输入不存在 |
| 409 | `agent_offline` | true | agent last_seen 超时 |
| 409 | `lease_stale` | true | fencing 不匹配/settled claim（旧 agent 写入） |
| 409 | `cas_hash_mismatch` / `cas_size_mismatch` | false | 内容寻址完整性失败 |
| 409 | `stage_capacity` | true | stage 表满 |
| 413 | `payload_too_large` | false | 请求体/finalize 超限 |
| 422 | `validation_error` | false | wire schema 校验失败（.strict()） |
| 422 | `missing_project_id` | false | CAS 缺 project_id |
| 502/503 | `kernel_unreachable` | true | kernel client 调用失败 |

调用方对 retryable 错误必须把任务留在队列/标记重试——**绝不静默降级**。

## 8. 测试与实现证据

- 协议 schema：`packages/research-schemas/src/remote-runner-wire.ts`；
- 服务端：`workers/runner-gateway/src/remote-fleet-server.ts`
  （RemoteFleetServer + attachRemoteFleetRoutes + startFleetHttpServer）；
- 代理端：`workers/runner-gateway/src/remote-agent.ts`
  （RemoteRunnerAgentImpl + HttpRemoteFleetTransport + defaultSubprocessExecutor）；
- spool：`workers/runner-gateway/src/agent-spool.ts`；
- mock 传输：`workers/runner-gateway/src/in-memory-transport.ts`
  （InMemoryFleetTransport 直连服务端处理器 + JSON round-trip；
  FailingFleetTransport 断网/按方法故障注入）；
- 测试：`tests/unit/remote-wire.test.ts`（15 用例，mock 传输 + HTTP loopback；
  覆盖 §4/§5 全部语义）、`tests/unit/remote-fleet.test.ts`（23 用例，接口层）
  与 `tests/unit/fleet-bin.test.ts`（11 用例，真实 HTTP 传输下的 CLI 接线：
  角色互斥、固定端口绑定、全链 runFleetAgentMain、离线 spool 恢复、
  无匹配 target 留 pending、appendTerminalFramesWithLease 绑定回归）。

**修复（FLEET-01 接线时发现）**：`kernel-client.ts` 的
`appendTerminalFramesWithLease` 曾以未绑定方式调用 `client.request`——`this`
为 undefined，抛 `Cannot read properties of undefined (reading 'timeoutMs')`；
本地 runner 的 `.catch(() => undefined)` 掩盖为帧静默丢失，fleet 服务端转发
frames 则表现为 502 `kernel_unreachable`（真实 kernel 全链 e2e 中帧永远无法
送达）。已改为 `request.call(client, …)` 绑定调用；回归测试见
`tests/unit/fleet-bin.test.ts`（真实 node:http 接收端断言 lease 头与请求体
原样送达）。

**剩余（如实记录）**：真实 mTLS 证书链（CA/吊销/轮换）验收、真实远端
sandbox 隔离验收、跨主机网络分区故障注入、Remote PTY 与浏览器 UI
（hardening-v0.2-status.md §3 RUN-REMOTE-01）。

## 9. 生产接线（FLEET-01，runner 二进制 CLI）

wire 协议已接入 `runner-gateway` 真实 CLI（`node lib/bin/runner.js`，
Config Registry runner-profile scope 解析；见 hardening-v0.2-status.md §8
FLEET-01 行）。本地、Fleet 服务端、直接 Agent 与受控 SSH bootstrap 四种互斥角色由 flag 决定，同一二进制：

| 角色 | 启动方式 | 行为 |
|---|---|---|
| 本地 claim 循环（默认） | `--kernel <url> [--mode subprocess\|docker]` | 既有本地 runner 行为完全不变（§12.6/§12.7） |
| Fleet 服务端 | `--fleet-server <port>` | RemoteFleetServer：从 kernel 按既有 claimJobs 路径拉取 Job、固定并签名 ExecutionPlan、按 target 分发；wire 挂真实 HTTP 路由（/v1/agents/*） |
| Fleet 代理端 | `--agent <fleet-url>` | RemoteRunnerAgentImpl 客户端循环：register → heartbeat → poll claims → 执行 → frames/artifacts/complete；离线有界 spool 复用 AgentOutboundSpool |
| SSH 引导端 | `--agent <fleet-url> --ssh-bootstrap-target <target_id> --secret-root <dir> --fleet-public-key <pem>` | 从持久 RunnerTarget 的服务端 file SecretRef 严格解析 endpoint/key/known_hosts，以 pinned host key 建 SSH，只启动远端 `dsh-scholar-runner` Agent；不接受任意命令 |

互斥校验（启动时 fail fast，exit 1）：

- `--fleet-server` 与 `--agent` 不能同时给（一个进程只服务一个角色）；
- `--ssh-bootstrap-target` 必须与 `--agent`、`--secret-root`、`--fleet-public-key` 一起使用，且不能与 `--fleet-server` 组合；
- 任一 fleet 角色与 `--mode` 不能同时给（`--mode` 只对本地 claim 循环
  有意义——远端执行由 agent 侧 executor 决定，计划由 ExecutionPlan 固定）；
- 未知 flag / 非法值仍由 parseCli/validateConfig 拒绝（CONFIG-01）。

### 9.1 Fleet 服务端（--fleet-server）

~~~bash
DSH_SCHOLAR_SERVICE_TOKEN='<svc-token>' node workers/runner-gateway/lib/bin/runner.js \
  --fleet-server 7415 \
  --kernel http://127.0.0.1:7412 \
  --owner fleet-1 \
  --key-file /path/to/fleet-key.pem
~~~

- 监听 `127.0.0.1:<port>`（`--fleet-server 0` = 临时端口，stderr 打印实际
  baseUrl）；生产部署须显式绑定可达接口并在反向代理/TLS 层终止 mTLS；
- 鉴权：所有 `/v1/agents/*` 路由要求 `x-service-token`（只能通过
  `DSH_SCHOLAR_SERVICE_TOKEN` 环境或受控 0600 配置文件注入；与 kernel
  内部路由同一机制，常数时间比较）。runner 拒绝 secret argv。**生产必须替换为
  mTLS service identity**（§3 生产差异）；
- 注册表 = agent-registry（InMemoryAgentRegistry）；plan 签名密钥 =
  `--key-file` 或临时生成的 Ed25519 密钥，**公钥 PEM 打印到 stderr**，供
  agent 以 `--fleet-public-key` 配置验签；
- kernel client 复用本地 runner 同一 ResearchClient 路径——lease/run_id/
  Manifest 跨 Local/Remote 一致；kernel 不可达时任务留 pending（retryable）。

### 9.2 Fleet 代理端（--agent）

~~~bash
DSH_SCHOLAR_SERVICE_TOKEN='<svc-token>' node workers/runner-gateway/lib/bin/runner.js \
  --agent http://127.0.0.1:7415 \
  --target-id local-docker \
  --agent-id worker-1 \
  --fleet-public-key /path/to/fleet-public.pem \
  --key-file /path/to/agent-key.pem
~~~

- `--agent-id` 缺省生成 `agent-<8 hex>`；`--target-id` 缺省 `local-docker`
  （opaque 精确匹配分发）；capability 自动上报（os/arch/runner_ver 取自
  宿主与包版本，images 空 = 接受任何 Kernel 锁内 digest）；
- `--fleet-public-key`：服务端签名 ExecutionPlan 的验签公钥 PEM。**缺省 →
  任何 plan 拒绝执行（fail closed，绝无未验签执行）**；
- `--key-file`：代理端签名 run_manifest 的 Ed25519 密钥。kernel 按 §12.7
  验签——显式提供 `--kernel <url>` 时，本进程尽力把该公钥注册到对应 kernel
  （非致命：失败仅告警，须经 `POST /v1/runner-keys` 带外注册；未注册 →
  422 manifest_key_unknown，fail closed）；
- 断网 → 本地有界 spool（§5.3），恢复后按序重放；`--poll-ms` 控制轮询间隔。

### 9.3 本地验收拓扑（无 mTLS 环境，x-service-token 等价实现）

kernel + fleet 服务端 + agent 同机：以同一受控 `DSH_SCHOLAR_SERVICE_TOKEN` 启动三者，
fleet 服务端打印的公钥存文件后传给 agent `--fleet-public-key`；agent 显式
`--kernel` 以注册 manifest 公钥。`tests/unit/fleet-bin.test.ts` 以真实
node:http listener + HttpRemoteFleetTransport 覆盖该拓扑的全链
（register/heartbeat/claim/执行/frames/artifacts/complete、离线 spool 恢复、
无匹配 target 留 pending）。

### 9.4 剩余验收条件（如实记录）

真实 mTLS 证书链（CA 签发/吊销/轮换、服务端与客户端证书身份校验）、
跨主机部署（非 loopback 接口、网络分区故障注入）、真实远端 sandbox 隔离
验收、Remote PTY 与浏览器 UI——本阶段环境无 CA/第二主机，保持 🌐 状态。

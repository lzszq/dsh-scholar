# Config Registry（canonical Config Schema）

> 规范性文档（CONFIG-01，hardening-v0.2-status.md §3 CONFIG-01）。所有运行时配置项由
> `packages/research-schemas/src/config-registry.ts` 的 **canonical Config Registry**
> 单一管理；本文描述注册表的形态、校验语义、生成物与接入点。

## 1. 目标

配置不再散落于 Cordis schema、CLI、env 与 UI preferences 各处。每一个运行项只声明一次：

- 一个 **dotted canonical key**（如 `execution.network_policy`、`runner.poll_ms`）；
- 一个 **ConfigScope**（global / project / job / runner-profile，以及 kernel / standalone
  两个二进制作用域）；
- 一个 **Zod schema**（值级校验，唯一事实来源）；
- 一个 **default**、**secret** 标记与 **security-floor** 标记；
- 允许的 **来源**（CLI / env / file / HTTP / UI）；
- 一个生成式 **write descriptor**：允许的持久层（global / project / runtime）、
  `hot` / `restart` 生效判定和 security merge 规则。

Registry 是生成权威：JSON Schema、默认值 template、CLI 帮助文本全部从注册表生成，
不会与 Zod 漂移。

## 2. 作用域层次

| Scope | 内容 | 当前覆盖 |
|---|---|---|
| `global` | 全局基础（images.lock 路径与两个固定 digest） | `global.images_lock.*` |
| `project` | 项目执行与完整性配置（design §6.2） | `execution.*`、`integrity.*`（ExecutionConfig + IntegrityConfig 全字段） |
| `job` | 每 Job 策略（timeout、log retention） | 预留：目前由 runner-profile 与 Job payload 派生，无键 |
| `runner-profile` | Runner 网关 CLI 与容器安全面 | `runner.*`（kernel endpoint/mode/poll/heartbeat/timeout/cancel/owner/key-file/token/service-token/target-token/network/privileged/docker_socket） |
| `orchestrator` | Durable Research Orchestrator CLI（design §8） | `orchestrator.*`（kernel/db/poll_ms/once/dry_run） |
| `kernel` | Research Kernel 守护进程 | `kernel.*`（host/port/token/service-token/db/cas/secret-root/endpoint-file/require_signed_manifest，以及新 PTY 会话的 idle/retention/lease 策略） |
| `standalone` | standalone BFF | `standalone.*`（host/port/kernel_port/data_dir/token/principal/frame_ancestors/no_token） |

env 别名在键上声明（生成 JSON Schema 的 `x-dsh-env` 注解与 template 注释带出）：
`DSH_SCHOLAR_KERNEL_TOKEN`、`DSH_SCHOLAR_SERVICE_TOKEN`（kernel/runner）、
`DSH_SCHOLAR_KERNEL_ENDPOINT_FILE`、`DSH_IMAGES_LOCK`、`DSH_HOME`（standalone
data_dir 缺省基目录）、`DSH_SCHOLAR_STANDALONE_{HOST,PORT,KERNEL_PORT,DATA,FRAME_ANCESTORS}`
（start-standalone-ui.sh 翻译为 CLI flag 的别名）。

## 3. 校验语义（`validateConfig`）

`validateConfig(input, { scopes?, imagesLock? })` 对给定对象执行：

1. **合并默认**：以注册表默认值为底，输入覆盖之（仅限请求的 scope 集合）。`execution.runner_profile_id` 的安全默认是显式 `null`，只表示 DRAFT 未配置，不是本机 Docker alias；
2. **拒绝未知键**：不在注册表（或 scope 集合）内的 dotted key → `unknown_config_key`；
3. **值校验**：每个值过对应 Zod schema，失败 → `validation_error`；
4. **security floor 违规拒绝** → `security_floor_violation`：
   - `runner.privileged=true`（禁 privileged 容器，security-baseline.md §5）；
   - `runner.docker_socket=true`（禁 Docker socket 挂载，§5）；
   - `runner.network=host`（禁 host network，§5 / execution-runtime.md §5）；
   - `runner.mode=subprocess` 时 `runner.network` 只能是 `none`（subprocess 无容器；
     每 Job 的 secure-kind 拒绝由 runner 执行层 enforce，见 execution-runtime.md §1）；
   - `execution.network_policy=none` 时 `runner.network` 只能是 `none`；
   - `integrity.allow_automatic_public_release=true`（自动发布禁止，security-baseline.md §1）；
   - `standalone.no_token=true` 时 host 必须是 loopback（127.0.0.0/8、::1、localhost）；
   - 提供 `imagesLock` 时 digest 键必须与锁条目完全一致（RUN-02）；
5. **pin hash**：对合并后的 effective config（含 secret）计算 canonical JSON 的
   sha256（`sha256:<64hex>`）。相同配置 → 相同 pin；任何值变化（含 secret）→ pin 变化。

返回值：

- `effective`：合并后的完整配置（含 secret 值，调用方决定如何持久化）；
- `redacted`：明文安全视图——secret 值一律替换为 `<redacted>`；
- `byScope`：按 scope 分组的 effective；
- `pinHash`：单向 sha256，**secret 只进入 pin，不进入任何明文输出**。

## 3.1 CLI 解析（`parseCli`）

`parseCli(argv, scope)` 是各二进制 CLI 解析的唯一入口（kernel / runner-profile /
orchestrator / standalone 四个 scope 全部接入）：

- 只接受注册表 `cli` 声明过的 flag，映射为 canonical key；
- 数字 flag 从字符串转换（`--port 7413` → `kernel.port: 7413`），布尔 flag
  原生解析（`--no-token`/`--once`/`--dry-run`）；
- 未知 flag → `unknown_config_key`，非法数值 → `validation_error`，错误消息
  永不回显 secret 值；
- 只返回 **argv 显式提供** 的键（不合并默认、不读 env）——调用方用
  `validateConfig()` 合并默认并取得 effective + pin；
- 每个 scope 的 `--help`/`-h` 打印 `generateCliHelp(scope)`（注册表生成）。

## 4. 生成物

| 生成物 | 位置 | 说明 |
|---|---|---|
| Zod schema | `@dsh-scholar/research-schemas`（`config-registry.ts` 导出） | 每个键的 `schema` |
| JSON Schema (draft-07) | `configs/generated/config.schema.json` | 按 scope 嵌套，含 canonical `x-dsh-key`、default/description、write scopes、apply verdict、secret/floor/env 注解 |
| 默认值 template | `configs/generated/template.yml` | `key: default` 树，附来源与 secret/floor 标记 |
| CLI 帮助文本 | `configs/generated/cli-help.txt`（`generateCliHelp(scope)`） | 每个 scope 的 `--flag` 行 |

重新生成（修改注册表后必须刷新并提交）：

```bash
node scripts/generate-config-artifacts.mjs
```

## 5. 运行中对象 pin hash

- `ResearchKernel.configPinHash` / `ResearchKernel.configRedacted`：kernel 构造时
  经 registry 对有效配置（global+project 默认 + 本实例 db/cas/require_signed_manifest/
  service identity + images.lock digest）计算，构造期校验失败即 fail fast；
- kernel HTTP 每个响应带 `x-config-pin` 头；`/v1/health` 与 `/v2/health` 带
  `config_pin` 字段；
- `GET /v1/config/effective?project_id=...`：global + canonical Project row + runtime
  的 **redacted 安全视图**、各层 revision、provenance 与 `config_pin`；没有项目参数时
  不推断任何项目；
- Settings UI 的 Project provenance 只能展示上述 exact-scope `config_pin`；读取失败时
  明确显示不可用，禁止用 `/v1/health` 的 Kernel instance pin 作为 Project pin fallback；
- Kernel 创建 Job 时把 exact Project effective pin 固化为必填 `payload.project_config_pin`，
  Local Runner 与 Remote Fleet 都必须把同一值固定进 `ExecutionPlan.config_pin`；缺失、
  非法或被调用方改写时在执行前 fail closed；
- `GET /v1/config/schema`：注册表生成的 JSON Schema（Settings UI 的服务端
  元数据面）；经 standalone BFF 的 `/v1/*` 代理同样可达；
- `GET /v1/config/layers/{scope}/{scope_id}` 与
  `GET /v1/config/revisions/{scope}/{scope_id}`：读取安全层投影和 append-only revision
  账本；Project scope 必须校验项目成员，其他 scope 必须有全局 PI/Operator 权限；
- `bin/kernel.ts` 启动时经 registry 校验完整部署配置（host/port/token/service-token/
  db/cas/endpoint-file），并把 pin 写入 0600 endpoint 文件的 `configPin` 字段与启动日志；
- standalone BFF 启动时经 registry 校验（含 `--no-token` loopback floor），每个响应带
  `x-config-pin` 头。

配置变更后 pin 必然变化，因此运行中 Job/PTY/Build 可与产生它的配置精确关联
（gui-plugin-plan.md：“运行中 Job/PTY/Build 标注 pinned config hash，修改配置只影响新动作”）。

Panel Dock 的活动页面、首选 right/bottom 位置和两种尺寸是浏览器本地展示偏好：由页面 Dock 控件配置，使用独立版本化 local storage，损坏值回默认；它们不改变 Kernel/Runner/Workspace/Terminal/TeX/Agent 的行为，因此不属于 canonical Config Registry、HTTP config patch 或 Job/PTY/Build config pin。偏好中禁止保存 token、secret、Chat 内容或研究文件。

## 6. 接入点与边界

已接入（CLI 解析全部走注册表 `parseCli`）：

- kernel CLI（`bin/kernel.ts`）：parseCli + validateConfig（fail fast + endpoint
  文件 configPin + `/v1/config/effective` redacted 配置）；
- runner CLI（`bin/runner.js`）：parseCli + validateConfig（claim 前 fail fast，
  启动日志打印 config pin）；
- orchestrator CLI（`bin/orchestrator.js`）：parseCli（保持 --poll-ms > 0 的
  bin 级检查）；
- standalone BFF（`server.js` `loadOptions`）：parseCli + validateConfig
  （--no-token loopback floor 双保险）；
- 四个二进制均支持注册表生成的 `--help`；
- ResearchKernel 构造（pin + fail fast）、createProject（project scope 经
  registry 校验，security floor 生效）、kernel HTTP（响应头 + health +
  config/effective + config/schema）、standalone BFF（启动校验 + 响应头）；
- Settings UI（浏览器层，hardening §5 CONFIG-01/UI-02/UI-03）：
  由 `/v1/config/schema` + `/v1/config/effective` 动态生成（settings-model.ts
  `settingsConfigModel` 纯模型 + modals/settings.ts 接线）——每 ConfigScope 一组
  Accordion（7 组覆盖注册表全部键），每字段展示 effective 当前值（服务端 redacted，
  secret 只渲染掩码）、scope、声明来源、安全基线标记、env 别名、schema 描述与默认；
  config pin 显示 + 变化提示；可写控件完全读取 `x-dsh-key`、
  `x-dsh-write-scopes` 和 `x-dsh-apply`，浏览器不镜像 key 规则、不从 sources 猜生效
  方式。revision 上下文不可用时不渲染保存动作，不保留永久 disabled 的假按钮。

## 6.1 Canonical Settings 写事务（REVIEW-CONFIG-WRITE-03）

唯一浏览器写入口是 `POST /v1/settings/transactions`。请求由一个或多个 strict
operation 组成，最大 64 项：

- `kind=config`：`scope + scope_id + expected_revision + non-empty changes`；global 固定
  `scope_id=global`，runtime 固定使用 registry owner（kernel / runner-profile /
  orchestrator / standalone），每个目标层在一次事务中只能出现一次；
- `kind=ocr-mineru`：Provider create/update 与可选 Project OCR binding 在同一事务；
- `kind=runner-target`：RunnerTarget create/update 复用同一事务边界。

每个 key 按 registry schema、allowed scope 与 security floor 服务端逐键校验；错误 envelope
携带 canonical `key`，UI 只信结构化 key，不解析人类错误文本。secret 写入只接受 strict
`SecretRef {scheme,name,version?,scope?}`，plaintext/value/token/password 或额外字段拒绝；
响应和 revision history 只返回 redacted metadata。

写入使用 SQLite `BEGIN IMMEDIATE` 与 revision CAS；任一 Config、OCR Provider/binding 或
RunnerTarget 操作失败，整个 Settings transaction 回滚。成功 receipt 同时返回更新后的层、
effective pin，以及该次真实 delta 的 `hot_applied_keys` / `restart_required_keys`，UI 不自行
推断。持久层由 migration `0037_config_write_layers` 创建，显式数据接管同时迁移 layer 与
revision ledger。

`restart_required` 是必须由 owner 启动链履行的契约，不等于“写入即已生效”：kernel、
runner-profile、orchestrator、standalone 必须在构造监听端口、DB/CAS、鉴权、Runner 或其他
行为消费者之前读取自己的 runtime layer，服务端解析 SecretRef，并以实际使用的配置计算
applied pin。尚未完成 owner bootstrap 的 key 不得标记 writable；尤其不能让 effective/pin
声称使用了一个实际仍由 CLI/options 提供的 host、port、DB、CAS、token 或 images lock。

Kernel 的三个 PTY 策略键是 consumer-backed runtime hot settings：

| Key | 默认值 | 有效范围 | 生效边界 |
|---|---:|---:|---|
| `kernel.pty_idle_ttl_s` | 900 | 1–86400 秒 | 只固定到写入后新开的 PTY；已有会话继续使用行内钉定值 |
| `kernel.pty_retention_bytes` | 1048576 | 4096–67108864 bytes | 只固定到写入后新开的 PTY；已有会话的回放窗口不重解释 |
| `kernel.pty_lease_ttl_s` | 3600 | 1–86400 秒 | 只决定写入后新会话的 lease expiry；不延长或缩短已有 lease |

三项只允许 `runtime/kernel` 层通过 expected revision CAS 写入，receipt 必须把真实 delta
归入 `hot_applied_keys`，不得要求重启。PTY open body 不接受这些字段，浏览器不能逐会话
放宽策略；Kernel 在 open transaction 前读取当前 effective runtime config，将三项与
`config_pin` 一起固定进会话。写入失败、错 scope、越界值或 stale revision 均零创建、零改写。

Project 配置没有第二权威：`projects.execution` / `projects.integrity` 是唯一业务状态；
Config layer 只保存 Settings CAS/audit projection。已有项目即使没有 layer，也从 canonical
Project row 建立 revision-0 baseline；Project patch 在同一 SQLite transaction 更新 canonical
row 与 projection，二者 pin 分叉时 fail closed。旧 `/v2/projects/{id}/execution`、Provider、
RunnerTarget 与 model-binding direct mutation HTTP routes 已删除；对应 GET 读取仍保留。

权限在 standalone BFF 与 Kernel 各校验一次：Project config/binding 需要该项目
PI/Operator；global/runtime、Provider 与 RunnerTarget 需要全局 PI/Operator；混合事务必须
同时通过所有引用项目与全局权限。actor 只取可信 `x-principal-id`，请求 body 不能声明。

仍预留：job scope 键（每 Job 策略继续由 runner-profile + Job payload 派生）。

## 7. Model Provider 与 OCR 配置增量

Model Provider 是独立的 Provider Registry 权威资源，不写入通用 `CONFIG_REGISTRY`。当前已实现的首个内置 descriptor 只支持 MinerU：固定 `provider_id=mineru`、`kind=mineru`、官方 Open API origin、`flash/pipeline/vlm` 模型目录、启用状态、可选 SecretRef 与 revision；Settings 的「模型与 OCR」分组用 Provider/binding GET 读取，用统一 Settings transaction 写入。Provider global 写与项目 binding 写均使用 revision CAS，并由 BFF 和 Kernel 两层限制为 PI/Operator。

项目仅保存 `purpose=ocr`、provider/model ID、Provider revision/config hash 快照，不保存 endpoint 或 credential。Flash 允许显式无凭据；Pipeline/VLM 必须提供严格 SecretRef，凭据 JSON 损坏必须 fail closed，不能被解释成“未配置”。Provider 与项目 binding 是一个原子 operation，不存在“Provider 已保存但 binding 失败”的部分成功。非幂等写不得由客户端自动重放。

`onboarding.ocr.*` 的 language/page/concurrency/retry、OCR request/worker/status/provenance 仍是目标配置与执行面，当前未注册；不得因为 MinerU Provider/binding 保存成功就显示文件“已 OCR”。`onboarding.upload.chunk_bytes`、`onboarding.upload.intake_total_bytes` 的目标默认值仍分别为 8 MiB 和 2 GiB，最大值为 32 MiB 和 10 GiB。精确 schema 与 fail-closed 规则见 `init-grill-upload-models.md`。

## 8. Experiment Environment 与 Remote SSH Runner

RunnerTarget 仍是独立 registry 资源。Settings 可登记 `local-process`、`local-docker` 或 `remote-ssh` target 的 safe label、capabilities、health、draining、固定 image digest、CPU/NVIDIA compute policy，以及 endpoint/known-hosts/SSH/mTLS `SecretRef`；创建/更新通过统一 Settings transaction，普通 API/浏览器只返回 target ID、label、健康、revision/hash 与 secret available，不返回连接明文。

项目、ExperimentContract、PaperReproductionSpec 与 Job 只选择 opaque profile/target ID。secure Job/PTY/Build 固定 target/profile/effective environment revision/hash；修改只影响新 attempt。远端不可用不自动回退本机。开发接线可由 `runner.ssh_bootstrap_target` + `runner.secret_root` + `runner.ssh_connect_timeout_ms` 启用受控 SSH → RemoteRunnerAgent 引导；SSH endpoint/key/known_hosts 仅从 file SecretRef 解析，项目不能提供。真实 SSH 主机与 mTLS 未通过人工环境验收前状态只能“已实现未验收”或更低。

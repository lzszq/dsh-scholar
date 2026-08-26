# 开发、测试与部署运行规范

> 规范性文档。所有实例必须明确 dataDir、Web port 和 Kernel endpoint；使用 DSH Agent adapter 时还必须明确 DSH_HOME。

## 1. 实例矩阵

| 实例 | DSH_HOME / data | Web | Kernel | Self-mod | 用途 |
|---|---|---:|---:|---|---|
| 日常 DSH | 用户默认 | 3080 | 7412 | 禁止 | 非 Scholar 日常工作 |
| Scholar Agent dev | ~/.dsh-scholar-agent-dev | 3081 | 17412 | 默认禁用 | DSH tools/commands/Skills，无 Scholar Web UI |
| Scholar standalone BFF | ~/.dsh-scholar-standalone（仅 Token/session/UI） | 18610 | 复用 7412 / `~/.dsh/research-kernel` | 不支持 | 独立 UI，与 DSH 显示同一项目集 |
| Scholar selfmod dev | 临时独立目录 | 自选 | 自选 | 显式启用 | Cordis 运行时调试 |
| CI | mktemp workspace | 随机 | 随机/Unix | 仅专门 case | 自动验收 |
| Remote Runner fixture | 独立临时 Agent data | 无 | CI Kernel | 禁止 | mTLS、CAS、partition/fencing/PTY |

端口只是默认值。真正隔离以 dataDir/database_id 为准；health 必须返回 instance_id、protocol_version、schema_version 和 database_id。

## 2. 前置环境

- Node.js 24；
- pnpm 11；
- DSH 当前安装基线是 `@deepseek-ai/dsh@next`，每次安装必须记录实际解析的精确版本；本文更新时 `latest` 与 `next` 均为 `0.1.1-rc.2`，并必须与 `config/dsh-baseline.json` 一致；
- 只有 DSH 宿主开发或补充兼容性排查才需要源码 checkout，通过 DSH_SCHOLAR_DSH_ROOT 指定；checkout 结果不替代 `@next` 精确版本验收；
- DSH 发布兼容性验收需要私有 registry URL、短期只读 token、固定 `@deepseek-ai/dsh` spec 和已发布/可安装的固定 Scholar plugin spec；这些 secret 不写仓库 `.npmrc`；
- Docker，用于正式 Job、Terminal、Golden、TeX 和 clean-room；
- 固定 TeX Live image；本机不要求安装 pdflatex；
- 远端验收需要第二个受控 Linux/VM/container namespace、mTLS test CA 和可注入网络分区的 transport；不能用同一进程 fake 代替阻断验收；
- Linux/macOS 文件权限语义；团队部署另需反代/SSO/PostgreSQL/K8s 设计。

## 3. Clean setup

~~~bash
pnpm install --frozen-lockfile
pnpm -r --filter './packages/*' --filter './workers/*' run build
pnpm typecheck
pnpm test
~~~

DSH Agent 插件需另行运行 `scripts/link-dsh-deps.sh` 和 `pnpm build:plugin`。standalone 的 clean build 不得依赖 DSH symlink。

## 4. 独立 UI

~~~bash
bash scripts/start-standalone-ui.sh
~~~

默认 http://127.0.0.1:18610。Token 生成到 0600 文件并由用户在本地解锁页输入。可覆盖：

- DSH_SCHOLAR_STANDALONE_PORT；
- DSH_SCHOLAR_STANDALONE_KERNEL_PORT；
- DSH_SCHOLAR_STANDALONE_DATA。

独立 host 是唯一浏览器 UI，必须使用同源 BFF、正确流式 Artifact/SSE、locale 首屏和单一 UI 实现。`--no-token` 只允许 loopback 明确开发，不作为默认文档路径；与 `0.0.0.0`、LAN 地址或外部 hostname 组合必须在监听前失败。

## 5. DSH Agent 集成开发实例

Scholar 尚未发布时，当前标准安装路径是先安装 DSH 的 `next` tag，记录精确解析版本，再 build 本仓库并把绝对路径加入 `web` profile：

~~~bash
npm install -g @deepseek-ai/dsh@next
npm ls -g @deepseek-ai/dsh --depth=0  # 本文更新时应记录 0.1.1-rc.2
cd /absolute/path/to/dsh-scholar
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile web add /absolute/path/to/dsh-scholar
~~~

以下 checkout 脚本只用于 DSH 宿主开发和补充验证，不是常规安装前置条件：

~~~bash
bash scripts/start-dsh-agent-dev.sh
~~~

脚本设置独立 DSH_HOME、Web 3081、Kernel 17412 并安装根 Agent 插件。Web 是 DSH 的会话入口，并加载 Scholar 的 Plugin config 与 `dsh Scholar` conversation view；该 view 只显示 Host 原生 session workspace，并在新页面启动另行运行的 standalone 18610，`/research-api` 和 `/research-ui-api` bridge 仍不存在。

当前仓库迁移期验证：

~~~bash
curl http://127.0.0.1:3081/
curl http://127.0.0.1:17412/v1/health
~~~

Agent 集成验收必须证明 tools、commands、subagents、四组 Skills 可用，根 Agent 包 manifest 没有 legacy `dshClient` 字段，并且 `dsh.client`/`./client` 只装配 Plugin config 卡片与受控 conversation view。验证 Chat/Trajectory/dsh Scholar 页签顺序、Alt+Shift+S、URL 配置、loopback-only Token 复制及零回显；完整科研工作台的业务 Golden Path 仍由 standalone 18610 的同一实现验收。

发布兼容性不复用上述 checkout。用隔离环境执行：

~~~bash
DSH_PRIVATE_REGISTRY_URL=https://registry.example.invalid \
DSH_PRIVATE_REGISTRY_TOKEN='<short-lived-read-token>' \
DSH_PRIVATE_DSH_SPEC='@deepseek-ai/dsh@0.1.1-rc.2' \
DSH_SCHOLAR_PLUGIN_SPEC='@dsh-scholar/research-plugin@0.1.0' \
bash tests/integration/run-dsh-private-registry-tests.sh
~~~

脚本自行创建全新安装目录、`DSH_HOME` 和权限 0600 的临时 npm userconfig；输出必须脱敏。缺少真实 registry/credential 时登记 `NOT_RUN_MANUAL_PENDING`，本地 symlink/fake host 不计 PASS。

需要在 Scholar 尚未发布时验证“当前 DSH host 能否安装当前产物”，允许执行一次性 local artifact smoke：从 registry 的 `next` dist-tag 解析并安装 `@deepseek-ai/dsh@next`，随后记录实际安装的精确 `@deepseek-ai/dsh@x.y.z`（本文更新时为 `0.1.1-rc.2`）；把根插件及其所有未发布的本地 `@dsh-scholar/*` 运行时 workspace 包分别经正式 build + pack 生成 `.tgz`，在 `mktemp` 的空 launcher 与独立 `DSH_HOME` 中以 tgz dependency/override 安装完整集合。当前开发阶段不要求单个根插件 tgz 从 registry 解析这些明确未发布的内部包，相关 404 不能判作 DSH 兼容失败；通过条件是所有 Scholar package realpath 均位于临时 profile、没有 checkout symlink，并完成 profile compose/dump、Cordis apply、限定时间存活和 SIGTERM dispose。该 PASS 只证明“当前 `next` host + 当前本地打包集合”的安装/启动兼容性，必须记录 host 精确版本与根插件 tarball hash；不能替代上一段“所有正式发布依赖均可从 registry 固定版本安装”的发布兼容 PASS。临时 npm userconfig 权限必须为 0600，token 只能从进程环境写入，不得出现在 argv、日志或报告，测试结束必须删除临时目录。

## 6. 开发模式启用 Cordis self-referential

它不是 dsh web --dev 的隐含能力，必须显式 overlay：

~~~bash
DSH_SCHOLAR_ENABLE_SELFMOD=1 bash scripts/start-selfmod-dev.sh
~~~

wrapper 使用独立 ~/.dsh-scholar-selfmod-dev、loopback Web 3082、Kernel 17414，并显式加载 research-dev-selfmod overlay。可用 DSH_SCHOLAR_SELFMOD_HOME/PORT/KERNEL_PORT 覆盖，但脚本拒绝 HOME、默认 ~/.dsh 和 /；未设置 DSH_SCHOLAR_ENABLE_SELFMOD=1 直接退出。shared、headless、unattended 和 approval=never 仍不支持。

验证流程：

1. cordis_inspect what=temporary；
2. cordis_mount 挂载只注册 dev_probe 的无害临时插件；
3. 下一轮调用 dev_probe；
4. cordis_inspect 确认 dyn-N；
5. cordis_unmount id=dyn-N；
6. 工具立即消失；重启后不恢复。

动态修改需要永久保留时，必须转为源码、测试和 docs 变更。不得复制 dyn-N 作为部署状态。

## 7. Runner

开发 smoke 可以显式 trusted fixture adapter。正式测试运行 Docker Runner，默认轮询 2s、heartbeat 15s、cancel poll 5s、timeout 60s（具体正式合同可覆盖）。Runner key 文件 0600；先注册 public key，再 claim。

Terminal 测试使用产生交错 stdout/stderr、长输出、非零退出、signal 和 cancel 的 fixture。TeX 使用固定 image digest，不依赖宿主 pdflatex。

本机默认 profile 为 Local Docker。远端开发实例先用 admin 命令把 Remote Runner Agent 的 service identity/certificate、capabilities 和 server-side endpoint label 登记到 Config/Target Registry，再启动 Agent；项目/UI 只选择 profile ID。测试必须覆盖健康、draining、capability mismatch、分区 spool、lease 过期、CAS resume、取消和 Remote PTY。不得在 UI、Job JSON、argv 或日志中输入/打印 SSH credential/endpoint secret。

Interactive PTY fixture 使用真实 pseudo-terminal，覆盖 echo/input、全屏 TUI、Unicode、resize、signal、detach/reconnect、gap/TTL 和撤权。它与正式 Job Terminal fixture 分开运行。

## 8. 测试命令

以下是目标脚本面，生成项目必须在 package.json 实现；当前迁移仓库使用后面的现有命令：

~~~bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:ui
pnpm test:security
pnpm test:docker
pnpm test:golden
pnpm test:workspace-pty-remote
pnpm test:onboarding
pnpm test:trajectory
pnpm test:config
pnpm test:dsh-private
pnpm test:all
~~~

~~~bash
pnpm test
pnpm test:security
bash evals/docker-eval.sh
bash evals/golden-path-v2/run-golden-v2.sh
bash tests/security/run-latex-tests.sh
bash evals/clean-room-rerun.sh
~~~

CI 中 Docker、TeX、Golden、clean-room 不允许因为依赖缺失而 skip 成功。

## 9. 数据清理

开发实例必须先停止进程，再删除它自己的显式 dataDir。不得使用未解析变量、通配符、HOME 根或 workspace 根作为递归删除目标。优先移动到 trash 或备份目录；发布/生产数据按 retention policy 清理。

## 10. Team/Cluster

团队模式改用 SSO Principal、PostgreSQL、S3/MinIO、K8s/Slurm Runner、mTLS internal interface 和集中日志。Browser 仍只走 BFF；Terminal SSE 可由 gateway 转发。Cordis self-mod 在 shared/team 环境保持禁用。

## 11. 运维检查

- 当 Nginx 直接绑定 Tailscale 地址时，不能只依赖 `tailscaled.service` 或普通 `network-online.target`：`tailscaled` 进入 active 后接口/IP 仍可能尚未就绪。Nginx 的 systemd drop-in 必须 `Wants=tailscale-online.target` 且 `After=tailscale-online.target`，复用 Tailscale 自带的 `tailscale wait`，再执行 Nginx 配置检查与绑定。冷启动验收必须确认 Tailscale IP 已存在、Nginx active、目标 443 地址监听且 HTTPS 反代可达；禁止用固定 sleep 或人工重启掩盖竞态；
- health instance/protocol/schema/database 匹配；
- migration 与 backup 成功；
- DB WAL、CAS 空间、孤儿 Blob、过期 lease、孤儿容器；
- Terminal retention/连接数/dropped bytes；
- TeX build queue、image digest 和 PDF Artifact；
- Outbox backlog；
- Runner key 有效期；
- Remote target health/draining/capability、spool 和 mTLS expiry；
- PTY session/idle TTL/gap/orphan、Intake upload/quarantine/expiry、Config revision/restart queue；
- Trajectory cursor/redaction/retention 和 subagent parent availability；
- production tool catalog 无 cordis_*；
- zh/en locale 资源 revision 和客户端 bundle 一致。

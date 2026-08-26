# DSH Scholar

**简体中文** | [English](README.md)

DSH Scholar 是面向纯计算研究的 AI 科研工作台。它把项目对话、研究资料、代码与数据、受控实验、证据和 TeX 手稿保存在同一个可恢复项目中，既可以从新问题开始，也可以继续其他地方已经进行到一半的研究。

![DSH Scholar 中文独立工作台](docs/assets/dsh-scholar-home-zh.png)

## 产品能力

- **按阶段引导研究**：Chat 支持自由对话、Grill Me 信息收集、文件上传、视觉模型输入、显式 slash command，并依据当前研究阶段展示权威下一步。
- **可治理的研究流程**：Scope、Idea、Contract、Evidence、Direction 和 Release 决策都有明确权限、revision 绑定和审计记录。
- **受控执行**：Runner Profile 描述本机、本机 Docker 或远程 SSH 环境，包括固定容器镜像和声明式 NVIDIA GPU 能力。
- **一体化工作台**：项目级 Chat、可编辑文件、session 绑定 Web 终端、运行日志、产物、TeX 源码、编译诊断和 PDF 预览共用同一上下文。
- **可追溯方法论**：Protocol revision、运行分类、综合请求、Assurance、Reviewer finding、Knowledge Pack 激活和 Claim-Evidence 关系会成为持久研究状态。
- **可查看协作拓扑**：Trajectory 与 Topology 展示 subagent 父子关系、状态、follow-up 和产出，并可进入节点查看。

## 使用边界

- DSH Scholar 辅助研究，不代替研究者承担科学判断、审批、署名和发布责任。
- `gate-only` 是常规模式。Agent 不能冒充 Human principal、伪造 accepted Evidence 或绕过研究 Gate。
- `full-auto` 只会为精确登记的 FixtureProfile 自动批准 allowlist 内的 Scope、Idea、Contract 和 Budget Gate；目前唯一的 canonical action executor 是 `survey_run`。Release、Direction、Intake、Evidence 和未登记动作仍由人处理，或以明确原因 park。
- 只有名称的 `/new <name>` 始终以 `gate-only` 创建，并通过 Grill Me 收集 Brief，不会静默继承 `full-auto`。
- 正式实验必须绑定不可变代码/数据快照、必要时的 frozen Protocol，以及显式 Runner Profile。Chat 文本、普通 stdout 和 Interactive Terminal 输出不会自动成为正式 Evidence。
- 发送给视觉模型的图片只是当前轮次中不可信的 Chat 上下文，不会自动成为 OCR 结果、Brief 答案、Evidence、Claim、Gate 决策，也不能证明命令已经运行。
- 产品聚焦机器学习、数据科学、生物信息学等纯计算研究，不适用于临床决策、人体试验、湿实验或其他高风险研究。

## 快速开始

本地工作台需要 Linux、Node.js 24、pnpm 11.20.0；受控实验、TeX 编译和 clean-room 复现需要 Docker Engine。

### 1. 安装与构建

```bash
pnpm install --frozen-lockfile
pnpm run build
```

### 2. 启动独立工作台

```bash
bash scripts/start-standalone-ui.sh
```

打开 <http://127.0.0.1:18610>，粘贴以下文件中的访问令牌：

```text
~/.dsh-scholar-standalone/research-ui-standalone/standalone-token
```

独立工作台和 DSH 使用 `127.0.0.1:7412` 的同一个 Research Kernel，并共享 `~/.dsh/research-kernel` 这一权威项目数据目录。升级任一端时都必须保持该目录不变，已有项目才能继续访问。浏览器 Token 和显示偏好独立保存在 standalone BFF 目录中。`--no-token` 只用于 loopback、隔离且有人监督的开发实例。

### 3. 配置实验环境

打开 **设置 → 实验环境**，显式选择 Runner Profile：

- 本机：仅用于可信开发和冒烟测试；
- 本机 Docker：固定镜像，并可要求 NVIDIA runtime 与 GPU capability；
- 远程 SSH：使用服务端 endpoint、credential、known-hosts 和 target-identity SecretRef。

只有 profile 和 target 都通过 readiness 检查后，正式 Job 才能执行。缺少 Runner、target 离线、SecretRef 不可用、能力不匹配，或 Contract/Protocol 尚未补齐时，界面会显示准备项或阻断原因，而不会假装 ready。target 注册、独立 heartbeat 凭据、Runner 启动、端口和安全约束见[运行规范](docs/test-instance-plan.md)。

### 4. 将插件安装到 DSH

通过会移动的 `next` tag 安装当前 DSH 预发布版，并记录实际解析出的精确版本：

```bash
npm install -g @deepseek-ai/dsh@next
npm ls -g @deepseek-ai/dsh --depth=0
```

当前 `@dsh-scholar/*` 包尚未发布。构建本仓库后，把其绝对路径加入 DSH 的 `web` profile：

```bash
cd /absolute/path/to/dsh-scholar
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile web add /absolute/path/to/dsh-scholar
dsh plugin --profile web why @dsh-scholar/research-plugin
dsh web
```

更新 Scholar 时，在同一 checkout 重新构建，并再次添加同一绝对路径。卸载命令：

```bash
dsh plugin --profile web remove @dsh-scholar/research-plugin
```

插件会增加 Scholar tools、slash commands、Skills、设置项和紧凑的 `dsh Scholar` 页签。未绑定的 DSH 对话可以选择已有项目，或只填写名称创建项目；绑定后只显示当前阶段、下一步与执行摘要。完整工作台通过 **在新页面打开** 或配置的快捷键进入。

## 插件配置

在 DSH 中打开 **设置 → 插件配置 → dsh Scholar**。保存后的插件设置在下一次重启 DSH 时生效。

| 配置项 | 默认值 | 含义 |
|---|---|---|
| 默认治理模式 | `gate-only` | 只在完整配置且明确满足条件的项目上生效；name-only 创建仍为 `gate-only`。 |
| 无人值守运行 | 关闭 | 不绕过 Human Gate；需要交互时将项目 park。 |
| Standalone 地址 | `http://127.0.0.1:18610/` | “在新页面打开”和快捷键的目标；只允许 HTTPS 或 loopback HTTP。 |
| 新页面快捷键 | `Alt+Shift+S` | 可以禁用；正在输入或使用输入法时不会触发。 |

有效 fixture 启用 `full-auto` 后，Settings 还会显示 worker 状态、是否需要重启、fixture-only 边界和最近一次 park 原因；Release 始终由人决定。Standalone 地址不能包含凭据、query 或 fragment。“复制 standalone 访问令牌”只在 loopback DSH 中、经用户显式点击后可用；页面不会显示令牌，也不会暴露 Kernel、Runner、Provider 或 SSH secret。

### 在 Chat 中使用视觉模型

Scholar 从 DSH 读取实时模型目录，不会根据模型名称猜测视觉能力。请在 DSH profile 中把实际可接收图片的 DeepSeek 兼容端点显式登记为视觉模型：

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    models:
      - id: your-vision-model
        name: Your Vision Model
        inputModalities: [text, image]
```

重启 DSH 后，在 Scholar 中选择带 `👁` 标记的模型，上传、拖放或粘贴 PNG、JPEG、WebP 或 GIF，再发送普通自然语言消息。同一文件可以进入项目 Intake，但视觉字节只由这次成功的自由对话消费。文本模型或未声明视觉能力的模型会在请求 Provider 之前被拒绝，Scholar 不会静默降级成纯文本回答。

## 开始或继续研究

有三种入口：

1. **新建研究**：只提供项目名，再在 Chat 中回答 Grill Me 问题以补全 Brief。
2. **打开已有项目**：继续持久化的阶段、项目对话、文件、任务、运行和方法论记录。
3. **上传 / 接入**：把论文、代码、数据、图片或日志接入已有阶段。上传内容先进入隔离 Intake，不会自动成为 Evidence。

常规流程：

```text
创建或接入 → Grill Me → Scope → 调研 → Ideas → Baseline → Contract
→ 受控运行 → 分类与综合 → Evidence 与 Claims
→ TeX 写作与评审 → 私有打包 → Human Release Gate
```

Chat 同时接受普通自然语言和一级 slash command。显式命令是确定性的高级入口；自然语言会结合项目当前的权威 `NextAction` 解释和执行。例如：

```text
/new  /status  /survey  /ideas  /ideas generate 3  /ideas select <idea_id>
/gates  /contract  /run  /evidence  /claims  /write  /review
/release-bundle  /release
```

`/run` 只在快照、Protocol、Runner、target 和预算全部 exact-ready 时执行。`/release` 只会创建或打开 Human Release 决策，不允许 Agent 自动发布。

## 实际复现实例：MNIST 手写数字识别

2026-08-20，仓库中的隔离复现脚本在真实本机 Docker 中执行了三个基线 Job 和三个实验方案 Job。六个 Job 均在第一次尝试中成功，六条 Run 记录均已签名。该 fixture 使用固定的 6,000 训练/1,000 测试 MNIST 子集、五轮 CPU 训练，以及预先登记的随机种子 11、23、47。

| 结果 | 数值 |
|---|---:|
| 单卷积基线 | 平均测试准确率 92.4% |
| 双卷积实验方案 | 平均测试准确率 96.8% |
| 配对效应 | +4.4 个百分点 |
| 95% 区间 | [1.2, 8.6]，n=3 |

![MNIST 项目中文总览](docs/assets/cnn-mnist-actual-overview-zh.png)

![MNIST 六个成功运行的中文界面](docs/assets/cnn-mnist-actual-runs-zh.png)

![MNIST 已接受证据的中文界面](docs/assets/cnn-mnist-actual-evidence-zh.png)

以上截图来自同一个项目和 revision。精确代码/数据/镜像/Protocol pin、逐 seed 结果、已签名 Job/Run ID 和重新运行命令见[复现凭据](docs/mnist-reproduction.md)。这是确定性产品 fixture，不是完整 MNIST benchmark 或 SOTA 声明。

## 工作台区域

| 区域 | 用途 |
|---|---|
| Chat | 自由对话、Grill 问题、上传、视觉模型输入、命令补全和按阶段引导。 |
| Workspace | 浏览、搜索、编辑、上传和管理项目文件，通过 version/etag 防止冲突覆盖。 |
| Run / Terminal | 查看正式 Job 状态和只读日志，或操作项目/session 绑定的 Web PTY。 |
| Evidence / Artifacts | 预览和下载产物，评审指标、来源、置信度和 Claim 关系。 |
| Manuscript | 编辑 TeX、查看编译诊断并预览最近一次成功 generation 的 PDF。 |
| Trajectory / Topology | 查看研究轨迹，并进入 subagent 节点检查其工作与 follow-up。 |
| Settings | 配置模型与 OCR provider、MinerU、预算、Runner Profile、target、Docker 镜像、GPU 要求和 SSH SecretRef。 |

## 验收边界

仓库自动验收覆盖构建、Schema、Kernel/Client 行为、治理和安全回归、持久化与重启、DSH 插件契约、受控适配器下的视觉请求准入，以及本机 Docker fixture。真实浏览器/ARIA 观感、干净 DSH Host 冷启动、生产视觉模型与 reviewer provider、远程 SSH/GPU、生产 mTLS 终止和具体环境的 TeX 渲染仍需部署方人工验收。使用这些路径前，请查看[当前实现状态](docs/hardening-v0.2-status.md)和[人工验收清单](docs/manual-acceptance.md)。

## 文档

- [使用指南](docs/USAGE_GUIDE.md)
- [运行与部署规范](docs/test-instance-plan.md)
- [DSH 宿主集成](docs/dsh-integration.md)
- [安全与科研完整性基线](docs/security-baseline.md)
- [验收规范](docs/acceptance-tests.md)

## License

本项目采用 [MIT License](LICENSE)。

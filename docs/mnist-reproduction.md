# MNIST reproduction receipt / MNIST 复现凭据

Status: reproduced on 2026-08-20 with the implementation recorded by the commit containing this document.

状态：已于 2026-08-20 使用包含本文档的实现完成实际复现。

## Research question / 研究问题

On a fixed MNIST subset, does a two-convolution network with per-channel normalization improve test accuracy over a single-convolution baseline when data, epochs, seeds, image, and execution target are held constant?

在固定 MNIST 子集上，当数据、训练轮次、随机种子、镜像和执行目标保持一致时，带逐通道归一化的双卷积网络是否比单卷积基线获得更高的测试准确率？

## Immutable inputs / 不可变输入

| Input | Pinned value |
|---|---|
| Dataset | deterministic MNIST subset, 6,000 train / 1,000 test |
| Dataset artifact | `sha256:f8a1188e445be6a86fd8342c029d62a9e256fcb7b0158739b9da84b4a2b607e5` |
| Code snapshot | `code_snap_c2ra75rurco5ibg6wmn2aioqfu` |
| Code archive | `sha256:caf9e32c5ed29cd75c6b14f1bbe58f93d565877cf9c09e0f91a726871e51dbc8` |
| Contract | `expc_d356atbgmhgjdbxwfre56ndmym` |
| Protocol | `protocol_mnist_readme_v1`, revision 1 |
| Protocol hash | `sha256:9f9d2ac49e7e1f335f815609b16b2124d7b9ba0bd7139364c3125cd7eac80467` |
| Runner | `profile_local_docker_cpu_v1` / `target_local_docker_v1` |
| Image | `node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32` |
| Seeds | 11, 23, 47 |

The baseline and treatment each ran for five epochs in real local Docker CPU Jobs. No augmentation or hyperparameter sweep was used.

基线和实验方案都在真实本机 Docker CPU Job 中训练五轮，没有使用数据增强或超参数搜索。

## Results / 结果

| Seed | Single-convolution baseline | Two-convolution treatment | Paired difference |
|---:|---:|---:|---:|
| 11 | 93.6% | 97.0% | +3.4 pp |
| 23 | 88.3% | 96.9% | +8.6 pp |
| 47 | 95.3% | 96.5% | +1.2 pp |
| Mean | 92.4% | 96.8% | +4.4 pp |

The paired effect is **+4.4 percentage points**, with a percentile 95% interval of **[1.2, 8.6]** and `n=3` paired seeds. All six Jobs succeeded on their first attempt and all six Run records have `signature_status=signed`.

配对效应为 **+4.4 个百分点**，percentile 95% 区间为 **[1.2, 8.6]**，配对随机种子数 `n=3`。六个 Job 均在第一次尝试中成功，六条 Run 记录均为 `signature_status=signed`。

## Evidence / 证据

| Record | Identifier |
|---|---|
| Project captured in the screenshots | `rsp_2z5wxgl42uevqcc5u5thv6hp44`, revision 10 |
| Accepted Evidence | `evidence_x4toe6rmjkg4ejbs4elpxeeijm` |
| Supported Claim | `claim_5idptldqxtibkwauinxtreh2wu` |
| Analysis Artifact | `sha256:8d1b457d5ffde46d2d80c6094f9c258f13665cc6cafd3e02697612232f67f563` |
| Chart Artifact | `sha256:47f0b85039309c836f8675bdd2803f152026299dba1b7f3c7d2896ead531013f` |

The six exact Job/Run pairs and their signed status are stored in [`evals/mnist-readme/receipt.json`](../evals/mnist-readme/receipt.json). The English and Chinese screenshots in the READMEs show this same project and revision; only the UI locale changes.

六组精确的 Job/Run 对及其签名状态保存在 [`evals/mnist-readme/receipt.json`](../evals/mnist-readme/receipt.json)。两份 README 的中英文截图来自同一个项目和 revision，只切换了界面语言。

## Reproduce / 重新运行

The repository does not vendor the 7.4 MB dataset fixture. Point the harness at a directory containing the pinned `baseline_cnn.js`, `train_cnn.js`, and `mnist_subset.json`; the harness rejects any dataset whose SHA256 differs from the value above.

仓库不内置约 7.4 MB 的数据 fixture。把脚本指向包含固定 `baseline_cnn.js`、`train_cnn.js` 和 `mnist_subset.json` 的目录；如果数据 SHA256 与上文不一致，脚本会直接拒绝运行。

```bash
pnpm run build
MNIST_FIXTURE_DIR=/absolute/path/to/mnist-fixture \
  bash evals/mnist-readme/run-mnist.sh
```

The harness creates an isolated Kernel, executes the six Docker Jobs, records signed Run manifests, performs paired analysis, accepts Evidence, verifies a Claim, and preserves its isolated state for UI inspection. It does not modify the user's canonical `~/.dsh/research-kernel` data.

脚本会创建隔离 Kernel，执行六个 Docker Job，记录签名 Run manifest，完成配对分析、Evidence 接受与 Claim 验证，并保留隔离状态供 UI 检查；它不会修改用户的权威 `~/.dsh/research-kernel` 数据。

## Boundary / 使用边界

This is a deterministic product reproduction on a 6,000/1,000 subset and three seeds. It validates DSH Scholar's governed execution and evidence path; it is not a full-MNIST benchmark, a state-of-the-art result, or evidence that the architecture generalizes beyond this fixture.

这是在 6,000/1,000 子集和三个随机种子上的确定性产品复现，用于验证 DSH Scholar 的受治理执行与证据链；它不是完整 MNIST benchmark、SOTA 结果，也不能证明该架构能推广到本 fixture 之外。

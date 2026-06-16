# agentic-rl-verl-project

把本地的 veRL agentic-RL 训练任务（`tmp-devs/260602-rl-agentic-on-aws`）跑到 HyperPod InstantStart 上，
**通过 UI 的 Verl Recipe 通道提交**（`VerlRecipePanel` → `/launch-verl-training` → `templates/verl-training-template.yaml`，KubeRay `RayJob`）。

```
agentic-rl-verl-project/
├── Dockerfile          # 框架镜像：AWS DLC torch2.10/cu130 + vLLM0.19.1 + Ray2.51 + flash-attn + veRL main + 项目 deps
├── build-and-push.sh   # build 并推到私有 ECR，输出镜像 URI
├── entry-gsm8k.sh      # 容器入口脚本（GSM8K 全异步任务，env 可调）；放到 S3 或 FSx 挂载点
├── entry-*-k8s.sh      # SWE / DevOps / Terminal：通过集群内 sandbox service 跑
├── sync-to-fsx.sh      # 同步原项目 + 本 recipe overlay 到本地 FSx mount
├── deploy-sandbox-manager.sh
├── sandbox/server.py   # ClusterIP sandbox manager：创建/exec/delete sandbox Pod
├── k8s/                # sandbox manager RBAC / Deployment / Service
├── training/           # 训练 task 索引、RayJob 直提模板和 renderer
├── overlay/            # 覆盖到原项目的 veRL K8s sandbox tool configs
├── patches/            # veRL BaseTool 持久生命周期 patch
└── README.md
```

镜像只装**框架**；项目自身的 Python 代码（`tooluse/`、`shared/` 等）走挂载盘 + `PYTHONPATH`，
改代码不用重 build 镜像。

## 挂载选择（本次为 verl recipe 新增的能力）

Verl Recipe 面板新增了 **Storage Mounts** 勾选项：**S3 默认勾选，FSx 可选**。
勾了哪个，渲染出的 RayJob YAML 的 head/worker 就带上对应的 `volume` + `volumeMount`：

| 勾选 | 挂载点 | PVC |
|------|--------|-----|
| S3（默认） | `/s3` | `s3-claim` |
| FSx（可选） | `/fsx` | `fsx-claim` |

涉及的现有文件改动（都在 verl 发布 gate 内）：
- `client/src/components/VerlRecipePanel.js` — 新增 Storage Mounts 复选框（默认 `['s3']`）
- `server/trainingJobManager.js` — `/launch-verl-training` 读取 `mounts` 并注入挂载 patch
- `server/utils/trainingPatches.js` — 新增通用 `storageMountPatches()` 助手
- `templates/verl-training-template.yaml` — 去掉硬编码的 S3 挂载，改由勾选注入（hostPath 挂载保留）

---

## 1. Build 镜像

```bash
cd train-recipes/agentic-rl-verl-project
bash build-and-push.sh          # 输出形如:
# <account>.dkr.ecr.<region>.amazonaws.com/hypd-agentic-verl:latest
```

> 版本沿用本地项目 README 的 fully-async 实测包版本（torch 2.10.0 / vLLM 0.19.1 / Ray 2.51.1 /
> flash-attn 2.8.3 / veRL main）。本地项目原栈是 Python 3.12 + CUDA 12.8；这里改用 AWS DLC
> `pytorch-training:2.10.0-gpu-py313-cu130-ubuntu22.04-ec2-v1.7`，避免在旧 DLC 上二次 pip 安装 torch。
> 镜像 build 未在此环境验证，首次 build 若有 `vllm` / `flash-attn` ABI 冲突按 log 微调。
> fully-async recipe **必须用 vLLM**（项目 README 明确 SGLang 不支持该 recipe）。

---

## 2. 把代码 / 模型 / 数据放上挂载盘

按你在 UI 里勾选的挂载来放。**勾 FSx**（推荐，读写友好）时：

```bash
cd train-recipes/agentic-rl-verl-project
bash sync-to-fsx.sh
# 模型：用 UI 的「HuggingFace 下载到 FSx」下到 /fsx/models/Qwen3-0.6B
```

本地路径默认是 `/home/ubuntu/workspace/fsx/rl-agentic-on-aws`，容器里对应 `/fsx/rl-agentic-on-aws`。
`sync-to-fsx.sh` 会复制原项目，并把本 recipe 的 `overlay/` 覆盖进去：

- `tooluse/envs/k8s_sandbox_tool.py`
- `tooluse/configs/*_k8s_tool_config.yaml`
- `aws/entry-*.sh`
- `aws/sandbox/`、`aws/k8s/`、`aws/patches/`、`aws/training/`

数据无需手动准备：`entry-gsm8k.sh` 首次运行检测到 `/fsx/data/gsm8k/train.parquet` 不存在时，
会自动跑 `prep_gsm8k_toolcall.sh` 生成到 `/fsx/data/gsm8k/`。

> 若只勾 S3：把上述路径换成 `/s3/...`（注意 mountpoint-s3 写入语义有限，checkpoint 落在容器内
> 本地 NVMe `/ckpt-path`），并相应改 `entry-gsm8k.sh` 顶部的默认路径或用同名 env。

---

## 3. 可选：启动 / 记录 sandbox service

SWE / DevOps / Terminal 不再在 Ray 训练 Pod 里跑 Docker。推荐直接使用现有 UI：

1. Inference -> Model Deployment
2. 填 sandbox 镜像 / repo id
3. Service Type 选 `ClusterIP`
4. 部署后复制服务 URL
5. 写入 `/fsx/rl-agentic-on-aws/aws/training/configs/*-k8s.yaml` 的 `tool.sandboxApiUrl`

不需要在 Verl Recipe 里额外传 ENV；入口脚本会读 task YAML，并生成 veRL 实际使用的 tool config。

本目录也保留一个 direct Kubernetes manager manifest，方便不用 UI 时测试：

```bash
cd train-recipes/agentic-rl-verl-project
bash deploy-sandbox-manager.sh <第 1 步输出的 ECR 镜像 URI>
```

它会创建：

| 资源 | 用途 |
|------|------|
| `Deployment/agentic-rl-sandbox-manager` | 提供 HTTP API |
| `Service/agentic-rl-sandbox` | ClusterIP，训练 Pod 通过 `SANDBOX_API_URL` 调用 |
| `Role/RoleBinding` | 只允许在当前 namespace 管理 sandbox Pod 和 pod/exec |

如果使用这个 manager，训练时每个 veRL tool instance 对应一个 sandbox Pod；多轮 tool call 会复用同一个 Pod，rollout 结束后删除。
入口脚本会自动 patch veRL 的 `ToolAgentLoop`，把 BaseTool 生命周期从“每次调用创建/释放”改成“每个 rollout 创建一次、结束释放”。

---

## 4. 在 UI 里运行（Verl Recipe 面板）

Training → **Verl Recipe** 标签，按下表填，然后点 **Launch Ray Training**：

| 字段 | 值 |
|------|-----|
| Job Name | `agentic-verl-gsm8k-a1` |
| Instance Type | GPU 机型（建议 ≥8 卡，如 `ml.g5.48xlarge` / `ml.p5.48xlarge`） |
| Docker Image | 第 1 步输出的 ECR URI |
| Entry Point Script Path | `/fsx/rl-agentic-on-aws/aws/entry-gsm8k.sh` |
| **Storage Mounts** | 勾上 **FSx**（S3 默认已勾，可按需取消） |
| Num Nodes for Worker | `0`（head 单节点；多节点见下） |
| GPUs per Node | `8` |
| EFAs per Node | 按机型 |

模板会自动注入 `INSTRT_NUM_NODES`（总节点数）和 `INSTRT_PROC_PER_NODE`（=GPUs per Node），
`entry-gsm8k.sh` 会读取它们。Verl 面板没有 Env Vars 输入框，其它调参（`MODEL_PATH`/`TRAIN_GPUS`/
`ROLLOUT_GPUS`/`BS`/`QUICK` 等）改 `/fsx/rl-agentic-on-aws/aws/training/configs/*.yaml` 即可。fully-async 默认 8 卡拆
4(训练 FSDP2) + 4(vLLM rollout)。

Sandbox 任务把 Entry Point 换成：

| 任务 | Entry Point Script Path | 额外准备 |
|------|--------------------------|----------|
| SWE | `/fsx/rl-agentic-on-aws/aws/entry-swe-k8s.sh` | 需要 `/fsx/data/swe/*_skyrl.parquet` 或已转换好的 `*_verl.parquet` |
| DevOps | `/fsx/rl-agentic-on-aws/aws/entry-devops-k8s.sh` | 需要 `/fsx/rl-agentic-on-aws/data/devops_gym/*.parquet` 或已转换好的 `/fsx/data/devops_gym_verl/*.parquet` |
| Terminal | `/fsx/rl-agentic-on-aws/aws/entry-terminal-k8s.sh` | 先用原项目 pipeline 准备 `/fsx/data/terminal_verl/*.parquet` |

训练配置索引在 `training/tasks.yaml`，同步到 FSx 后也在 `/fsx/rl-agentic-on-aws/aws/training/tasks.yaml`。
每个任务的可编辑运行配置在 `/fsx/rl-agentic-on-aws/aws/training/configs/*.yaml`，sandbox ClusterIP URL
应写到 `tool.sandboxApiUrl`。
如果不用 UI，可以用 `training/rayjob-agentic-verl-template.yaml` 和 `training/render-rayjob.sh` 生成可直接
`kubectl apply` 的 RayJob YAML。

---

## 换其它任务 / 多节点

- **换任务**：复制 `entry-gsm8k.sh` 改 `tool_config`、prompt/response 长度，必要时加
  `reward.custom_reward_function.path=...`（参数来源：本地 `scripts/train/train_*.sh`，
  入口脚本复用了它们的 `_common.sh::verl_fully_async_args`）。
- **多节点**：Worker 节点数填 >0，`INSTRT_NUM_NODES` 由模板按 1+worker 自动算好，按需调 `TRAIN_GPUS/ROLLOUT_GPUS`。

## ⚠️ 哪些任务能直接这样跑

| 任务 | 能否用本通道 | 说明 |
|------|:---:|------|
| GSM8K / BFCL / HotpotQA | ✅ | 工具在训练进程内执行（in-process），开箱即用 |
| DeepResearch | ⚠️ | 需要 SearXNG 服务，先在集群内起一个并设 `SEARXNG_URL` |
| SWE / DevOps / Terminal | ✅/⚠️ | 通过 `agentic-rl-sandbox` 服务在 EKS 里创建 sandbox Pod；数据集和 sandbox 镜像仍需提前准备 |

# Agentic veRL Training Files

This directory keeps the launch-facing training files separate from data prep.

| File | Purpose |
|------|---------|
| `tasks.yaml` | Task index: UI entrypoint, data paths, tool config, sandbox requirement. |
| `configs/*.yaml` | Per-task launch config consumed by `entry-*.sh`; this is where sandbox service URLs live. |
| `prepare_task_config.py` | Converts a task YAML into shell exports and a resolved veRL tool config. |
| `rayjob-agentic-verl-template.yaml` | Standalone KubeRay RayJob template for direct `kubectl apply`. |
| `render-rayjob.sh` | Small renderer for the standalone template. |

Normal HyperPod InstantStart flow:

1. Use Inference -> Model Deployment to deploy the sandbox image as `ClusterIP`.
2. Copy the service URL, for example `http://<service-name>.default.svc.cluster.local:<port>`.
3. Put that URL into the task YAML:
   `configs/swe-k8s.yaml -> tool.sandboxApiUrl`.
4. Use `tasks.yaml` to pick the task.
5. Paste `entryPointPath` into Training -> Verl Recipe.
   You can either use the default config:
   `/fsx/rl-agentic-on-aws/aws/entry-swe-k8s.sh`
   or pass an explicit config path:
   `/fsx/rl-agentic-on-aws/aws/entry-swe-k8s.sh /fsx/rl-agentic-on-aws/aws/training/configs/swe-k8s.yaml`
6. Select FSx mount and launch from UI. The UI renders `ui-panel/templates/verl-training-template.yaml`.

No additional Env Vars are required for the common path. The entry script reads
the task YAML and writes a temporary veRL tool config with `config.api_url`
populated from `tool.sandboxApiUrl`.

Alignment with the UI path:

| Direct YAML field | Verl Recipe form / backend value |
|-------------------|----------------------------------|
| `__JOB_NAME__` | `jobName` |
| `__DOCKER_IMAGE__` | `dockerImage` |
| `__ENTRYPOINT__` | `entryPointPath` |
| `__INSTANCE_TYPE__` | `instanceType` |
| `__WORKER_REPLICAS__` | `workerReplicas` |
| `__GPU_PER_NODE__` | `gpuPerNode` |
| `__EFA_PER_NODE__` | `efaPerNode` |
| `__TOTAL_NODES__` | `1 + workerReplicas` |
| FSx PVC mount | Select `FSx` in Storage Mounts |

The direct template intentionally mirrors `ui-panel/templates/verl-training-template.yaml`
with the same FSx PVC patch that the UI backend injects when `mounts: ['fsx']`
is selected.

Direct kubectl flow:

```bash
IMAGE_URI=<account>.dkr.ecr.<region>.amazonaws.com/hypd-agentic-verl:latest \
  bash train-recipes/agentic-rl-verl-project/training/render-rayjob.sh gsm8k \
  > /tmp/agentic-verl-gsm8k-rayjob.yaml

kubectl apply -f /tmp/agentic-verl-gsm8k-rayjob.yaml
```

Sandbox tasks require a ClusterIP sandbox service first. You can deploy it from
Inference -> Model Deployment. The repository also includes a direct Kubernetes
manager manifest for testing:

```bash
bash train-recipes/agentic-rl-verl-project/deploy-sandbox-manager.sh "$IMAGE_URI"
```

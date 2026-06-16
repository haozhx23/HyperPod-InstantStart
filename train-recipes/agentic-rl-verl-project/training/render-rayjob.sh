#!/bin/bash
# Render the standalone RayJob template for a known task.
set -euo pipefail

TASK="${1:-gsm8k}"
IMAGE_URI="${IMAGE_URI:-}"
INSTANCE_TYPE="${INSTANCE_TYPE:-ml.g5.48xlarge}"
WORKER_REPLICAS="${WORKER_REPLICAS:-0}"
GPU_PER_NODE="${GPU_PER_NODE:-8}"
EFA_PER_NODE="${EFA_PER_NODE:-1}"
DEFAULT_MAX_REPLICAS=$((WORKER_REPLICAS + 2))
if [ "$DEFAULT_MAX_REPLICAS" -lt 3 ]; then
  DEFAULT_MAX_REPLICAS=3
fi
MAX_REPLICAS="${MAX_REPLICAS:-$DEFAULT_MAX_REPLICAS}"
TOTAL_NODES="${TOTAL_NODES:-$((WORKER_REPLICAS + 1))}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$TASK" in
  gsm8k)
    JOB_NAME="${JOB_NAME:-agentic-verl-gsm8k-a1}"
    ENTRYPOINT="${ENTRYPOINT:-/fsx/rl-agentic-on-aws/aws/entry-gsm8k.sh}"
    ;;
  swe-k8s)
    JOB_NAME="${JOB_NAME:-agentic-verl-swe-k8s-a1}"
    ENTRYPOINT="${ENTRYPOINT:-/fsx/rl-agentic-on-aws/aws/entry-swe-k8s.sh}"
    ;;
  devops-k8s)
    JOB_NAME="${JOB_NAME:-agentic-verl-devops-k8s-a1}"
    ENTRYPOINT="${ENTRYPOINT:-/fsx/rl-agentic-on-aws/aws/entry-devops-k8s.sh}"
    ;;
  terminal-k8s)
    JOB_NAME="${JOB_NAME:-agentic-verl-terminal-k8s-a1}"
    ENTRYPOINT="${ENTRYPOINT:-/fsx/rl-agentic-on-aws/aws/entry-terminal-k8s.sh}"
    ;;
  *)
    echo "Unknown task: $TASK" >&2
    echo "Valid tasks: gsm8k, swe-k8s, devops-k8s, terminal-k8s" >&2
    exit 1
    ;;
esac

if [ -z "$IMAGE_URI" ]; then
  echo "IMAGE_URI is required" >&2
  echo "Example: IMAGE_URI=123.dkr.ecr.us-west-2.amazonaws.com/hypd-agentic-verl:latest $0 gsm8k > rayjob.yaml" >&2
  exit 1
fi

sed \
  -e "s#__JOB_NAME__#${JOB_NAME}#g" \
  -e "s#__DOCKER_IMAGE__#${IMAGE_URI}#g" \
  -e "s#__ENTRYPOINT__#${ENTRYPOINT}#g" \
  -e "s#__INSTANCE_TYPE__#${INSTANCE_TYPE}#g" \
  -e "s#__WORKER_REPLICAS__#${WORKER_REPLICAS}#g" \
  -e "s#__MAX_REPLICAS__#${MAX_REPLICAS}#g" \
  -e "s#__GPU_PER_NODE__#${GPU_PER_NODE}#g" \
  -e "s#__EFA_PER_NODE__#${EFA_PER_NODE}#g" \
  -e "s#__TOTAL_NODES__#${TOTAL_NODES}#g" \
  "$SCRIPT_DIR/rayjob-agentic-verl-template.yaml"

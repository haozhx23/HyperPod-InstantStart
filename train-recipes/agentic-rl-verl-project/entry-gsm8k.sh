#!/bin/bash
# Container entry for the GSM8K fully-async veRL task. Lives on FSx; pointed to by the
# RayJob panel's "Entry Script Path" (e.g. /fsx/rl-agentic-on-aws/aws/entry-gsm8k.sh).
# All knobs are overridable via the RayJob panel's Env Vars.
set -euo pipefail

PROJ_DIR="${PROJ_DIR:-/fsx/rl-agentic-on-aws}"   # project code on FSx
VERL_ROOT="${VERL_ROOT:-/workspace/verl}"        # veRL baked into the image
export PYTHONPATH="$PROJ_DIR:$VERL_ROOT:${PYTHONPATH:-}"
export VLLM_USE_V1=1

TASK_CONFIG="${1:-${TASK_CONFIG:-$PROJ_DIR/aws/training/configs/gsm8k.yaml}}"
if [ -f "$TASK_CONFIG" ]; then
    source <(python3 "$PROJ_DIR/aws/training/prepare_task_config.py" "$TASK_CONFIG")
fi

# ── Tunables (override in the RayJob "Env Vars" panel) ──
BS="${BS:-8}"; ROLLOUT_N="${ROLLOUT_N:-4}"; EPOCHS="${EPOCHS:-1}"; QUICK="${QUICK:-false}"
MODEL_PATH="${MODEL_PATH:-/fsx/models/Qwen3-0.6B}"
TRAIN_DATA="${TRAIN_DATA:-/fsx/data/gsm8k/train.parquet}"
VAL_DATA="${VAL_DATA:-/fsx/data/gsm8k/test.parquet}"
NNODES="${INSTRT_NUM_NODES:-1}"                  # set by the RayJob template
export TRAIN_GPUS="${TRAIN_GPUS:-4}" ROLLOUT_GPUS="${ROLLOUT_GPUS:-4}"
RUN="gsm8k-$(date +%Y%m%d_%H%M%S)"
PROJECT_NAME="${PROJECT_NAME:-agentic-rl-tooluse}"
PROMPT_LEN="${PROMPT_LEN:-1024}"
RESPONSE_LEN="${RESPONSE_LEN:-1024}"
TOOL_CONFIG="${TOOL_CONFIG:-$VERL_ROOT/examples/sglang_multiturn/config/tool_config/gsm8k_tool_config.yaml}"

# Prepare data once if missing (writes to /fsx/data/gsm8k).
if [ ! -f "$TRAIN_DATA" ]; then
    echo "Preparing GSM8K data -> $(dirname "$TRAIN_DATA")"
    HOME=/fsx bash "$PROJ_DIR/shared/data_prep/prep_gsm8k_toolcall.sh"
fi

# Reuse the project's argument builder (defines verl_fully_async_args). We deliberately do
# NOT call its venv/CUDA helpers — deps already live in the image's system Python.
source "$PROJ_DIR/scripts/train/_common.sh"

cd "$VERL_ROOT"
eval python3 -m verl.experimental.fully_async_policy.fully_async_main \
    $(verl_fully_async_args \
        "$TOOL_CONFIG" \
        "$PROJECT_NAME" "$PROMPT_LEN" "$RESPONSE_LEN") \
    ${EXTRA_VERL_ARGS:-}

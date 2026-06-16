#!/bin/bash
# DevOps-Gym fully-async veRL task using EKS-backed sandbox pods.
set -euo pipefail

PROJ_DIR="${PROJ_DIR:-/fsx/rl-agentic-on-aws}"
VERL_ROOT="${VERL_ROOT:-/workspace/verl}"
export PYTHONPATH="$PROJ_DIR:$VERL_ROOT:${PYTHONPATH:-}"
export VLLM_USE_V1=1

TASK_CONFIG="${1:-${TASK_CONFIG:-$PROJ_DIR/aws/training/configs/devops-k8s.yaml}}"
if [ -f "$TASK_CONFIG" ]; then
    source <(python3 "$PROJ_DIR/aws/training/prepare_task_config.py" "$TASK_CONFIG")
fi

BS="${BS:-8}"; ROLLOUT_N="${ROLLOUT_N:-4}"; EPOCHS="${EPOCHS:-1}"; QUICK="${QUICK:-false}"
MODEL_PATH="${MODEL_PATH:-/fsx/models/Qwen3-0.6B}"
TRAIN_DATA="${TRAIN_DATA:-/fsx/data/devops_gym_verl/train.parquet}"
VAL_DATA="${VAL_DATA:-/fsx/data/devops_gym_verl/validation.parquet}"
NNODES="${INSTRT_NUM_NODES:-1}"
export TRAIN_GPUS="${TRAIN_GPUS:-4}" ROLLOUT_GPUS="${ROLLOUT_GPUS:-4}"
RUN="devops-k8s-$(date +%Y%m%d_%H%M%S)"
PROJECT_NAME="${PROJECT_NAME:-agentic-rl-devops-k8s}"
PROMPT_LEN="${PROMPT_LEN:-4096}"
RESPONSE_LEN="${RESPONSE_LEN:-32768}"
MAX_ASSISTANT_TURNS="${MAX_ASSISTANT_TURNS:-25}"
MAX_TOOL_RESPONSE_LENGTH="${MAX_TOOL_RESPONSE_LENGTH:-8000}"
TOOL_CONFIG="${TOOL_CONFIG:-$PROJ_DIR/tooluse/configs/devops_k8s_tool_config.yaml}"
REWARD_FUNCTION_PATH="${REWARD_FUNCTION_PATH:-$PROJ_DIR/tooluse/rewards/devops_reward.py}"
REWARD_FUNCTION_NAME="${REWARD_FUNCTION_NAME:-compute_score}"

python3 "$PROJ_DIR/aws/patches/patch_verl_persistent_tools.py" "$VERL_ROOT"

if [ ! -f "$TRAIN_DATA" ]; then
    echo "Preparing DevOps veRL data -> $(dirname "$TRAIN_DATA")"
    python3 "$PROJ_DIR/shared/data_prep/prep_devops_verl.py" \
        --input-dir "$PROJ_DIR/data/devops_gym" \
        --output-dir "$(dirname "$TRAIN_DATA")"
fi

source "$PROJ_DIR/scripts/train/_common.sh"
cd "$VERL_ROOT"
eval python3 -m verl.experimental.fully_async_policy.fully_async_main \
    $(verl_fully_async_args \
        "$TOOL_CONFIG" \
        "$PROJECT_NAME" "$PROMPT_LEN" "$RESPONSE_LEN") \
    actor_rollout_ref.rollout.multi_turn.max_assistant_turns="$MAX_ASSISTANT_TURNS" \
    actor_rollout_ref.rollout.multi_turn.max_tool_response_length="$MAX_TOOL_RESPONSE_LENGTH" \
    actor_rollout_ref.actor.use_kl_loss=False \
    reward.custom_reward_function.path="$REWARD_FUNCTION_PATH" \
    reward.custom_reward_function.name="$REWARD_FUNCTION_NAME" \
    ${EXTRA_VERL_ARGS:-}

#!/bin/bash

# 训练失败时让 RayJob 也失败，而不是继续执行到最后一行 echo 并以 0 退出
set -ex

echo "=== Starting VeRL Training on KubeRay ==="
# pip install huggingface-hub==0.34.0

export PYTHONPATH=/verl_workspace:/verl_workspace/verl

VERL_DIR=/verl_workspace

cd $VERL_DIR
mkdir -p data
python3 verl/examples/data_preprocess/gsm8k.py --local_save_dir data/gsm8k

python3 -c "import ray; print(f'Ray initialized: {ray.is_initialized()}'); print(f'Ray nodes: {len(ray.nodes()) if ray.is_initialized() else 0}')"
# export VLLM_ATTENTION_BACKEND=XFORMERS

python3 -m verl.trainer.main_ppo \
    algorithm.adv_estimator=grpo \
    data.train_files=$VERL_DIR/data/gsm8k/train.parquet \
    data.val_files=$VERL_DIR/data/gsm8k/test.parquet \
    data.train_batch_size=128 \
    data.max_prompt_length=512 \
    data.max_response_length=1024 \
    data.filter_overlong_prompts=True \
    data.truncation='error' \
    actor_rollout_ref.model.path=/s3/Qwen-Qwen3-0.6B \
    actor_rollout_ref.actor.optim.lr=1e-6 \
    actor_rollout_ref.model.use_remove_padding=True \
    actor_rollout_ref.actor.ppo_mini_batch_size=64 \
    actor_rollout_ref.actor.ppo_micro_batch_size_per_gpu=2 \
    actor_rollout_ref.actor.use_kl_loss=True \
    actor_rollout_ref.actor.kl_loss_coef=0.001 \
    actor_rollout_ref.actor.kl_loss_type=low_var_kl \
    actor_rollout_ref.actor.entropy_coeff=0 \
    actor_rollout_ref.model.enable_gradient_checkpointing=True \
    actor_rollout_ref.actor.fsdp_config.param_offload=True \
    actor_rollout_ref.actor.fsdp_config.optimizer_offload=True \
    actor_rollout_ref.rollout.log_prob_micro_batch_size_per_gpu=2 \
    actor_rollout_ref.rollout.tensor_model_parallel_size=1 \
    actor_rollout_ref.rollout.name=vllm \
    actor_rollout_ref.rollout.gpu_memory_utilization=0.4 \
    actor_rollout_ref.rollout.n=5 \
    actor_rollout_ref.ref.log_prob_micro_batch_size_per_gpu=8 \
    actor_rollout_ref.ref.fsdp_config.param_offload=True \
    algorithm.use_kl_in_reward=False \
    trainer.critic_warmup=0 \
    trainer.logger=['console'] \
    trainer.project_name='verl_grpo_example_gsm8k' \
    trainer.experiment_name='qwen3_function_rm_kuberay' \
    trainer.n_gpus_per_node=${INSTRT_PROC_PER_NODE} \
    trainer.nnodes=${INSTRT_NUM_NODES} \
    trainer.save_freq=20 \
    trainer.test_freq=5 \
    trainer.total_epochs=15 $@

echo "=== Training completed ==="

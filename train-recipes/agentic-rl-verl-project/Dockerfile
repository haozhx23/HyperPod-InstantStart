# Agentic-RL (veRL Fully Async Policy) training image.
# Stack mirrors the local project's tested fully-async package versions where practical:
#   torch 2.10.0 + vLLM 0.19.1 + Ray 2.51.1 + flash-attn 2.8.3 + veRL main.
# Project CODE/DATA/MODELS live on FSx (mounted at /fsx) — only the framework is baked here.
# Base = AWS DLC PyTorch training image (EFA/NCCL ready, CUDA toolkit for flash-attn build).
# Note: the original local project used torch 2.10.0+cu128 on Python 3.12; the current
# AWS DLC 2.10 GPU line is Python 3.13 + CUDA 13.0.
FROM 763104351884.dkr.ecr.us-west-2.amazonaws.com/pytorch-training:2.10.0-gpu-py313-cu130-ubuntu22.04-ec2-v1.7

WORKDIR /workspace
RUN python -m pip install --upgrade pip

# 1) Inference + scheduler (fully-async REQUIRES vLLM; SGLang is not supported for this recipe).
RUN pip install vllm==0.19.1 ray==2.51.1

# 2) flash-attn MUST be built from source so it binds to the torch installed by the DLC.
RUN pip install flash-attn==2.8.3 --no-build-isolation --no-cache-dir --no-binary flash-attn

# 3) veRL main (provides verl.experimental.fully_async_policy used by every task).
RUN git clone https://github.com/volcengine/verl.git /workspace/verl && \
    pip install -e "/workspace/verl[all]"

# 4) Project runtime deps (tool envs, reward fns, data prep). Project code itself is on /fsx.
RUN pip install datasets==4.8.4 transformers==4.57.1 wandb cachetools requests sympy \
    huggingface-hub hf_transfer boto3 pandas pyarrow pyyaml fastapi uvicorn kubernetes pydantic

ENV VLLM_USE_V1=1 \
    PYTHONUNBUFFERED=1

# 与 Dockerfile.torch 中的 LLaMA-Factory 版本一致（v0.9.3 固定 numpy<2.0.0，无法在 Python 3.13 镜像上安装）
git clone --depth 1 -b v0.9.4 https://github.com/hiyouga/LlamaFactory.git LLaMA-Factory

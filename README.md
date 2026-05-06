# HyperPod-InstantStart

<p align="center">
    <a href="https://amzn-chn.feishu.cn/wiki/KKgVwwfiuiof9KkAP0CcYXfnnqd?from=from_copylink" target="_blank">
        <img src="https://img.shields.io/badge/Lark Guide-English-blue" alt="English Documentation">
    </a>
    <a href="https://amzn-chn.feishu.cn/docx/VZfAdXTJKor7TCxPrZdcbGYXnaf?from=from_copylink" target="_blank">
        <img src="https://img.shields.io/badge/飞书文档-中文-orange" alt="Chinese Documentation">
    </a>
</p>

HyperPod InstantStart is a training-and-inference integrated platform built on SageMaker HyperPod. It utilizes standard EKS orchestration and supports training and inference tasks with arbitrary GPU resource granularity. 

## Overview

HyperPod-InstantStart provides a unified interface for managing ML infrastructure, from cluster provisioning to training job orchestration and model serving.

- For training, it leverages HyperPod Training Operator (significantly simplifying distributed configuration with process-level recovery and log exception monitoring; optional), or KubeRay (as an orchestrator for the reinforcement learning framework VERL).
- For inference, it supports deployment on single or multi-node setups using arbitrary containers, such as standard vLLM/SGLang or self-buit containers, while also providing standardized API exposure (e.g., OpenAI-compatible API). 
- Additionally, it offers managed MLFlow Tracking Server for storing training metrics, enabling sharing and collaboration with fine-grained IAM permission controls.

## Architecture

![Architecture Diagram](./resources/arch-en.png)


## Demo Videos

### Create HyperPod Cluster
![hypd create](./resources/hypd-create.gif)

### Download Model from HuggingFace
![model download](./resources/model-download.gif)

### Model Deployment from S3
![deploy](./resources/deploy.gif)

### Distributed Verl Training with KubeRay
![verl](./resources/verl.gif)

### Agentic Orchestration and AI Workloads
![agentic](./resources/agentic.gif)

## Key Components

- **Cluster Management**: Supports EKS cluster creation, importing existing EKS clusters, cluster environment configuration, HyperPod cluster creation and scaling, EKS Node Group creation
- **Model Management**: Supports multiple S3 CSI configurations, as well as HuggingFace model downloads (CPU Pod)
- **Inference**: Hosting for vLLM, SGLang or any custom container, with support for binding Pods to different Services (no need to repeatedly destroy and create Pods during resource rebalancing)
- **Training**: Supports model training patterns including LlamaFactory and Torch Script
- **Training History**: Integration with SageMaker-managed MLFlow creation and display/sharing of training performance metrics
- **(NEW)Agentic Orchestration**: Provides integrated MCP server for Natural language based AI task orchestration, e.g. Cluster Management, Inference, (Coming Soon) Training & Hosting
- **(NEW)SandBox Service for RL Training**: Provides interactive SandBox Service within the Cluster for (Coding) RL Training

For detailed setup instructions, please refer to [Feishu Doc (zh_cn)](https://amzn-chn.feishu.cn/docx/VZfAdXTJKor7TCxPrZdcbGYXnaf?from=from_copylink), or [Lark Doc (en)](https://amzn-chn.feishu.cn/wiki/KKgVwwfiuiof9KkAP0CcYXfnnqd?from=from_copylink)


## Upcoming Features

| Type | Feature | Updated At | Target Date |
|------|---------|-----------|-------------------|
| Agentic | MCP Server for HyperPod InstantStart | 2025-12-25 | AVAILABLE |
| Training | RL SandBox as Cluster Service | 2025-12-25 | Done |

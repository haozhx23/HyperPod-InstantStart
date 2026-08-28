# ============================================================
# HyperPod InstantStart - Production Dockerfile (multi-stage)
# ============================================================
# Build context: project root
# Usage: docker build -t instantstart-web .
# ============================================================

# ---- Stage 1: Build React frontend ----
FROM node:25-slim AS build

WORKDIR /build

# Copy package files first for dependency caching
COPY ui-panel/package*.json ./
COPY ui-panel/client/package*.json ./client/

# Install dependencies
RUN npm install && cd client && npm install --no-package-lock

# Copy client source
COPY ui-panel/client/ ./client/

# `npm run build` 走 env-cmd 读 ui-panel/client/user.env（见 client/package.json）。
# 所有 REACT_APP_* 变量以 user.env 为单一来源，这里不再硬编码任何值。

# Build React production bundle
RUN cd client && npm run build

# ---- Stage 2: Production image ----
FROM node:25-slim

ARG AWS_CLI_VERSION=2.36.15
ARG AWS_CLI_SHA256=02a8eb2fe985be8ebcc284aaa5bae206ee8668872d6369e66a5c7d49d8671a08
ARG KUBECTL_VERSION=1.35.7
ARG KUBECTL_SHA256=12e97f9d23a9f6cbb87b89becd6bd291e1a858a3379a4e11e2c822c4c1530052
ARG EKSCTL_VERSION=0.229.0
ARG EKSCTL_SHA256=4a104d3a2a001de219e227baea1f0513ce6e87e60fef7dfc219cb0694e378829
ARG HELM_VERSION=3.21.3
ARG HELM_SHA256=15e041a93a590dce8100f39385cd98c84a765c9e36aeeb9e2dc6ff9e4769e2e0

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    unzip \
    jq \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI
RUN curl -fsSLo awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWS_CLI_VERSION}.zip" \
    && echo "${AWS_CLI_SHA256}  awscliv2.zip" | sha256sum -c - \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf awscliv2.zip aws \
    && aws --version 2>&1 | grep -F "aws-cli/${AWS_CLI_VERSION}"

# Install kubectl at the latest patch for the EKS minor in cluster-dependencies-config.json
RUN curl -fsSLo kubectl "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    && echo "${KUBECTL_SHA256}  kubectl" | sha256sum -c - \
    && install -m 0755 kubectl /usr/local/bin/kubectl \
    && rm kubectl \
    && kubectl version --client

# Install eksctl
RUN curl -fsSLo eksctl.tar.gz "https://github.com/eksctl-io/eksctl/releases/download/v${EKSCTL_VERSION}/eksctl_Linux_amd64.tar.gz" \
    && echo "${EKSCTL_SHA256}  eksctl.tar.gz" | sha256sum -c - \
    && tar xzf eksctl.tar.gz -C /tmp \
    && rm eksctl.tar.gz \
    && mv /tmp/eksctl /usr/local/bin/eksctl \
    && chmod +x /usr/local/bin/eksctl \
    && test "$(eksctl version)" = "${EKSCTL_VERSION}"

# Install Helm 3 (HyperPod charts are validated against the Helm 3 CLI)
RUN curl -fsSLo helm.tar.gz "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" \
    && echo "${HELM_SHA256}  helm.tar.gz" | sha256sum -c - \
    && tar xzf helm.tar.gz \
    && install -m 0755 linux-amd64/helm /usr/local/bin/helm \
    && rm -rf helm.tar.gz linux-amd64 \
    && helm version --short | grep -F "v${HELM_VERSION}"

WORKDIR /app

# Create node user directories
RUN mkdir -p /home/node/.kube /home/node/.aws && chown -R node:node /home/node

# Install server dependencies (production only)
COPY ui-panel/package*.json ./
RUN npm install --omit=dev

# Install Python dependencies
RUN pip3 install --break-system-packages --force-reinstall \
    'mlflow>=3.0.0' \
    'sagemaker-mlflow>=0.2.0' \
    pandas \
    boto3 \
    'httpx>=0.27.0'

# MCP server dependencies (required by hypd-inst-mcp/server.py)
RUN pip3 install --break-system-packages --force-reinstall \
    'mcp>=1.28.0,<2' \
    'cryptography>=43,<50' \
    && pip3 check

# Copy server code
COPY ui-panel/server/ ./server/

# Copy MLflow scripts
COPY ui-panel/mlflow/ ./mlflow/

# Copy built React frontend from Stage 1
COPY --from=build /build/client/build ./client/build/

# Copy CloudFormation templates (matches path resolution in cloudFormationManager.js)
COPY cli-min/ ./hyperpod-instantstart/cli-min/

# Copy MCP server
COPY hypd-inst-mcp/ ./mcp-server/

# Create runtime directories (will be overridden by volume mounts)
RUN mkdir -p config templates deployments logs managed_clusters_info tmp

# Ensure node user owns everything
RUN chown -R node:node /app

# Environment
ENV NODE_ENV=production
ENV KUBECONFIG=/home/node/.kube/config
ENV HOME=/home/node

# Unified single-port: HTTP + WebSocket (/ws) share this TCP port
EXPOSE 3099

CMD ["node", "server/index.js"]

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

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    unzip \
    jq \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf awscliv2.zip aws

# Install kubectl
RUN curl -O https://s3.us-west-2.amazonaws.com/amazon-eks/1.30.4/2024-09-11/bin/linux/amd64/kubectl \
    && chmod +x ./kubectl \
    && mv ./kubectl /usr/local/bin/

# Install eksctl
RUN curl -sL "https://github.com/eksctl-io/eksctl/releases/latest/download/eksctl_Linux_amd64.tar.gz" | tar xz -C /tmp \
    && mv /tmp/eksctl /usr/local/bin/eksctl \
    && chmod +x /usr/local/bin/eksctl

# Install helm
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

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
RUN pip3 install --break-system-packages --force-reinstall 'mcp>=1.0.0'

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

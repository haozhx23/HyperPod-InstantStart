#!/bin/bash
set -e
# ============================================================
# HyperPod InstantStart - Production Startup Script
# ============================================================
# Pulls the latest image from ECR and starts the container
# with only runtime data mounted (code is baked into image).
# ============================================================

REMOTE_REPO="public.ecr.aws/t5u4s6i0/instantstart-web:latest"
LOCAL_IMAGE="instantstart-web:latest"
CONTAINER_NAME="ui-panel-prod"

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
RELEASE_SOURCE_FILE="$SCRIPT_DIR/.release-source"

# Resolve image source mode:
#   - .release-source present → read `mode` field ("local-build" | "ecr-public")
#     Written by sync-release.sh to tell us where this tarball expects its image
#     from. "local-build" means this release was NOT pushed to public ECR, so we
#     must build from the bundled Dockerfile rather than pull a mismatched image.
#   - .release-source absent → default "ecr-public" (backward compat: old tarballs,
#     or dev runs from -SOURCE that want the current public ECR image).
#   - --local CLI flag → force local-build regardless of file.
RELEASE_MODE=$(python3 -c "import json; print(json.load(open('$RELEASE_SOURCE_FILE')).get('mode', 'ecr-public'))" 2>/dev/null || echo "ecr-public")

USE_LOCAL=false
if [ "$1" = "--local" ]; then
  USE_LOCAL=true
fi
if [ "$USE_LOCAL" = false ] && [ "$RELEASE_MODE" = "local-build" ]; then
  USE_LOCAL=true
  echo "📦 .release-source declares mode=local-build → using local image"
fi
IMAGE_REF=$([ "$USE_LOCAL" = true ] && echo "$LOCAL_IMAGE" || echo "$REMOTE_REPO")

install_cli_tools() {
  if ! command -v kiro-cli &> /dev/null; then
    echo "📦 Installing Kiro CLI..."
    curl -fsSL https://cli.kiro.dev/install | bash
    export PATH="$HOME/.local/bin:$PATH"
    kiro-cli settings chat.defaultModel claude-opus-4.6 2>/dev/null || true
    kiro-cli settings chat.enableTodoList true 2>/dev/null || true
  fi
}

generate_auth_hash() {
  local AUTH_FILE="$SCRIPT_DIR/config/auth.json"
  mkdir -p "$SCRIPT_DIR/config"

  local EXISTING_HASH=""
  local EXISTING_ENABLED="true"
  if [ -f "$AUTH_FILE" ]; then
    EXISTING_HASH=$(python3 -c "import json,sys; v=json.load(open('$AUTH_FILE')).get('hash'); sys.stdout.write(v if v else '')" 2>/dev/null || echo "")
    EXISTING_ENABLED=$(python3 -c "import json,sys; v=json.load(open('$AUTH_FILE')).get('enabled', True); sys.stdout.write('false' if v is False else 'true')" 2>/dev/null || echo "true")
  fi

  # 旧版本用 sha256(AWS Account ID) 当访问密钥。Account ID 不是秘密（每个 ARN、每个
  # ECR image URI 里都带），而且只有 12 位十进制，离线枚举是分钟级——见过账号 ID 的人
  # 就能算出密钥。检测到这种弱密钥则强制轮换，新密钥在下面打印出来。
  if [ -n "$EXISTING_HASH" ]; then
    local ACCOUNT_ID
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
    if [ -n "$ACCOUNT_ID" ] && \
       [ "$EXISTING_HASH" = "$(printf '%s' "$ACCOUNT_ID" | sha256sum | awk '{print $1}')" ]; then
      echo "⚠️  检测到旧版由 AWS Account ID 派生的访问密钥，任何知道账号 ID 的人都能算出它。"
      echo "⚠️  正在轮换为随机密钥：旧密钥立即失效，请用下面打印的新密钥重新登录。"
      EXISTING_HASH=""
    fi
  fi

  # Regeneration is controlled solely by the hash field; `enabled` is preserved.
  if [ -n "$EXISTING_HASH" ]; then
    echo "🔑 Auth hash already exists, skipping generation."
    if [ "$EXISTING_ENABLED" = "false" ]; then
      echo "🔓 Auth disabled (enabled=false) — UI is open, no access key required."
    else
      echo "🔑 Access Key: $EXISTING_HASH"
    fi
    return
  fi

  # 32 字节随机数，与 AWS 身份无关。密钥持久化在 config/auth.json，该目录在下方挂载进
  # 容器，所以重启不会重新生成；要主动轮换就删掉 auth.json 里的 hash 字段再启动。
  local AUTH_HASH
  AUTH_HASH=$(openssl rand -hex 32 2>/dev/null \
    || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')

  if [ "${#AUTH_HASH}" -ne 64 ]; then
    # 不能静默跳过：缺少 hash 时后端 authMiddleware 会 fail-open，面板变成完全开放。
    if [ "$EXISTING_ENABLED" = "false" ]; then
      echo "⚠️  无法生成访问密钥（openssl 与 /dev/urandom 都不可用），但 enabled=false，继续以开放模式启动。"
      return
    fi
    echo "❌ 无法生成访问密钥：openssl 与 /dev/urandom 都不可用。"
    echo "   继续启动会让面板处于无鉴权状态，已中止。"
    exit 1
  fi

  echo "{\"enabled\":$EXISTING_ENABLED,\"hash\":\"$AUTH_HASH\"}" > "$AUTH_FILE"
  chmod 600 "$AUTH_FILE"
  echo "🔑 Auth hash generated (32 random bytes)."
  if [ "$EXISTING_ENABLED" = "false" ]; then
    echo "🔓 Auth disabled (enabled=false) — UI is open. Hash stored for future use: $AUTH_HASH"
  else
    echo "🔑 Access Key: $AUTH_HASH"
  fi
}

install_cli_tools
generate_auth_hash

echo "=========================================="
echo "  HyperPod InstantStart (Production)"
echo "=========================================="

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "Docker is not installed. Please install Docker first."
    exit 1
fi

# Pull latest image (incremental, fast if already up-to-date)
if [ "$USE_LOCAL" = true ]; then
  if ! docker image inspect "$LOCAL_IMAGE" > /dev/null 2>&1; then
    DOCKERFILE="$SCRIPT_DIR/../Dockerfile"
    BUILD_CONTEXT="$SCRIPT_DIR/.."
    if [ ! -f "$DOCKERFILE" ]; then
      echo "❌ Local image $LOCAL_IMAGE not found, and Dockerfile not found at $DOCKERFILE"
      echo "   Either build the image manually (docker build -t $LOCAL_IMAGE <context>) or verify the release bundle is complete."
      exit 1
    fi
    echo "📦 Local image $LOCAL_IMAGE not found — building from $DOCKERFILE"
    echo "   Context: $BUILD_CONTEXT"
    (cd "$BUILD_CONTEXT" && docker build -t "$LOCAL_IMAGE" .)
    if ! docker image inspect "$LOCAL_IMAGE" > /dev/null 2>&1; then
      echo "❌ Build finished but image $LOCAL_IMAGE is still missing. Aborting."
      exit 1
    fi
  fi
  echo "Using local image: $LOCAL_IMAGE (skipping ECR pull)"
  echo "Image ID: $(docker image inspect "$LOCAL_IMAGE" --format='{{.Id}}')"
else
  echo "Pulling latest image..."
  aws ecr-public get-login-password --region us-east-1 2>/dev/null | docker login --username AWS --password-stdin public.ecr.aws 2>/dev/null || true
  docker pull $REMOTE_REPO
fi

# Stop and remove old container
echo "Stopping old container (if running)..."
docker stop $CONTAINER_NAME 2>/dev/null || true
docker rm $CONTAINER_NAME 2>/dev/null || true

# Ensure mount source dirs exist with correct ownership (UID 1000)
# Prevents Docker from auto-creating them as root, which breaks container writes.
mkdir -p ~/.kube ~/.aws
if [ "$(stat -c '%u' ~/.kube)" != "1000" ]; then
  sudo chown -R 1000:1000 ~/.kube
fi

# 所有挂载源都按 $SCRIPT_DIR 定位，不用 $(pwd)：从别的目录执行本脚本时，$(pwd) 会
# 指向不存在的路径，docker 会把它们**静默建成空目录**挂进去。后果是容器起来后
# `require('../../config/efa-only-instance-types.json')` 报 MODULE_NOT_FOUND 并
# 崩溃重启，同时在错误的位置留下一份新生成的 auth.json（2026-09-20 实际踩到）。
mkdir -p "$SCRIPT_DIR"/{config,templates,deployments,logs,managed_clusters_info,tmp}

# user.env 是**文件**挂载：源文件不存在时 docker 会建一个同名目录，容器里的
# require/读取随后以难以定位的方式失败。这里响亮地挡住，而不是让它带病启动。
if [ ! -f "$SCRIPT_DIR/client/user.env" ]; then
  echo "❌ 缺少 $SCRIPT_DIR/client/user.env（前端运行时配置，挂载为只读文件）"
  echo "   docker 会把缺失的文件挂载源建成目录，容器将以难以定位的方式失败，故在此中止。"
  exit 1
fi

# Get public IP for display
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null)
PUBLIC_IP=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null)

# Start container with runtime-only mounts
echo "Starting container..."
docker run -d \
  --name $CONTAINER_NAME \
  --restart unless-stopped \
  --network host \
  --user 1000:1000 \
  -v "$SCRIPT_DIR/config":/app/config \
  -v "$SCRIPT_DIR/client/user.env":/app/client/user.env:ro \
  -v "$SCRIPT_DIR/templates":/app/templates \
  -v "$SCRIPT_DIR/deployments":/app/deployments \
  -v "$SCRIPT_DIR/logs":/app/logs \
  -v "$SCRIPT_DIR/managed_clusters_info":/app/managed_clusters_info \
  -v "$SCRIPT_DIR/tmp":/app/tmp \
  -v /home/ubuntu/workspace/s3:/s3-workspace-metadata:ro \
  -v ~/.kube:/home/node/.kube:rw \
  -v ~/.aws:/home/node/.aws:ro \
  -e NODE_ENV=production \
  -e HOME=/home/node \
  $IMAGE_REF > /dev/null

echo ""
echo "=========================================="
echo "  Container is running!"
echo "=========================================="
echo "  Dashboard: http://localhost:3099"
if [ -n "$PUBLIC_IP" ]; then
echo "  Dashboard: http://$PUBLIC_IP:3099"
fi
echo "  View logs: docker logs -f $CONTAINER_NAME"
echo "  Stop:      docker stop $CONTAINER_NAME"
echo "=========================================="

#!/bin/bash
# Copy the source project plus this recipe's EKS overlay into the local FSx mount.
# Usage: SRC_PROJECT=/path/to/rl-agentic-on-aws bash sync-to-fsx.sh
set -euo pipefail

SRC_PROJECT="${SRC_PROJECT:?set SRC_PROJECT to the local path of the source project (rl-agentic-on-aws)}"
if [ ! -d "$SRC_PROJECT" ]; then
    echo "sync-to-fsx.sh: SRC_PROJECT=$SRC_PROJECT is not a directory" >&2
    exit 1
fi
FSX_LOCAL="${FSX_LOCAL:-/home/ubuntu/workspace/fsx}"
DEST="${DEST:-$FSX_LOCAL/rl-agentic-on-aws}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$(dirname "$DEST")"
rsync -a \
    --exclude '.git' \
    --exclude '.pytest_cache' \
    --exclude '__pycache__' \
    --exclude 'verl-venv' \
    --exclude 'skyrl-venv' \
    "$SRC_PROJECT/" "$DEST/"

mkdir -p "$DEST/aws"
rsync -a "$SCRIPT_DIR"/sandbox "$SCRIPT_DIR"/k8s "$SCRIPT_DIR"/patches "$SCRIPT_DIR"/training "$DEST/aws/"
cp "$SCRIPT_DIR"/entry-gsm8k.sh "$SCRIPT_DIR"/entry-swe-k8s.sh "$SCRIPT_DIR"/entry-devops-k8s.sh "$SCRIPT_DIR"/entry-terminal-k8s.sh "$DEST/aws/"

rsync -a "$SCRIPT_DIR"/overlay/ "$DEST/"

echo "Synced project to $DEST"
echo "Container path: /fsx/rl-agentic-on-aws"

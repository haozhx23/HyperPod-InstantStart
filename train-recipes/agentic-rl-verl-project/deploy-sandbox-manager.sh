#!/bin/bash
# Deploy the ClusterIP sandbox manager used by SWE/DevOps/Terminal veRL tools.
set -euo pipefail

IMAGE_URI="${1:-${IMAGE_URI:-}}"
FSX_CLAIM="${FSX_CLAIM:-fsx-claim}"
NAMESPACE="${NAMESPACE:-default}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$IMAGE_URI" ]; then
    echo "Usage: IMAGE_URI=<training-image-uri> $0"
    echo "   or: $0 <training-image-uri>"
    exit 1
fi

tmp="$(mktemp)"
sed \
    -e "s#__IMAGE_URI__#${IMAGE_URI}#g" \
    -e "s#__FSX_CLAIM__#${FSX_CLAIM}#g" \
    "$SCRIPT_DIR/k8s/sandbox-manager.yaml" > "$tmp"

kubectl apply -n "$NAMESPACE" -f "$tmp"
rm -f "$tmp"

kubectl rollout status -n "$NAMESPACE" deploy/agentic-rl-sandbox-manager
kubectl get svc -n "$NAMESPACE" agentic-rl-sandbox

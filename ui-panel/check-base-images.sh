#!/bin/bash
# =============================================================================
# check-base-images.sh <dockerfile>
# -----------------------------------------------------------------------------
# Pull every public.ecr.aws base image named in a Dockerfile's FROM lines and
# fail with an actionable message if a pull is refused.
#
# Why: the Dockerfile pulls its Node base image from the ECR Public mirror of
# Docker Official Images. Those images are anonymously pullable, but once a
# machine has run `docker login public.ecr.aws` (build.sh --push and
# start-prod.sh's ECR path both do), the stored token expires after 12 hours and
# from then on Docker sends the stale token and the registry answers
# 403 Forbidden — even for public images — instead of falling back to anonymous
# access. Without this check the failure shows up deep inside `docker build` as
# an unexplained 403.
#
# BuildKit resolves FROM tags against the registry on every build anyway, so
# pulling here does not change which image the build uses.
#
# Used by: build.sh, ui-panel/start-prod.sh
# =============================================================================
set -euo pipefail

DOCKERFILE="${1:?usage: check-base-images.sh <path/to/Dockerfile>}"
[ -f "$DOCKERFILE" ] || { echo "[base-images][FATAL] Dockerfile not found: $DOCKERFILE" >&2; exit 2; }

# FROM [--platform=...] <image> [AS <name>]
images="$(awk 'toupper($1)=="FROM" { for (i = 2; i <= NF; i++) if ($i !~ /^--/) { print $i; break } }' "$DOCKERFILE" | sort -u)"

for img in $images; do
  case "$img" in
    public.ecr.aws/*) ;;
    *) continue ;;
  esac
  if out="$(docker pull -q "$img" 2>&1)"; then
    echo "[base-images] ok: $img"
    continue
  fi
  echo "[base-images][FATAL] cannot pull base image $img" >&2
  printf '%s\n' "$out" | tail -n 3 >&2
  if [[ "$out" == *403* ]]; then
    echo "  public.ecr.aws refused the request (403). A stored public.ecr.aws login that has" >&2
    echo "  expired causes this even for public images. Either drop it:" >&2
    echo "    docker logout public.ecr.aws" >&2
    echo "  or refresh it:" >&2
    echo "    aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws" >&2
  fi
  exit 1
done

#!/usr/bin/env bash
set -euo pipefail

if command -v podman &>/dev/null; then
    engine=podman
else
    engine=docker
fi

mkdir -p assets

$engine run --rm \
  -v ./assets:/assets \
  -v ./scripts:/scripts:ro \
  -w /assets \
  python \
  bash -c /scripts/download-assets.sh
# bash -c "apt-get update && apt-get install -y curl zip && /scripts/download-assets.sh"

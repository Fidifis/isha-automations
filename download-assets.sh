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
  -v ./scripts/download-assets.sh:/download-assets.sh:ro \
  -w /assets \
  debian:stable-slim \
  bash -c "apt-get update && apt-get install -y curl && /download-assets.sh"

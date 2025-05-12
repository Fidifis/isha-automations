#!/usr/bin/env bash
set -euo pipefail

if command -v podman &>/dev/null; then
    engine=podman
else
    engine=docker
fi

mkdir -p bin

$engine run --rm \
  -v ./code:/build/code:ro \
  -v ./scripts:/build/scripts:ro \
  -v ./bin:/build/bin \
  -w /build \
  golang:1.24 \
  bash -c "apt-get update && apt-get install -y zip jq && /build/scripts/build-go.sh"

$engine run --rm \
  -v ./code:/build/code:ro \
  -v ./scripts:/build/scripts:ro \
  -v ./bin:/build/bin \
  -w /build \
  debian \
  bash -c "apt-get update && apt-get install -y zip jq curl xz-utils && /build/scripts/build-special.sh"

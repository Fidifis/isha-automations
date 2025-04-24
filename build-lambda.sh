#!/usr/bin/env bash

if command -v podman &>/dev/null; then
    engine=podman
else
    engine=docker
fi

mkdir -p bin

$engine run --rm \
  -v ./code:/build/code:ro \
  -v ./bin:/build/bin \
  -w /build \
  golang:1.24 \
  bash -c "apt-get update && apt-get install -y zip curl xz-utils && /build/code/build-go.sh"

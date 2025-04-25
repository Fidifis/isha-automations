#!/usr/bin/env bash
set -euo pipefail

echo "Running Go build..."

workdir=${PWD}

mkdir -p "$workdir/bin"
mkdir -p /tmp/build

cd "$workdir/code"

find . -type f -name go.mod | while read -r gomod; do
  lambda_dir=$(dirname "$gomod")
  lambda_name=$(echo "$lambda_dir" | sed 's|^\./||' | tr '/' '-')

  echo "Building $lambda_name from $lambda_dir..."
  cd "$workdir/code/$lambda_dir"

  export GOOS="linux"
  export GOARCH="arm64"
  export CGO_ENABLED=0

  if [ -f "build.json" ]; then
    echo "Found build.json, reading build configuration..."
    GOOS=$(jq -r ".os // \"$GOOS\"" build.json)
    GOARCH=$(jq -r ".arch // \"$GOARCH\"" build.json)
    CGO_ENABLED=$(jq -r ".cgo // \"$CGO_ENABLED\"" build.json)
    echo "Using GOOS=$GOOS, GOARCH=$GOARCH"
  fi

  go build -ldflags="-s -w" -o /tmp/build/bootstrap

  rm "$workdir/bin/$lambda_name.zip" 2> /dev/null || true
  zip -jq "$workdir/bin/$lambda_name.zip" /tmp/build/*
  rm /tmp/build/*
done

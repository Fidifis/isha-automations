#!/usr/bin/env bash
set -euo pipefail

echo "Running Lambda build..."

workdir=${PWD}

mkdir -p /tmp/build

cd "$workdir/code"

find . -type f -name go.mod | while read -r gomod; do
    lambda_dir=$(dirname "$gomod")
    lambda_name=$(echo "$lambda_dir" | sed 's|^\./||' | tr '/' '-')

    echo "Building $lambda_name from $lambda_dir..."

    cd "$workdir/code/$lambda_dir"

    GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
      go build -ldflags="-s -w" -o /tmp/build/bootstrap

    rm "$workdir/bin/$lambda_name.zip" 2> /dev/null || true
    zip -jq "$workdir/bin/$lambda_name.zip" /tmp/build/bootstrap
    rm /tmp/build/bootstrap
done

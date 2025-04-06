#!/usr/bin/env bash
set -euo pipefail

echo "Running Lambda build..."

workdir=${PWD}

mkdir -p /tmp/build

cd "$workdir/code"

for lambda_dir in */; do
    if [[ ! -f "$lambda_dir/go.mod" ]]; then
        # echo "Skipping $lambda_dir (no go.mod found)"
        continue
    fi
    lambda_name="${lambda_dir%/}"
    echo "Building $lambda_name..."
    cd "$workdir/code/$lambda_name"

    GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
      go build -ldflags="-s -w" -o /tmp/build/bootstrap

    rm "$workdir/bin/$lambda_name.zip"
    zip -jq "$workdir/bin/$lambda_name.zip" /tmp/build/bootstrap
    rm /tmp/build/bootstrap

    cd "$workdir/code"
done

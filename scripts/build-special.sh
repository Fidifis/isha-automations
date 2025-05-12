#!/usr/bin/env bash
set -euo pipefail

echo "Running custom builds..."

workdir=${PWD}

mkdir -p "$workdir/bin"
mkdir -p /tmp/build

cd "$workdir/code"

find . -type f -name "build.sh" | while read -r build_script; do
  lambda_dir=$(dirname "$build_script")
  lambda_name=$(echo "$lambda_dir" | sed 's|^\./||' | tr '/' '-')

  echo "Building $lambda_name from $lambda_dir..."
  cd "$workdir/code/$lambda_dir"

  "./build.sh" "$workdir/bin/$lambda_name.zip"
done

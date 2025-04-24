#!/usr/bin/env bash
set -euo pipefail

GOOS=linux GOARCH=x8664 CGO_ENABLED=0 \
  go build -ldflags="-s -w" -o /tmp/build/bootstrap

ffmpeg_version=7.1.1
curl -L https://ffmpeg.org/releases/ffmpeg-${ffmpeg_version}.tar.xz -o /tmp/ffmpeg.tar.xz
tar -xf /tmp/ffmpeg.tar.xz -C /tmp
mv /tmp/ffmpeg-${ffmpeg_version}/ffmpeg /tmp/build/

rm "$1" 2> /dev/null || true
zip -jq "$1" /tmp/build/*
rm /tmp/build/bootstrap

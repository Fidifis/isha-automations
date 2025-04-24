#!/usr/bin/env bash
set -euxo pipefail

GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -ldflags="-s -w" -o /tmp/build/bootstrap

ffmpeg_name="ffmpeg-n7.1.1-6-g48c0f071d4-linux64-gpl-7.1"

curl -L https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2025-04-23-13-05/${ffmpeg_name}.tar.xz -o /tmp/ffmpeg.tar.xz
tar -xf /tmp/ffmpeg.tar.xz -C /tmp
mv /tmp/${ffmpeg_name}/bin/ffmpeg /tmp/build/ffmpeg
mv /tmp/${ffmpeg_name}/bin/ffprobe /tmp/build/ffprobe

rm "$1" 2> /dev/null || true
zip -jq "$1" /tmp/build/*
rm /tmp/build/*

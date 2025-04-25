#!/usr/bin/env bash
set -euxo pipefail

curl -L https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-amd64-static.tar.xz -o /tmp/ffmpeg.tar.xz
tar -xf /tmp/ffmpeg.tar.xz -C /tmp

ffmpeg_dir=$(find /tmp -maxdepth 1 -type d -name "ffmpeg-*-amd64-static" | head -n 1)
mv "${ffmpeg_dir}/ffmpeg" /tmp/build/ffmpeg
mv "${ffmpeg_dir}/ffprobe" /tmp/build/ffprobe

rm "$1" 2> /dev/null || true
zip -jq "$1" /tmp/build/*
rm /tmp/build/*

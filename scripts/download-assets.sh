#!/usr/bin/env bash
set -euo pipefail

workdir=${PWD}

# Fonts
fonts=${workdir}/fonts
mkdir -p ${fonts}
api_url="https://fonts.googleapis.com/css2?family=Merriweather+Sans:wght@700&display=swap"
curl -o le.css "${api_url}"
font_url=$(grep -oE "url\([^)]+\)" le.css | head -n 1 | sed "s/url(\(.*\))/\\1/" | sed "s/'//g")
if [ -z "$font_url" ]; then
  echo "Error: Could not extract font file URL from the CSS."
  exit 1
fi
curl -o ${fonts}/merriweather_sans_bold.ttf ${font_url}

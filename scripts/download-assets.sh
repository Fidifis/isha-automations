#!/usr/bin/env bash
set -euo pipefail

workdir=${PWD}

# Fonts
fonts=${workdir}/fonts
mkdir -p ${fonts}
api_url="https://fonts.googleapis.com/css2?family=VAR_FAMILY&display=swap"
merriweathersans=${api_url//VAR_FAMILY/Merriweather+Sans:wght@700}
opensans=${api_url//VAR_FAMILY/Open+Sans:wght@700}
curl -o /tmp/le.css "${opensans}"
font_url=$(grep -oE "url\([^)]+\)" /tmp/le.css | head -n 1 | sed "s/url(\(.*\))/\\1/" | sed "s/'//g")
if [ -z "$font_url" ]; then
  echo "Error: Could not extract font file URL from the CSS."
  exit 1
fi
curl -o ${fonts}/open_sans_bold.ttf ${font_url}

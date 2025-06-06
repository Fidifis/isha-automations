#!/usr/bin/env bash
set -euo pipefail

workdir=${PWD}
fonts_dir="${workdir}/fonts"
mkdir -p "${fonts_dir}"

# Base Google Fonts API URL
base_url="https://fonts.googleapis.com/css2?family=VAR_FAMILY&display=swap"

# List of fonts to download (family name followed by weight/style descriptor for URL)
declare -A fonts=(
  ["open_sans_bold"]="Open+Sans:wght@700"
  ["merriweather_sans"]="Merriweather+Sans:wght@400"
)

# Temporary CSS file path
tmp_css="/tmp/font.css"

for font_name in "${!fonts[@]}"; do
  encoded_name="${fonts[$font_name]}"
  css_url="${base_url//VAR_FAMILY/${encoded_name}}"

  echo "Fetching CSS for ${font_name}..."
  curl -s -o "${tmp_css}" "${css_url}"

  font_url=$(grep -oE "url\([^)]+\)" "${tmp_css}" | head -n 1 | sed -E "s/url\(['\"]?([^'\")]+)['\"]?\)/\1/")
  if [[ -z "${font_url}" ]]; then
    echo "Error: Could not extract font URL for ${font_name}."
    exit 1
  fi

  font_file="${fonts_dir}/${font_name}.ttf"
  echo "Downloading ${font_name} from ${font_url}..."
  curl -s -o "${font_file}" "${font_url}"
done

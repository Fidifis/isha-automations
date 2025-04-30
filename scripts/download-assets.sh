#!/usr/bin/env bash

workdir=${PWD}

# Fonts
fonts=${workdir}/fonts
mkdir -p ${fonts}
curl -L https://github.com/google/fonts/raw/refs/heads/main/ofl/merriweathersans/MerriweatherSans%5Bwght%5D.ttf -o ${fonts}/merriweather_sans.ttf

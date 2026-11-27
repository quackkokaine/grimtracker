#!/bin/sh
# Builds GrimTracker.exe (Windows) and a Linux copy for testing.
# Run from the app folder after building the website (python3 ../build.py).
set -e
cd "$(dirname "$0")"
rm -rf site && mkdir -p site
cp ../index.html site/ && cp -r ../assets site/
python3 tools/make_syso.py tools/icon-src.png rsrc_windows_amd64.syso ../assets/icon.ico
mkdir -p dist
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H windowsgui" -o dist/GrimTracker.exe .
CGO_ENABLED=0 go build -trimpath -o dist/grimtracker-linux .
ls -la dist

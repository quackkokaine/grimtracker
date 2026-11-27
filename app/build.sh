#!/bin/sh
# Builds GrimTracker.exe (Windows) and a Linux copy for testing.
# Run from the app folder after building the website (python3 ../build.py).
set -e
cd "$(dirname "$0")"
rm -rf site && mkdir -p site
cp ../index.html site/ && cp -r ../assets site/
mkdir -p dist
python3 tools/make_syso.py tools/icon-src.png rsrc_windows_amd64.syso dist/GrimTracker.ico

GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H windowsgui" -o dist/GrimTracker.exe .
CGO_ENABLED=0 go build -trimpath -o dist/grimtracker-linux .
ls -la dist
# publish: the exe and the version file the installed app checks for updates
mkdir -p ../download
cp dist/GrimTracker.exe ../download/GrimTracker.exe
VER=$(sed -n 's/^var Version = "\(.*\)"/\1/p' main.go)
SUM=$(sha256sum dist/GrimTracker.exe | cut -d' ' -f1)
printf '{"version":"%s","sha256":"%s","file":"GrimTracker.exe"}\n' "$VER" "$SUM" > ../download/version.json
cat ../download/version.json

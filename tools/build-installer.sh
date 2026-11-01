#!/usr/bin/env bash
# Builds dist/StitchEditor-Setup-v<version>.exe
#   1. packs the app (tools/pack-update.js)
#   2. takes the Electron runtime from a previous full Windows zip ($BASE_ZIP) and swaps in the new app files
#   3. runs NSIS (makensis) on installer/installer.nsi
# Needs: node, unzip, NSIS (set MAKENSIS / NSISDIR if it isn't on PATH)
#   BASE_ZIP=path/to/StitchEditor-Windows-vX.zip tools/build-installer.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
BASE_ZIP=${BASE_ZIP:?set BASE_ZIP to a full StitchEditor-Windows zip (for the Electron runtime)}
MAKENSIS=${MAKENSIS:-makensis}
node tools/pack-update.js
STAGE=$(mktemp -d)
unzip -q "$BASE_ZIP" -d "$STAGE"
APPDIR="$STAGE/Stitch Editor"
rm -rf "$APPDIR/resources/app"; mkdir -p "$APPDIR/resources/app"
unzip -q "dist/StitchEditor-update-v$VERSION.zip" -d "$APPDIR/resources/app"
node tools/brand-exe.js "$APPDIR/Stitch Editor.exe" # otherwise Task Manager lists it as "Electron"
cd installer
"$MAKENSIS" -V2 -DVERSION="$VERSION" -DSRC="$APPDIR" -DOUT="../dist/StitchEditor-Setup-v$VERSION.exe" installer.nsi
rm -rf "$STAGE"
echo "Wrote dist/StitchEditor-Setup-v$VERSION.exe"

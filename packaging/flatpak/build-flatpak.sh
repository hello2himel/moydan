#!/usr/bin/env bash
# Build the Moydan Flatpak from the Tauri Linux binary.
#
# flatpak-builder is not required: `flatpak build-init` + `build-finish` +
# `build-export` + `build-bundle` gives the same result and works in user space.
# Prerequisites:
#
#   flatpak install --user flathub org.gnome.Sdk//48
#   node scripts/release.mjs --only linux      # produces target/release/moydan-desktop
#
# Usage:
#   packaging/flatpak/build-flatpak.sh [output-dir]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$REPO/dist-flatpak}"
BUILD_DIR="$REPO/.flatpak-build"
REPO_DIR="$REPO/.flatpak-repo"
BINARY="$REPO/apps/desktop/src-tauri/target/release/moydan-desktop"

APP_ID="dev.moydan.Moydan"
RUNTIME="org.gnome.Platform"
SDK="org.gnome.Sdk"
RUNTIME_BRANCH="48"
EXPORT_BRANCH="master"
VERSION="$(node -p "require('$REPO/package.json').version")"
BUNDLE="$OUT/Moydan-$VERSION-x86_64.flatpak"

if [ ! -x "$BINARY" ]; then
  echo "error: $BINARY not found." >&2
  echo "       Build it first:  node scripts/release.mjs --only linux" >&2
  exit 1
fi

echo "==> verifying the SDK is installed"
flatpak info --user "$SDK//$RUNTIME_BRANCH" >/dev/null

echo "==> initialising the build tree"
rm -rf "$BUILD_DIR" "$REPO_DIR"
mkdir -p "$OUT"
flatpak build-init "$BUILD_DIR" "$APP_ID" "$SDK//$RUNTIME_BRANCH" "$RUNTIME//$RUNTIME_BRANCH"

# Files are installed straight into the build tree rather than through
# `flatpak build`: the sandbox that command starts cannot see host paths, and
# nothing here needs to compile - the binary is already built.
echo "==> installing the application"
FILES="$BUILD_DIR/files"
install -Dm755 "$BINARY" "$FILES/bin/moydan"
install -Dm644 "$HERE/$APP_ID.desktop" "$FILES/share/applications/$APP_ID.desktop"
install -Dm644 "$HERE/$APP_ID.metainfo.xml" "$FILES/share/metainfo/$APP_ID.metainfo.xml"
install -Dm644 "$REPO/packaging/icons/moydan.svg" \
  "$FILES/share/icons/hicolor/scalable/apps/$APP_ID.svg"
install -Dm644 "$REPO/packaging/icons/moydan-256.png" \
  "$FILES/share/icons/hicolor/256x256/apps/$APP_ID.png"
install -Dm644 "$HERE/$APP_ID.desktop" "$FILES/share/applications/$APP_ID.desktop"

echo "==> finishing the build tree"
flatpak build-finish \
  --share=network \
  --socket=wayland \
  --socket=fallback-x11 \
  --device=dri \
  --env=MOYDAN_SERVER_URL=https://moydan.example \
  "$BUILD_DIR"

echo "==> exporting the repository"
flatpak build-export "$REPO_DIR" "$BUILD_DIR"

echo "==> bundling $BUNDLE"
flatpak build-bundle "$REPO_DIR" "$BUNDLE" "$APP_ID" "$EXPORT_BRANCH"

echo "==> install for local testing with:"
echo "    flatpak install --user --bundle $BUNDLE"
echo
ls -la "$OUT"

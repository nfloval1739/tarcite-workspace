#!/bin/bash
# Build minimal DMG only — reuses existing dist/TarCiteWorkspace.app, no PyInstaller
set -e
cd "$(dirname "$0")/.."

CODESIGN_IDENTITY="${CODESIGN_IDENTITY:-Developer ID Application: PT. DIGITAL ENGINERING INDONESIA (8XBP4MRL6L)}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-8XBP4MRL6L}"
MINIMAL_STAGE="dist/minimal"
MINIMAL_APP="$MINIMAL_STAGE/TarCiteWorkspace.app"
ICNS_OUT="packaging/TarCiteWorkspace.icns"

# Bundle version comes from citation.spec (the source of truth for the app).
APP_VERSION="$(sed -n 's/^APP_VERSION_STR = "\(.*\)"/\1/p' citation.spec)"
if [ -z "$APP_VERSION" ]; then
    echo "ERROR: could not read APP_VERSION_STR from citation.spec"
    exit 1
fi

# Artifact version suffix: the "02.56" out of "v.02.56 (Nokilalaki Peak)" in
# packaging/setup.iss, so the DMG filename carries the version automatically.
FILE_VER="$(sed -n 's/^#define MyAppDisplayVersion "v\.\([0-9][0-9.]*\).*/\1/p' packaging/setup.iss)"
if [ -z "$FILE_VER" ]; then
    echo "ERROR: could not read MyAppDisplayVersion from packaging/setup.iss"
    exit 1
fi
MINIMAL_DMG="dist/TarCiteWorkspace_minimal-mac_${FILE_VER}.dmg"

echo "=== Staging minimal app ==="
rm -rf "$MINIMAL_STAGE"
mkdir -p "$MINIMAL_STAGE"
cp -R "dist/TarCiteWorkspace.app" "$MINIMAL_APP"
rm -rf "$MINIMAL_APP/Contents/Resources/models"
rm -rf "$MINIMAL_APP/Contents/Resources/ollama_models"
echo "    Models stripped."

echo "=== Stamping app version: $APP_VERSION ==="
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $APP_VERSION" "$MINIMAL_APP/Contents/Info.plist" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $APP_VERSION" "$MINIMAL_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" "$MINIMAL_APP/Contents/Info.plist" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $APP_VERSION" "$MINIMAL_APP/Contents/Info.plist"

echo "=== Re-signing nested binaries ==="
while IFS= read -r -d '' f; do
    codesign --remove-signature "$f" 2>/dev/null || true
    codesign --force --options runtime --timestamp \
        --sign "$CODESIGN_IDENTITY" "$f" 2>/dev/null || \
    codesign --force --options runtime \
        --sign "$CODESIGN_IDENTITY" "$f" || true
done < <(find "$MINIMAL_APP" \( -name "*.dylib" -o -name "*.so" \) -print0)

while IFS= read -r -d '' fw; do
    codesign --force --options runtime --timestamp \
        --sign "$CODESIGN_IDENTITY" "$fw" 2>/dev/null || \
    codesign --force --options runtime \
        --sign "$CODESIGN_IDENTITY" "$fw" || true
done < <(find "$MINIMAL_APP/Contents/Frameworks" -maxdepth 1 -name "*.framework" -print0 2>/dev/null)

echo "=== Signing app bundle ==="
codesign --deep --force --options runtime --timestamp \
    --entitlements packaging/entitlements.plist \
    --sign "$CODESIGN_IDENTITY" \
    "$MINIMAL_APP"

codesign --verify "$MINIMAL_APP" && \
    echo "    Signature verified OK." || \
    { echo "    ERROR: Signature verification failed."; exit 1; }

echo "=== Creating minimal DMG ==="
rm -f "$MINIMAL_DMG"
create-dmg \
    --volname "TarCite Workspace" \
    --volicon "$ICNS_OUT" \
    --window-pos 200 120 \
    --window-size 580 320 \
    --icon-size 120 \
    --icon "TarCiteWorkspace.app" 160 140 \
    --hide-extension "TarCiteWorkspace.app" \
    --app-drop-link 420 140 \
    "$MINIMAL_DMG" \
    "$MINIMAL_APP"

codesign --sign "$CODESIGN_IDENTITY" "$MINIMAL_DMG"
echo ""
echo "=== Done: $MINIMAL_DMG ==="
echo "Next: notarize and staple:"
echo "  xcrun notarytool submit $MINIMAL_DMG --apple-id \$APPLE_ID --team-id $APPLE_TEAM_ID --password \$APPLE_APP_PASSWORD --wait"
echo "  xcrun stapler staple $MINIMAL_DMG"

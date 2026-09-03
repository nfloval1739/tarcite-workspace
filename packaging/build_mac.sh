#!/bin/bash
# Build TarCite Workspace for macOS
# Run from the project root: bash packaging/build_mac.sh

set -e
cd "$(dirname "$0")/.."

# ── Signing identity (Developer ID Application cert in login keychain) ────────
CODESIGN_IDENTITY="${CODESIGN_IDENTITY:-Developer ID Application: PT. DIGITAL ENGINERING INDONESIA (8XBP4MRL6L)}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-8XBP4MRL6L}"
# For notarization, set APPLE_ID and APPLE_APP_PASSWORD (app-specific password):
#   export APPLE_ID="your@email.com"
#   export APPLE_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
# ─────────────────────────────────────────────────────────────────────────────

echo "=== TarCite Workspace — macOS Build ==="
echo

# Artifact version suffix: the "02.56" out of "v.02.56 (Nokilalaki Peak)" in
# packaging/setup.iss, so DMG filenames carry the version automatically.
FILE_VER="$(sed -n 's/^#define MyAppDisplayVersion "v\.\([0-9][0-9.]*\).*/\1/p' packaging/setup.iss)"
if [ -z "$FILE_VER" ]; then
    echo "ERROR: could not read MyAppDisplayVersion from packaging/setup.iss"
    exit 1
fi
echo "Artifact version suffix: _$FILE_VER"
echo

# --- 1. App/runtime + build dependencies
echo "[1/6] Installing app and build dependencies..."
python -m pip install -r requirements.txt -q
python -m pip install -r packaging/requirements-build.txt -q

# --- 2. Ensure pystray and Pillow are in the active env
python -m pip install pystray Pillow -q

# --- 3. Pre-download HF embedding/reranker models
if [ ! -d "packaging/models" ]; then
    echo "[2/6] Downloading ML models (one-time, ~1.5 GB)..."
    python packaging/download_models.py
else
    echo "[2/6] ML models already present — skipping download."
fi

# --- 3b. Download Ollama binary + pre-pull qwen2.5:3b
if [ ! -f "packaging/ollama_mac/ollama" ]; then
    echo "[3/6] Downloading Ollama + qwen2.5:3b model (one-time, ~2 GB)..."
    bash packaging/download_ollama.sh
else
    echo "[3/6] Ollama already present — skipping download."
fi
if [ -d "packaging/ollama_models" ]; then
    echo "    Removing incomplete Ollama partial blobs before packaging..."
    find "packaging/ollama_models" -type f -name '*partial*' -delete
fi

# --- 4. Generate ICNS icon using Pillow (handles alpha correctly, adds brand background)
echo "[4/6] Creating macOS icon..."
ICNS_OUT="packaging/TarCiteWorkspace.icns"
python - <<'PYEOF'
from PIL import Image
import shutil

SRC = "app/static/logo/TarCite_logo.png"
ICONSET = "packaging/TarCiteWorkspace.iconset"
ICNS = "packaging/TarCiteWorkspace.icns"

shutil.rmtree(ICONSET, ignore_errors=True)
logo = Image.open(SRC).convert("RGBA")
brand_bg = Image.new("RGBA", logo.size, (0, 22, 65, 255))
brand_bg.alpha_composite(logo)
icon = brand_bg

icon.save(
    ICNS,
    format="ICNS",
    sizes=[(16, 16), (32, 32), (128, 128), (256, 256), (512, 512), (1024, 1024)],
)
print(f"    Icon created: {ICNS}")
PYEOF

# --- 5. Run PyInstaller
echo "[5/6] Running PyInstaller..."
pyinstaller citation.spec --clean --noconfirm
if [ -d "dist/TarCiteWorkspace.app/Contents/Resources/ollama_models" ]; then
    echo "    Removing incomplete Ollama partial blobs from app bundle..."
    find "dist/TarCiteWorkspace.app/Contents/Resources/ollama_models" -type f -name '*partial*' -delete
fi

# --- 6. Sign app bundle
echo "[6/7] Code-signing app bundle..."
codesign --deep --force --options runtime --timestamp \
    --entitlements packaging/entitlements.plist \
    --sign "$CODESIGN_IDENTITY" \
    "dist/TarCiteWorkspace.app"
echo "    Signed with: $CODESIGN_IDENTITY"

# Verify signature
codesign --verify --deep --strict "dist/TarCiteWorkspace.app" && \
    echo "    Signature verified OK." || \
    echo "    WARNING: Signature verification failed — check the identity."

# --- 7. Create DMG and notarize
echo "[7/7] Creating DMG installer..."
DMG_OUT="dist/TarCiteWorkspace-mac_${FILE_VER}.dmg"

if ! command -v create-dmg &> /dev/null; then
    echo "    create-dmg not found. Install with: brew install create-dmg"
    echo "    Skipping DMG creation. App is at: dist/TarCiteWorkspace.app"
else
    rm -f "$DMG_OUT"
    create-dmg \
        --volname "TarCite Workspace" \
        --volicon "$ICNS_OUT" \
        --window-pos 200 120 \
        --window-size 580 320 \
        --icon-size 120 \
        --icon "TarCiteWorkspace.app" 160 140 \
        --hide-extension "TarCiteWorkspace.app" \
        --app-drop-link 420 140 \
        "$DMG_OUT" \
        "dist/TarCiteWorkspace.app"

    codesign --sign "$CODESIGN_IDENTITY" "$DMG_OUT"
    echo "    DMG signed."

    echo
    echo "=== Done! DMG: $DMG_OUT ==="

    # ── Notarize (set APPLE_ID + APPLE_APP_PASSWORD to enable) ───────────────
    # Create an app-specific password at https://appleid.apple.com → Security
    if [ -n "$APPLE_ID" ] && [ -n "$APPLE_APP_PASSWORD" ]; then
        echo
        echo "Notarizing DMG (this may take a few minutes)..."
        xcrun notarytool submit "$DMG_OUT" \
            --apple-id "$APPLE_ID" \
            --team-id "$APPLE_TEAM_ID" \
            --password "$APPLE_APP_PASSWORD" \
            --wait
        xcrun stapler staple "$DMG_OUT"
        echo "    Notarization complete. DMG is ready for public distribution."
    else
        echo
        echo "To notarize for public distribution, set:"
        echo "  export APPLE_ID='nfloval.mh@gmail.com'"
        echo "  export APPLE_APP_PASSWORD='xxxx-xxxx-xxxx-xxxx'  # app-specific password from appleid.apple.com"
        echo "Then run:"
        echo "  xcrun notarytool submit $DMG_OUT --apple-id \$APPLE_ID --team-id $APPLE_TEAM_ID --password \$APPLE_APP_PASSWORD --wait"
        echo "  xcrun stapler staple $DMG_OUT"
    fi
fi

# ── MINIMAL BUILD (no bundled models) ────────────────────────────────────────
# Run with: MINIMAL=1 bash packaging/build_mac.sh
if [ "${MINIMAL:-0}" = "1" ]; then
    echo
    echo "=== Building MINIMAL version (no bundled models) ==="

    MINIMAL_STAGE="dist/minimal"
    MINIMAL_APP="$MINIMAL_STAGE/TarCiteWorkspace.app"
    MINIMAL_DMG="dist/TarCiteWorkspace_minimal-mac_${FILE_VER}.dmg"

    # Copy the full app into a staging dir named identically to the full build
    # so the installed app always shows as "TarCite Workspace" in the app list
    rm -rf "$MINIMAL_STAGE"
    mkdir -p "$MINIMAL_STAGE"
    cp -R "dist/TarCiteWorkspace.app" "$MINIMAL_APP"
    rm -rf "$MINIMAL_APP/Contents/Resources/models"
    rm -rf "$MINIMAL_APP/Contents/Resources/ollama_models"
    rm -f "$MINIMAL_APP/Contents/Frameworks/models"
    rm -f "$MINIMAL_APP/Contents/Frameworks/ollama_models"
    echo "    Models stripped from minimal build."

    # Re-sign: strip stale signatures from all nested binaries first,
    # then sign inside-out so every component has a valid timestamp
    find "$MINIMAL_APP" \( -name "*.dylib" -o -name "*.so" \) | while read f; do
        codesign --remove-signature "$f" 2>/dev/null || true
        codesign --force --options runtime --timestamp \
            --sign "$CODESIGN_IDENTITY" "$f"
    done
    find "$MINIMAL_APP/Contents/Frameworks" -maxdepth 1 -name "*.framework" 2>/dev/null | while read fw; do
        codesign --force --options runtime --timestamp \
            --sign "$CODESIGN_IDENTITY" "$fw"
    done
    codesign --deep --force --options runtime --timestamp \
        --entitlements packaging/entitlements.plist \
        --sign "$CODESIGN_IDENTITY" \
        "$MINIMAL_APP"
    codesign --verify "$MINIMAL_APP" && \
        echo "    Minimal signature verified OK." || \
        { echo "    ERROR: Minimal signature verification failed."; exit 1; }

    # Package DMG
    if command -v create-dmg &> /dev/null; then
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
        echo "=== Minimal DMG: $MINIMAL_DMG ==="
    fi
fi

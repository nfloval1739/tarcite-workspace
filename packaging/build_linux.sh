#!/bin/bash
# Build TarCite Workspace for Linux (produces a standalone tar.gz)
# Run from the project root: bash packaging/build_linux.sh

set -e
cd "$(dirname "$0")/.."

echo "=== TarCite Workspace — Linux Build ==="
echo

# --- 1. Build dependencies
echo "[1/5] Installing app and build dependencies..."
python -m pip install -r requirements.txt -q
python -m pip install -r packaging/requirements-build.txt -q
python -m pip install PyGObject pystray Pillow -q

MINIMAL_ONLY=0
if [ "${BUILD_VARIANT}" = "minimal" ] || [ "${BUILD_MINIMAL_ONLY}" = "1" ]; then
    MINIMAL_ONLY=1
fi

if [ "$MINIMAL_ONLY" = "1" ]; then
    echo "[2/5] Skipping bundled ML models for minimal build."
    echo "[3/5] Skipping bundled Ollama for minimal build."
else
    # --- 2. Pre-download HF embedding/reranker models
    if [ ! -d "packaging/models" ]; then
        echo "[2/5] Downloading ML models (one-time, ~1.5 GB)..."
        python packaging/download_models.py
    else
        echo "[2/5] ML models already present — skipping download."
    fi

    # --- 3. Download Ollama Linux binary + pre-pull qwen2.5:3b
    if [ ! -f "packaging/ollama_linux/ollama" ]; then
        echo "[3/5] Downloading Ollama for Linux..."
        mkdir -p packaging/ollama_linux
        OLLAMA_VERSION="v0.24.0"
        curl -fL "https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/ollama-linux-amd64" \
            -o packaging/ollama_linux/ollama
        chmod +x packaging/ollama_linux/ollama
    else
        echo "[3/5] Ollama already present — skipping download."
    fi

    if [ -d "packaging/ollama_models" ]; then
        echo "    Removing incomplete Ollama partial blobs before packaging..."
        find "packaging/ollama_models" -type f -name '*partial*' -delete
    fi
fi

# --- 4. Run PyInstaller
echo "[4/5] Running PyInstaller..."
pyinstaller citation.spec --clean --noconfirm
if [ -d "dist/TarCiteWorkspace/ollama_models" ]; then
    echo "    Removing incomplete Ollama partial blobs from app bundle..."
    find "dist/TarCiteWorkspace/ollama_models" -type f -name '*partial*' -delete
fi
if [ -d "dist/TarCiteWorkspace/_internal/ollama_models" ]; then
    find "dist/TarCiteWorkspace/_internal/ollama_models" -type f -name '*partial*' -delete
fi

# --- 5. Package as tar.gz
echo "[5/5] Creating Linux archive..."
ARCHIVE_NAME="TarCiteWorkspace-linux-x86_64"

if [ "$MINIMAL_ONLY" = "1" ]; then
    ARCHIVE_NAME="TarCiteWorkspace_minimal-linux-x86_64"
    MINIMAL_STAGE="dist/minimal/TarCite Workspace"
    rm -rf "dist/minimal"
    mkdir -p "$MINIMAL_STAGE"
    cp -r dist/TarCiteWorkspace/. "$MINIMAL_STAGE/"
    # Strip models
    rm -rf "$MINIMAL_STAGE/models" \
           "$MINIMAL_STAGE/ollama_models" \
           "$MINIMAL_STAGE/_internal/models" \
           "$MINIMAL_STAGE/_internal/ollama_models"
    echo "    Models stripped from minimal build."
    cd dist/minimal
    tar -czf "../${ARCHIVE_NAME}.tar.gz" "TarCite Workspace"
    cd ../..
    echo
    echo "=== Done! Archive: dist/${ARCHIVE_NAME}.tar.gz ==="
else
    cd dist
    tar -czf "${ARCHIVE_NAME}.tar.gz" TarCiteWorkspace
    cd ..
    echo
    echo "=== Done! Archive: dist/${ARCHIVE_NAME}.tar.gz ==="
fi

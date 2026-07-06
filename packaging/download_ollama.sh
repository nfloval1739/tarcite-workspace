#!/bin/bash
# Download the Ollama binary and pre-pull qwen2.5:3b model blobs for bundling.
# Run from the project root: bash packaging/download_ollama.sh
#
# Output:
#   packaging/ollama/ollama        — the Ollama server binary
#   packaging/ollama_models/       — pre-pulled model blobs (OLLAMA_MODELS layout)

set -e
cd "$(dirname "$0")/.."

OLLAMA_DIR="packaging/ollama_mac"
OLLAMA_MODELS_DIR="packaging/ollama_models"
OLLAMA_BIN="$OLLAMA_DIR/ollama"
OLLAMA_VERSION="v0.24.0"  # update to latest stable as needed
MODEL="qwen2.5:3b"

cleanup_partial_blobs() {
    if [ -d "$OLLAMA_MODELS_DIR" ]; then
        find "$OLLAMA_MODELS_DIR" -type f -name '*partial*' -delete
    fi
}

echo "=== TarCite Workspace — Ollama Download ==="
echo

# ── 1. Download Ollama binary ────────────────────────────────────────────────
if [ -f "$OLLAMA_BIN" ]; then
    echo "[1/2] Ollama binary already present — skipping download."
else
    echo "[1/2] Downloading Ollama $OLLAMA_VERSION for macOS..."
    mkdir -p "$OLLAMA_DIR"

    TGZ_URL="https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/ollama-darwin.tgz"
    TGZ_TMP="$OLLAMA_DIR/ollama-darwin.tgz"

    curl -fL "$TGZ_URL" -o "$TGZ_TMP"
    # Extract everything — includes ollama binary + required dylibs/so files
    tar -xzf "$TGZ_TMP" -C "$OLLAMA_DIR"
    rm -f "$TGZ_TMP"
    chmod +x "$OLLAMA_BIN"
    echo "    Ollama bundle extracted to $OLLAMA_DIR"
fi

# ── 2. Copy qwen2.5:3b model blobs from local Ollama cache ──────────────────
MANIFEST_PATH="$OLLAMA_MODELS_DIR/manifests/registry.ollama.ai/library/qwen2.5/3b"
if [ -f "$MANIFEST_PATH" ]; then
    echo "[2/2] Model blobs already present — skipping copy."
    cleanup_partial_blobs
else
    LOCAL_MANIFEST="$HOME/.ollama/models/manifests/registry.ollama.ai/library/qwen2.5/3b"
    if [ -f "$LOCAL_MANIFEST" ]; then
        echo "[2/2] Copying $MODEL blobs from local Ollama cache..."
        mkdir -p "$OLLAMA_MODELS_DIR/manifests/registry.ollama.ai/library/qwen2.5"
        mkdir -p "$OLLAMA_MODELS_DIR/blobs"
        cp "$LOCAL_MANIFEST" "$OLLAMA_MODELS_DIR/manifests/registry.ollama.ai/library/qwen2.5/3b"
        # Copy each blob referenced by the manifest
        python3 -c "
import json, os, shutil, sys
manifest = json.load(open('$LOCAL_MANIFEST'))
layers = manifest.get('layers', []) + [manifest.get('config', {})]
src_dir = os.path.expanduser('~/.ollama/models/blobs')
dst_dir = '$OLLAMA_MODELS_DIR/blobs'
for layer in layers:
    digest = layer.get('digest', '').replace(':', '-')
    if not digest: continue
    src = os.path.join(src_dir, digest)
    if os.path.exists(src):
        print(f'  Copying {digest[:20]}...')
        shutil.copy2(src, os.path.join(dst_dir, digest))
"
        echo "    Model blobs copied to $OLLAMA_MODELS_DIR"
        cleanup_partial_blobs
    else
        echo "[2/2] Local Ollama cache not found. Pulling $MODEL (~1.9 GB)..."
        mkdir -p "$OLLAMA_MODELS_DIR"
        OLLAMA_MODELS="$(pwd)/$OLLAMA_MODELS_DIR" "$OLLAMA_BIN" serve &
        OLLAMA_PID=$!
        for i in $(seq 1 30); do
            curl -sf http://127.0.0.1:11434/ > /dev/null 2>&1 && break
            sleep 1
        done
        OLLAMA_HOST="127.0.0.1:11434" OLLAMA_MODELS="$(pwd)/$OLLAMA_MODELS_DIR" "$OLLAMA_BIN" pull "$MODEL"
        kill "$OLLAMA_PID" 2>/dev/null
        wait "$OLLAMA_PID" 2>/dev/null
        cleanup_partial_blobs
        echo "    Model blobs saved to $OLLAMA_MODELS_DIR"
    fi
fi

echo
echo "=== Done! ==="
echo "  Binary : $OLLAMA_BIN"
echo "  Models : $OLLAMA_MODELS_DIR"
BLOB_SIZE=$(du -sh "$OLLAMA_MODELS_DIR" 2>/dev/null | cut -f1 || echo "unknown")
echo "  Model size: $BLOB_SIZE"

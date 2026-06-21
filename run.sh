#!/bin/bash
cd "$(dirname "$0")"

APP_PORT="${APP_PORT:-4443}"
LOCAL_URL="https://tarcite.workspace"

# Kill any existing process on the app port
EXISTING=$(lsof -ti:"$APP_PORT" 2>/dev/null)
if [ -n "$EXISTING" ]; then
    echo "Stopping existing server on port $APP_PORT (PID: $EXISTING)..."
    kill -9 $EXISTING 2>/dev/null
    sleep 1
fi

source venv/bin/activate 2>/dev/null || { echo "Creating virtual environment..."; python3 -m venv venv; source venv/bin/activate; pip install -r requirements.txt; }

# ── Ollama ────────────────────────────────────────────────────────────────────
# The packaged app bundles Ollama and controls OLLAMA_MODELS.  In dev mode we
# must do the same: kill any stale instance (it may be running with the wrong
# OLLAMA_MODELS from a previous packaged-app launch), then start a clean one
# so it reads from the default ~/.ollama/models/ where dev models live.

_start_dev_ollama() {
    # Find an Ollama binary: prefer the one bundled in packaging/, fall back to system.
    OLLAMA_BIN=""
    if [ -f "packaging/ollama_mac/ollama" ]; then
        OLLAMA_BIN="packaging/ollama_mac/ollama"
    elif [ -f "packaging/ollama/ollama" ]; then
        # Legacy path (pre-platform-split)
        OLLAMA_BIN="packaging/ollama/ollama"
    elif command -v ollama &>/dev/null; then
        OLLAMA_BIN="$(command -v ollama)"
    fi

    if [ -z "$OLLAMA_BIN" ]; then
        echo "  Ollama not found — local LLM unavailable in dev mode."
        return
    fi

    # Kill any existing Ollama on port 11434 (may have wrong OLLAMA_MODELS).
    EXISTING_OLLAMA=$(lsof -ti tcp:11434 2>/dev/null)
    if [ -n "$EXISTING_OLLAMA" ]; then
        for pid in $EXISTING_OLLAMA; do
            COMM=$(ps -p "$pid" -o comm= 2>/dev/null)
            if echo "$COMM" | grep -qi ollama; then
                echo "  Stopping stale Ollama PID $pid ($COMM)..."
                kill "$pid" 2>/dev/null
            fi
        done
        sleep 1
    fi

    # Start fresh — no OLLAMA_MODELS override so it uses ~/.ollama/models/ default.
    unset OLLAMA_MODELS
    OLLAMA_HOST=127.0.0.1:11434 OLLAMA_ORIGINS='*' "$OLLAMA_BIN" serve \
        >/tmp/ollama-dev.log 2>&1 &
    OLLAMA_PID=$!
    echo "  Ollama started (PID $OLLAMA_PID, binary: $OLLAMA_BIN)"
    echo "  Logs: /tmp/ollama-dev.log"

    # Wait up to 10 s for Ollama to be ready.
    for i in $(seq 1 20); do
        curl -sf http://127.0.0.1:11434/ >/dev/null 2>&1 && break
        sleep 0.5
    done
}

echo "Starting Ollama for dev..."
_start_dev_ollama

CERT="$HOME/.citation-workspace/citation-workspace-local.pem"
KEY="$HOME/.citation-workspace/citation-workspace-local-key.pem"

echo "Starting TarCite Workspace..."

# Forward port 443 → 4443 so the app can bind without root privileges
if sudo pfctl -s nat 2>/dev/null | grep -q "4443"; then
    : # rule already loaded
else
    echo "rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port $APP_PORT" | sudo pfctl -ef - 2>/dev/null && echo "Port 443 → $APP_PORT forwarding enabled."
fi

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
    echo "HTTPS enabled — $LOCAL_URL"
    uvicorn app.main:app --host 127.0.0.1 --port "$APP_PORT" --reload --ssl-certfile "$CERT" --ssl-keyfile "$KEY"
else
    echo "HTTP mode — http://tarcite.workspace (run Setup Word Connector.command for HTTPS)"
    uvicorn app.main:app --host 127.0.0.1 --port "$APP_PORT" --reload
fi

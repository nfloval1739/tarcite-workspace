#!/bin/bash
# TarCite Workspace – Word Connector Setup
# Double-click this file to set up HTTPS and start the app.

cd "$(dirname "$0")"

CERT_DIR="$HOME/.citation-workspace"
CERT_FILE="$CERT_DIR/citation-workspace-local.pem"
KEY_FILE="$CERT_DIR/citation-workspace-local-key.pem"
APP_PORT="${APP_PORT:-4443}"
LOCAL_HOST="tarcite.workspace"
LOCAL_URL="https://tarcite.workspace:$APP_PORT"

echo "============================================"
echo "  TarCite Workspace – Word Connector Setup"
echo "============================================"
echo ""

# Kill any existing process on the app port
EXISTING=$(lsof -ti:"$APP_PORT" 2>/dev/null)
if [ -n "$EXISTING" ]; then
    echo "Stopping existing server on port $APP_PORT..."
    kill -9 $EXISTING 2>/dev/null
    sleep 1
fi

# Step 1: Generate certificate if missing
if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ] || ! openssl x509 -in "$CERT_FILE" -noout -text 2>/dev/null | grep -q "DNS:tarcite.workspace"; then
    echo "[1/4] Generating local HTTPS certificate..."
    mkdir -p "$CERT_DIR"
    openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout "$KEY_FILE" \
        -out "$CERT_FILE" \
        -days 365 \
        -subj "/CN=TarCite Workspace Local" \
        -addext "subjectAltName=DNS:tarcite.workspace,DNS:citation.workingspace,DNS:localhost,IP:127.0.0.1" 2>/dev/null
    echo "      Certificate created."
else
    echo "[1/4] Certificate already exists."
fi

# Step 2: Ensure local hostname resolves to this machine
echo "[2/4] Ensuring local hostname resolves..."
if ! grep -q "[[:space:]]$LOCAL_HOST" /etc/hosts; then
    echo "127.0.0.1 $LOCAL_HOST" | sudo tee -a /etc/hosts >/dev/null
fi
echo "      $LOCAL_HOST resolves locally."

# Step 3: Trust certificate in macOS keychain
echo "[3/4] Trusting certificate in system keychain..."
echo "      (You will be asked for your password)"
sudo security add-trusted-cert \
    -d \
    -r trustRoot \
    -k /Library/Keychains/System.keychain \
    "$CERT_FILE" 2>/dev/null
echo "      Certificate trusted."

# Step 4: Use the direct HTTPS app port
echo "[4/5] Word connector URL: $LOCAL_URL"

# Step 5: Activate venv and start app
echo "[5/5] Starting TarCite Workspace with HTTPS..."
echo ""

if [ -d "venv" ]; then
    source venv/bin/activate
else
    echo "Creating virtual environment..."
    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
fi

echo "============================================"
echo "  App running at: $LOCAL_URL"
echo "  Press Ctrl+C to stop"
echo "============================================"
echo ""

open "$LOCAL_URL"

uvicorn app.main:app --host 127.0.0.1 --port "$APP_PORT" --reload \
    --ssl-certfile "$CERT_FILE" --ssl-keyfile "$KEY_FILE"

@echo off
REM Download the Ollama binary and pre-pull qwen2.5:3b model blobs for bundling.
REM Run from the project root: packaging\download_ollama.bat
REM
REM Output:
REM   packaging\ollama\ollama.exe        — the Ollama server binary
REM   packaging\ollama_models\           — pre-pulled model blobs (OLLAMA_MODELS layout)

cd /d "%~dp0.."

set OLLAMA_DIR=packaging\ollama_win
set OLLAMA_MODELS_DIR=packaging\ollama_models
set OLLAMA_BIN=%OLLAMA_DIR%\ollama.exe
set OLLAMA_VERSION=v0.24.0
set MODEL=qwen2.5:3b

echo === TarCite Workspace - Ollama Download ===
echo.

REM ── 1. Download Ollama binary ────────────────────────────────────────────────
if exist "%OLLAMA_BIN%" (
    echo [1/2] Ollama binary already present -- skipping download.
) else (
    echo [1/2] Downloading Ollama %OLLAMA_VERSION% for Windows...
    mkdir "%OLLAMA_DIR%" 2>nul
    curl.exe -L --fail --retry 5 --retry-delay 10 --retry-all-errors ^
        -o "%OLLAMA_BIN%" ^
        "https://github.com/ollama/ollama/releases/download/%OLLAMA_VERSION%/ollama-windows-amd64.exe"
    if errorlevel 1 (
        echo ERROR: Failed to download Ollama binary.
        if not defined CI pause
        exit /b 1
    )
    echo     Ollama binary saved to %OLLAMA_BIN%
)

REM ── 2. Pre-pull qwen2.5:3b model blobs ──────────────────────────────────────
set MANIFEST_PATH=%OLLAMA_MODELS_DIR%\manifests\registry.ollama.ai\library\qwen2.5\3b
if exist "%MANIFEST_PATH%" (
    echo [2/2] Model blobs already present -- skipping pull.
    del /s /q "%OLLAMA_MODELS_DIR%\*partial*" >nul 2>nul
) else (
    echo [2/2] Pre-pulling %MODEL% model blobs - about 1.9 GB, one-time...
    mkdir "%OLLAMA_MODELS_DIR%" 2>nul

    REM Start a temporary Ollama server pointing at our staging models dir
    set OLLAMA_MODELS=%cd%\%OLLAMA_MODELS_DIR%
    set OLLAMA_HOST=127.0.0.1:11434
    start "" /B "%OLLAMA_BIN%" serve

    REM Wait for server to be ready
    :wait_loop
    powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:11434/' -TimeoutSec 1 -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
    if errorlevel 1 (
        timeout /t 1 /nobreak >nul
        goto wait_loop
    )

    "%OLLAMA_BIN%" pull %MODEL%
    if errorlevel 1 (
        echo ERROR: Failed to pull model.
        taskkill /f /im ollama.exe >nul 2>nul
        if not defined CI pause
        exit /b 1
    )

    taskkill /f /im ollama.exe >nul 2>nul
    del /s /q "%OLLAMA_MODELS_DIR%\*partial*" >nul 2>nul
    echo     Model blobs saved to %OLLAMA_MODELS_DIR%
)

echo.
echo === Done! ===
echo   Binary : %OLLAMA_BIN%
echo   Models : %OLLAMA_MODELS_DIR%
if not defined CI pause

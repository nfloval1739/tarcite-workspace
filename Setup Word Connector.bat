@echo off
REM TarCite Workspace - Word Connector Setup (Windows)
REM Double-click this file to set up HTTPS and start the app.

cd /d "%~dp0"

set CERT_DIR=%USERPROFILE%\.citation-workspace
set CERT_FILE=%CERT_DIR%\citation-workspace-local.pem
set KEY_FILE=%CERT_DIR%\citation-workspace-local-key.pem
if "%APP_PORT%"=="" set APP_PORT=4443
set LOCAL_HOST=tarcite.workspace
set LOCAL_URL=https://tarcite.workspace:%APP_PORT%

echo ============================================
echo   TarCite Workspace - Word Connector Setup
echo ============================================
echo.

REM Step 1: Check for OpenSSL
where openssl >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] OpenSSL not found in PATH.
    echo     Please install OpenSSL or Git for Windows (includes OpenSSL).
    echo     Download: https://slproweb.com/products/Win32OpenSSL.html
    echo.
    echo     Press any key to exit...
    pause >nul
    exit /b 1
)

REM Step 2: Generate certificate if missing or missing TarCite local hostname
set REGEN_CERT=0
if not exist "%CERT_FILE%" set REGEN_CERT=1
if exist "%CERT_FILE%" (
    openssl x509 -in "%CERT_FILE%" -noout -text 2>nul | findstr /C:"DNS:tarcite.workspace" >nul
    if errorlevel 1 set REGEN_CERT=1
)
if "%REGEN_CERT%"=="1" (
    echo [1/4] Generating local HTTPS certificate...
    mkdir "%CERT_DIR%" 2>nul
    openssl req -x509 -newkey rsa:2048 -nodes ^
        -keyout "%KEY_FILE%" ^
        -out "%CERT_FILE%" ^
        -days 365 ^
        -subj "/CN=TarCite Workspace Local" ^
        -addext "subjectAltName=DNS:tarcite.workspace,DNS:citation.workingspace,DNS:localhost,IP:127.0.0.1" 2>nul
    echo       Certificate created.
) else (
    echo [1/4] Certificate already exists.
)

REM Step 3: Ensure local hostname resolves to this machine
echo [2/4] Ensuring local hostname resolves...
findstr /C:"%LOCAL_HOST%" "%SystemRoot%\System32\drivers\etc\hosts" >nul 2>nul
if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process -FilePath cmd.exe -Verb RunAs -Wait -ArgumentList '/c echo 127.0.0.1 %LOCAL_HOST%>>%SystemRoot%\System32\drivers\etc\hosts'" 2>nul
)
echo       %LOCAL_HOST% resolves locally.

REM Step 4: Trust certificate in Windows certificate store
echo [3/4] Trusting certificate in Windows certificate store...
echo       (You will be asked for admin permission)
certutil -addstore -f Root "%CERT_FILE%" >nul 2>&1
if %errorlevel% neq 0 (
    echo       Trying alternative method (may prompt for permission)...
    powershell -Command "Import-Certificate -FilePath '%CERT_FILE%' -CertStoreLocation Cert:\LocalMachine\Root" 2>nul
)
echo       Certificate trusted.

REM Step 5: Activate venv and start app
echo [4/4] Starting TarCite Workspace with HTTPS...
echo.

if exist "venv\Scripts\activate.bat" (
    call venv\Scripts\activate.bat
) else (
    echo Creating virtual environment...
    python -m venv venv
    call venv\Scripts\activate.bat
    pip install -r requirements.txt
)

echo ============================================
echo   App running at: %LOCAL_URL%
echo   Press Ctrl+C to stop
echo ============================================
echo.

start "" "%LOCAL_URL%"

uvicorn app.main:app --host 127.0.0.1 --port %APP_PORT% --reload ^
    --ssl-certfile "%CERT_FILE%" --ssl-keyfile "%KEY_FILE%"

pause

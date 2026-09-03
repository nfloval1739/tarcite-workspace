@echo off
REM Build TarCite Workspace for Windows
REM Run from the project root: packaging\build_windows.bat
REM
REM Environment variables:
REM   BUILD_VARIANT=minimal    → build minimal only (no bundled models)
REM   SIGNTOOL=1               → sign the installer (requires cert configured in setup.iss)
REM   CI=1                     → non-interactive mode (no pause on error)

setlocal EnableDelayedExpansion

cd /d "%~dp0.."
echo === TarCite Workspace - Windows Build ===
echo.

REM --- 0. Determine build variant -------------------------------------------
set "MINIMAL_ONLY=0"
if /I "%BUILD_VARIANT%"=="minimal" set "MINIMAL_ONLY=1"
if "%BUILD_MINIMAL_ONLY%"=="1" set "MINIMAL_ONLY=1"

if "%MINIMAL_ONLY%"=="1" (
    echo Variant : MINIMAL (no bundled models)
) else (
    echo Variant : FULL (models + Ollama + qwen2.5:3b bundled)
)

REM --- 0b. Version suffix for artifact names ----------------------------------
REM The third token of the MyAppDisplayVersion line is "v.02.56 -- skip the
REM leading quote and "v." (3 chars) to get the 02.56 filename suffix.
set "FILE_VER="
for /f "usebackq tokens=3" %%A in (`findstr /B /C:"#define MyAppDisplayVersion" packaging\setup.iss`) do set "FILE_VER=%%A"
if defined FILE_VER set "FILE_VER=%FILE_VER:~3%"
if not defined FILE_VER set "FILE_VER=unknown"
set "FULL_EXE=dist\TarCiteWorkspace-Setup_%FILE_VER%.exe"
set "MINIMAL_EXE=dist\TarCiteWorkspace_minimal-Setup_%FILE_VER%.exe"
echo Artifact suffix : _%FILE_VER%

REM Export the installer paths for CI (GitHub Actions reads GITHUB_ENV)
if defined CI if defined GITHUB_ENV (
    echo FULL_INSTALLER=%FULL_EXE%>> "%GITHUB_ENV%"
    echo MINIMAL_INSTALLER=%MINIMAL_EXE%>> "%GITHUB_ENV%"
)
echo.

REM --- 1. Build dependencies ------------------------------------------------
echo [1/6] Installing app and build dependencies...
python -m pip install -r requirements.txt -q
if errorlevel 1 (
    echo ERROR: Failed to install app dependencies.
    if not defined CI pause
    exit /b 1
)
python -m pip install -r packaging\requirements-build.txt -q
if errorlevel 1 (
    echo ERROR: Failed to install build dependencies.
    if not defined CI pause
    exit /b 1
)
python -m pip install pystray Pillow -q

REM --- 2. Pre-download HF embedding/reranker models -------------------------
if "%MINIMAL_ONLY%"=="1" (
    echo [2/6] Skipping bundled ML models for minimal build.
) else (
    if not exist "packaging\models" (
        echo [2/6] Downloading ML models - one-time, about 1.5 GB...
        python packaging\download_models.py
        if errorlevel 1 (
            echo ERROR: Model download failed.
            if not defined CI pause
            exit /b 1
        )
    ) else (
        echo [2/6] ML models already present -- skipping download.
    )
)

REM --- 3. Download Ollama binary + pre-pull qwen2.5:3b ---------------------
if "%MINIMAL_ONLY%"=="1" (
    echo [3/6] Skipping bundled Ollama for minimal build.
) else (
    if not exist "packaging\ollama_win\ollama.exe" (
        echo [3/6] Downloading Ollama + qwen2.5:3b model - one-time, about 2 GB...
        call packaging\download_ollama.bat
        if errorlevel 1 (
            echo ERROR: Ollama download failed.
            if not defined CI pause
            exit /b 1
        )
    ) else (
        echo [3/6] Ollama already present -- skipping download.
    )
    if exist "packaging\ollama_models" (
        echo     Removing incomplete Ollama partial blobs before packaging...
        del /s /q "packaging\ollama_models\*partial*" >nul 2>nul
    )
)

REM --- 4. Clean old dist ----------------------------------------------------
echo [4/6] Cleaning previous build artifacts...
if exist "dist\TarCiteWorkspace" (
    rmdir /s /q "dist\TarCiteWorkspace" >nul 2>nul
)
if exist "dist\minimal" (
    rmdir /s /q "dist\minimal" >nul 2>nul
)

REM --- 5. Run PyInstaller ---------------------------------------------------
echo [5/6] Running PyInstaller...
pyinstaller citation.spec --clean --noconfirm
if errorlevel 1 (
    echo ERROR: PyInstaller failed.
    if not defined CI pause
    exit /b 1
)
if exist "dist\TarCiteWorkspace\_internal\ollama_models" (
    echo     Removing incomplete Ollama partial blobs from app bundle...
    del /s /q "dist\TarCiteWorkspace\_internal\ollama_models\*partial*" >nul 2>nul
)
if exist "dist\TarCiteWorkspace\ollama_models" (
    echo     Removing incomplete Ollama partial blobs from app bundle...
    del /s /q "dist\TarCiteWorkspace\ollama_models\*partial*" >nul 2>nul
)

REM Remove deeply nested torch licenses to prevent MAX_PATH errors in Inno Setup
echo     Removing deeply nested torch licenses...
for /d %%D in ("dist\TarCiteWorkspace\_internal\torch*dist-info") do (
    if exist "%%D\licenses" rmdir /s /q "%%D\licenses"
)

REM --- 6. Create installer with Inno Setup ----------------------------------
echo [6/6] Creating Windows installer...
where iscc >nul 2>nul
if %errorlevel% neq 0 (
    echo WARNING: Inno Setup not found. Download from https://jrsoftware.org/isinfo.php
    echo The app folder is ready at: dist\TarCiteWorkspace\
    if not defined CI pause
    exit /b 1
)

REM Full installer
iscc packaging\setup.iss
if errorlevel 1 (
    echo WARNING: Inno Setup failed for full build.
    if not defined CI pause
    exit /b 1
)

echo.
echo === Full installer created: %FULL_EXE% ===

REM --- 7. Optional: sign the installer --------------------------------------
if "%SIGNTOOL%"=="1" (
    echo.
    echo --- Attempting to sign installer ---
    where signtool >nul 2>nul
    if %errorlevel% equ 0 (
        signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td sha256 /a "%FULL_EXE%"
        if errorlevel 1 (
            echo WARNING: Signing failed. Make sure a code signing certificate is installed.
        ) else (
            echo Installer signed successfully.
        )
    ) else (
        echo WARNING: signtool.exe not found. Install Windows SDK to enable signing.
    )
) else (
    echo.
    echo NOTE: Installer is NOT signed. Windows SmartScreen will show "Unknown publisher".
    echo To add signing, set SIGNTOOL=1 and install a code signing certificate.
)

REM --- 8. Create MINIMAL installer (always, from the full build) ------------
echo.
echo === Building MINIMAL version (no bundled models) ===
set "MINIMAL_STAGE=dist\min_stage"

if exist "dist\min_stage" rmdir /s /q "dist\min_stage"
mkdir "dist\min_stage"
xcopy /E /I /Q "dist\TarCiteWorkspace" "%MINIMAL_STAGE%"

REM Strip models
if exist "%MINIMAL_STAGE%\models"                 rmdir /s /q "%MINIMAL_STAGE%\models"
if exist "%MINIMAL_STAGE%\ollama_models"           rmdir /s /q "%MINIMAL_STAGE%\ollama_models"
if exist "%MINIMAL_STAGE%\_internal\models"        rmdir /s /q "%MINIMAL_STAGE%\_internal\models"
if exist "%MINIMAL_STAGE%\_internal\ollama_models" rmdir /s /q "%MINIMAL_STAGE%\_internal\ollama_models"
echo     Models stripped from minimal build.

iscc packaging\setup.iss /DSrcDir="..\dist\min_stage" /DOutputBase="TarCiteWorkspace_minimal-Setup_%FILE_VER%"
if errorlevel 1 (
    echo WARNING: Inno Setup failed for minimal build.
) else (
    echo === Minimal installer created: %MINIMAL_EXE% ===
)

if "%SIGNTOOL%"=="1" (
    where signtool >nul 2>nul
    if %errorlevel% equ 0 (
        signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td sha256 /a "%MINIMAL_EXE%" >nul 2>&1
        if errorlevel 0 echo Minimal installer signed successfully.
    )
)

echo.
echo === BUILD COMPLETE ===
echo Full installer    : %cd%\%FULL_EXE%
echo Minimal installer : %cd%\%MINIMAL_EXE%
echo.
echo Next steps:
echo 1. Test the installer on a clean Windows machine (or VM).
echo 2. If you have a code signing certificate, run: set SIGNTOOL=1 ^&^& packaging\build_windows.bat
echo 3. Upload dist\*.exe to your release channel.

if not defined CI pause
endlocal

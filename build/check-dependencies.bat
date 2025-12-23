@echo off
REM Check if Python and dependencies are correctly set up

echo ======================================
echo Starlink Dashboard - Dependency Check
echo ======================================
echo.

REM Check Python
echo [1/3] Checking Python installation...
python --version >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Python is not installed or not in PATH
    echo.
    echo Please install Python from: https://www.python.org/downloads/
    echo Make sure to check "Add Python to PATH" during installation.
    goto end
) else (
    python --version
    echo [OK] Python is installed
)
echo.

REM Check pip
echo [2/3] Checking pip...
python -m pip --version >nul 2>&1
if errorlevel 1 (
    echo [FAIL] pip is not available
    goto end
) else (
    echo [OK] pip is available
)
echo.

REM Check required packages
echo [3/3] Checking required Python packages...
echo.

python -c "import starlink_client" >nul 2>&1
if errorlevel 1 (
    echo [FAIL] starlink-client is NOT installed
    set MISSING=1
) else (
    echo [OK] starlink-client
)

python -c "import fastapi" >nul 2>&1
if errorlevel 1 (
    echo [FAIL] fastapi is NOT installed
    set MISSING=1
) else (
    echo [OK] fastapi
)

python -c "import uvicorn" >nul 2>&1
if errorlevel 1 (
    echo [FAIL] uvicorn is NOT installed
    set MISSING=1
) else (
    echo [OK] uvicorn
)

echo.
if defined MISSING (
    echo ======================================
    echo Some packages are MISSING!
    echo ======================================
    echo.
    echo Would you like to install them now?
    echo.
    choice /C YN /M "Install missing packages"
    if errorlevel 2 goto end
    if errorlevel 1 (
        echo.
        echo Installing packages...
        python -m pip install starlink-client fastapi uvicorn
        echo.
        echo Installation complete!
    )
) else (
    echo ======================================
    echo All dependencies are installed!
    echo ======================================
    echo.
    echo Your Starlink Dashboard should work properly.
)

:end
echo.
pause

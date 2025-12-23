@echo off
REM Post-installation script for Starlink Dashboard
REM This installs the required Python dependencies

echo ======================================
echo Starlink Dashboard - Setup
echo ======================================
echo.
echo This script will install the required Python packages.
echo.

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH!
    echo.
    echo Please install Python 3.7 or later from:
    echo https://www.python.org/downloads/
    echo.
    echo Make sure to check "Add Python to PATH" during installation.
    echo.
    pause
    exit /b 1
)

echo Python is installed:
python --version
echo.

REM Get the installation directory (where this script is located)
set INSTALL_DIR=%~dp0

echo Installing Python dependencies from: %INSTALL_DIR%resources\requirements.txt
echo.

REM Install requirements
python -m pip install -r "%INSTALL_DIR%resources\requirements.txt"

if errorlevel 1 (
    echo.
    echo ERROR: Failed to install Python dependencies!
    echo.
    echo You may need to run this script as Administrator.
    echo.
    pause
    exit /b 1
)

echo.
echo ======================================
echo Setup completed successfully!
echo ======================================
echo.
echo The Starlink Dashboard is now ready to use.
echo You can find it in your Start Menu or Desktop.
echo.
pause

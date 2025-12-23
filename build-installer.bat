@echo off
REM Build script for Starlink Dashboard Windows Installer
REM This will create an .exe installer in the dist folder

echo ======================================
echo Starlink Dashboard - Build Installer
echo ======================================
echo.
echo NOTE: If the build fails due to symbolic link errors,
echo you have two options:
echo 1. Run this script as Administrator (Right-click ^> Run as Administrator)
echo 2. Enable Developer Mode in Windows Settings
echo.

REM Check if node_modules exists
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo Error: Failed to install dependencies
        pause
        exit /b 1
    )
)

echo.
echo Building installer...
echo This may take a few minutes...
echo.

REM Build the installer
call npm run dist

if errorlevel 1 (
    echo.
    echo ======================================
    echo Build failed!
    echo ======================================
    echo.
    echo The build failed, most likely due to Windows permissions.
    echo.
    echo SOLUTION: Please do ONE of the following:
    echo.
    echo Option 1 (Recommended): Run as Administrator
    echo   - Right-click on build-installer.bat
    echo   - Select "Run as administrator"
    echo.
    echo Option 2: Enable Windows Developer Mode
    echo   - Open Settings ^> Privacy ^& Security ^> For developers
    echo   - Turn ON "Developer Mode"
    echo   - Restart this script
    echo.
    pause
    exit /b 1
)

echo.
echo ======================================
echo Build completed successfully!
echo ======================================
echo.
echo The installer is located in the 'dist' folder:
dir /b dist\*.exe 2>nul

if exist "dist\Starlink Dashboard Setup*.exe" (
    echo.
    echo You can now share this installer with your friends!
)

echo.
pause

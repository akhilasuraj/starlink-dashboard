# Build script for Starlink Dashboard - Runs with Administrator privileges
# This script will automatically request admin access to allow symbolic link creation

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "Starlink Dashboard - Build Installer" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Check if running as administrator
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "Requesting Administrator privileges..." -ForegroundColor Yellow
    Write-Host "Please click 'Yes' in the UAC prompt to continue." -ForegroundColor Yellow
    Write-Host ""
    
    # Restart script with admin privileges
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

Write-Host "Running with Administrator privileges" -ForegroundColor Green
Write-Host ""

# Change to script directory
Set-Location $PSScriptRoot

# Check if node_modules exists
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Error: Failed to install dependencies" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

Write-Host ""
Write-Host "Building installer..." -ForegroundColor Yellow
Write-Host "This may take a few minutes..." -ForegroundColor Yellow
Write-Host ""

# Build the installer
npm run dist

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "======================================" -ForegroundColor Green
    Write-Host "Build completed successfully!" -ForegroundColor Green
    Write-Host "======================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "The installer is located in the 'dist' folder:" -ForegroundColor Green
    
    $installers = Get-ChildItem -Path "dist" -Filter "*.exe" -ErrorAction SilentlyContinue
    foreach ($installer in $installers) {
        Write-Host "  - $($installer.Name)" -ForegroundColor Cyan
    }
    
    Write-Host ""
    Write-Host "You can now share this installer with your friends!" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "======================================" -ForegroundColor Red
    Write-Host "Build failed!" -ForegroundColor Red
    Write-Host "======================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please check the error messages above." -ForegroundColor Yellow
}

Write-Host ""
Read-Host "Press Enter to exit"

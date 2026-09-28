# Compatibility wrapper: builds the self-contained installer without changing privileges.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path -LiteralPath ".venv\Scripts\python.exe")) {
    throw "Create the Python 3.13 virtual environment and install requirements-build.txt first. See README.md."
}
npm run build:win
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

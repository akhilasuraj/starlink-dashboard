param([string]$InstallerPath, [string]$NodePath, [string]$ReportPath)
$ErrorActionPreference = "Stop"
if ($env:GITHUB_ACTIONS -ne "true" -or $env:RUNNER_ENVIRONMENT -ne "github-hosted" -or
    $env:RUNNER_OS -ne "Windows" -or $env:STARLINK_DISPOSABLE_INSTALL_SMOKE -ne "1") {
    throw "This test requires a disposable GitHub-hosted Windows runner; ordinary local execution is refused."
}

$workspace = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
$temporaryRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$node = (Resolve-Path -LiteralPath $NodePath).Path
$installRoot = Join-Path $temporaryRoot ("Starlink offline install " + [guid]::NewGuid().ToString())
$installRoot = [IO.Path]::GetFullPath($installRoot)
if (-not $installRoot.StartsWith($temporaryRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Install target escaped the disposable runner temp directory"
}
$startupKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$startupNames = @("com.starlink.dashboard", "StarlinkDashboard")
foreach ($name in $startupNames) {
    if (Get-ItemProperty -LiteralPath $startupKey -Name $name -ErrorAction SilentlyContinue) {
        throw "Disposable runner already has a Starlink startup entry"
    }
}
$oldEnvironment = @{}
foreach ($name in @('PATH','PYTHONPATH','PYTHONHOME','DESKTOP_EXE','COLLECTOR_EXE','ELECTRON_RUN_AS_NODE')) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
$adapters = @(Get-NetAdapter -IncludeHidden | Where-Object Status -eq 'Up')
if ($adapters.Count -eq 0) { throw "No connected adapters to prove offline isolation" }
$report = [ordered]@{ schema_version = 1; passed = $false; tested_sha = $env:GITHUB_SHA;
    run_id = $env:GITHUB_RUN_ID; installer_sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLower();
    disabled_adapter_count = 0; connected_adapters_remaining = -1; network_disabled = $false;
    python_on_path = $true; installed_app_smoke = $false; collector_smoke = $false;
    startup_opt_in_unchanged = $false; network_restored = $false }
$disabled = @()
try {
    foreach ($adapter in $adapters) {
        # Remember the adapter before mutation so even a partial failure restores it.
        $disabled += $adapter.InterfaceIndex
        $adapter | Disable-NetAdapter -Confirm:$false
    }
    $remaining = @(Get-NetAdapter -IncludeHidden | Where-Object Status -eq 'Up')
    if ($remaining.Count -ne 0) { throw "Network adapter remains connected" }
    foreach ($index in $disabled) {
        if ((Get-NetAdapter -IncludeHidden | Where-Object InterfaceIndex -eq $index).Status -ne 'Disabled') {
            throw "Adapter disablement was not confirmed"
        }
    }
    $report.disabled_adapter_count = $disabled.Count
    $report.connected_adapters_remaining = 0
    $report.network_disabled = $true
    $env:PATH = Join-Path $env:SystemRoot 'System32'
    Remove-Item Env:PYTHONPATH,Env:PYTHONHOME,Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    if (Get-Command python,python3,py,pip,pip3 -ErrorAction SilentlyContinue) { throw "Python remains on PATH" }
    $report.python_on_path = $false
    # NSIS /D must be the final, unquoted argument, including a path with spaces.
    $install = Start-Process -FilePath $installer -ArgumentList "/S /D=$installRoot" -WindowStyle Hidden -PassThru
    if (-not $install.WaitForExit(90000)) { $install.Kill(); throw "Installer timed out" }
    if ($install.ExitCode -ne 0) { throw "Installer exited $($install.ExitCode)" }
    if (@(Get-NetAdapter -IncludeHidden | Where-Object Status -eq 'Up').Count -ne 0) {
        throw "Network isolation changed during setup"
    }
    $env:DESKTOP_EXE = Join-Path $installRoot 'Starlink Dashboard.exe'
    $env:COLLECTOR_EXE = Join-Path $installRoot 'resources\collector\starlink-collector.exe'
    if (-not (Test-Path -LiteralPath $env:DESKTOP_EXE) -or -not (Test-Path -LiteralPath $env:COLLECTOR_EXE)) {
        throw "Installed desktop or bundled collector missing"
    }
    & $node (Join-Path $workspace 'tests\packaged-app-smoke.js')
    if ($LASTEXITCODE -ne 0) { throw "Installed app smoke failed" }
    $report.installed_app_smoke = $true
    & $node --test (Join-Path $workspace 'tests\packaged-collector.test.js')
    if ($LASTEXITCODE -ne 0) { throw "Installed collector smoke failed" }
    $report.collector_smoke = $true
    foreach ($name in $startupNames) {
        if (Get-ItemProperty -LiteralPath $startupKey -Name $name -ErrorAction SilentlyContinue) {
            throw "Installer or app enabled startup without consent"
        }
    }
    $report.startup_opt_in_unchanged = $true
} finally {
    # Restore connectivity first, even if installer/app verification failed.
    $restoreErrors = @()
    foreach ($index in $disabled) {
        try {
            Get-NetAdapter -IncludeHidden | Where-Object InterfaceIndex -eq $index | Enable-NetAdapter -Confirm:$false
        } catch { $restoreErrors += $_ }
    }
    foreach ($name in $oldEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name]) }
    $restoreDeadline = [DateTime]::UtcNow.AddSeconds(30)
    $restored = @()
    do {
        try {
            $restored = @(Get-NetAdapter -IncludeHidden |
                Where-Object { $_.InterfaceIndex -in $disabled -and $_.Status -eq 'Up' })
        } catch { $restoreErrors += $_; break }
        if ($restored.Count -eq $disabled.Count) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $restoreDeadline)
    $report.restored_up_adapter_count = $restored.Count
    $report.network_restored = $restoreErrors.Count -eq 0 -and $restored.Count -eq $disabled.Count
    try {
        $uninstaller = Join-Path $installRoot 'Uninstall Starlink Dashboard.exe'
        if (Test-Path -LiteralPath $uninstaller) {
            $uninstall = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$installRoot" -WindowStyle Hidden -PassThru
            if (-not $uninstall.WaitForExit(30000)) { $uninstall.Kill(); throw "Uninstaller timed out" }
        }
    } finally {
        if (Test-Path -LiteralPath $installRoot) {
            $resolved = [IO.Path]::GetFullPath($installRoot)
            if (-not $resolved.StartsWith($temporaryRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw "Cleanup target escaped disposable directory"
            }
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
        $report.passed = $report.network_restored -and $report.installed_app_smoke -and
            $report.collector_smoke -and $report.startup_opt_in_unchanged
        $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ReportPath
    }
}
if (-not $report.passed) { throw "Offline installed-artifact verification incomplete" }

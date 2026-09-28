param([string]$BootstrapPath, [string]$InstallerPath, [string]$NodePath, [string]$ReportPath)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows' -or $env:STARLINK_DISPOSABLE_UPDATE_SMOKE -ne '1') {
    throw 'This test requires a disposable GitHub-hosted Windows runner; ordinary local execution is refused.'
}
$temporaryRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
$installRoot = [IO.Path]::GetFullPath((Join-Path $temporaryRoot ('Starlink update install ' + [guid]::NewGuid())))
$dataRoot = [IO.Path]::GetFullPath((Join-Path $temporaryRoot ('Starlink update history ' + [guid]::NewGuid())))
$historyRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Starlink Dashboard'))
$localRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
if (-not $historyRoot.StartsWith($localRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $historyRoot)) {
    throw 'Disposable runner default history directory must be unused before the update test'
}
function Assert-DisposablePath([string]$Target) {
    if (-not [IO.Path]::GetFullPath($Target).StartsWith($temporaryRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Install or cleanup target escaped the disposable runner temp directory'
    }
}
Assert-DisposablePath $installRoot
Assert-DisposablePath $dataRoot
$bootstrap = (Resolve-Path -LiteralPath $BootstrapPath).Path
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$node = (Resolve-Path -LiteralPath $NodePath).Path
$startupKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startupNames = @('com.starlink.dashboard', 'StarlinkDashboard')
function Assert-NoStartup {
    foreach ($name in $startupNames) {
        if (Get-ItemProperty -LiteralPath $startupKey -Name $name -ErrorAction SilentlyContinue) {
            throw 'An update changed the default opt-in startup setting'
        }
    }
}
Assert-NoStartup
$oldEnvironment = @{}
foreach ($name in @('STARLINK_UPDATE_INSTALL_ROOT','STARLINK_UPDATE_DATA_ROOT','STARLINK_UPDATE_INSTALLER',
    'STARLINK_UPDATE_BOOTSTRAP','STARLINK_UPDATE_REPORT','STARLINK_UPDATE_HISTORY_ROOT',
    'STARLINK_DASHBOARD_DATA_DIR','ELECTRON_RUN_AS_NODE')) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
try {
    New-Item -ItemType Directory -Path $dataRoot | Out-Null
    $install = Start-Process -FilePath $bootstrap -ArgumentList "/S /D=$installRoot" -WindowStyle Hidden -PassThru
    if (-not $install.WaitForExit(90000)) { $install.Kill(); throw 'Bootstrap installer timed out' }
    if ($install.ExitCode -ne 0) { throw "Bootstrap installer exited $($install.ExitCode)" }
    Assert-NoStartup
    $env:STARLINK_UPDATE_INSTALL_ROOT = $installRoot
    $env:STARLINK_UPDATE_DATA_ROOT = $dataRoot
    $env:STARLINK_UPDATE_INSTALLER = $installer
    $env:STARLINK_UPDATE_BOOTSTRAP = $bootstrap
    $env:STARLINK_UPDATE_REPORT = [IO.Path]::GetFullPath($ReportPath)
    $env:STARLINK_UPDATE_HISTORY_ROOT = $historyRoot
    Remove-Item Env:ELECTRON_RUN_AS_NODE,Env:STARLINK_DASHBOARD_DATA_DIR -ErrorAction SilentlyContinue
    & $node (Join-Path $env:GITHUB_WORKSPACE 'tests/installed-update-smoke.js')
    if ($LASTEXITCODE -ne 0) { throw 'Installed update verification failed' }
    $report = Get-Content -LiteralPath $env:STARLINK_UPDATE_REPORT -Raw | ConvertFrom-Json
    $startup = Get-ItemPropertyValue -LiteralPath $startupKey -Name 'com.starlink.dashboard'
    if (-not $startup.Contains((Join-Path $installRoot 'Starlink Dashboard.exe')) -or
        -not $startup.Contains('--hidden') -or $report.startup_enabled_after_update -ne $true) {
        throw 'Updater did not retain the explicitly enabled startup preference'
    }
    $report.startup_opt_in_unchanged = $true
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $env:STARLINK_UPDATE_REPORT
} finally {
    # Only executable paths below this test's checked installation can be stopped.
    Assert-DisposablePath $installRoot
    $ownedProcesses = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)
    })
    $ownedProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $ownedProcesses | ForEach-Object { Wait-Process -Id $_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }
    try {
        $uninstaller = Join-Path $installRoot 'Uninstall Starlink Dashboard.exe'
        if (Test-Path -LiteralPath $uninstaller) {
            $uninstall = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$installRoot" -WindowStyle Hidden -PassThru
            if (-not $uninstall.WaitForExit(30000)) { $uninstall.Kill(); throw 'Uninstaller timed out' }
            if ($uninstall.ExitCode -ne 0) { throw 'Uninstaller failed' }
            Assert-NoStartup
        }
    } finally {
        foreach ($target in @($installRoot, $dataRoot)) {
            Assert-DisposablePath $target
            if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        }
        # This exact default directory was checked absent before the test created it.
        $resolvedHistory = [IO.Path]::GetFullPath($historyRoot)
        if ($resolvedHistory -ne [IO.Path]::GetFullPath((Join-Path $localRoot 'Starlink Dashboard'))) {
            throw 'Default history cleanup target differs from the checked disposable location'
        }
        if (Test-Path -LiteralPath $resolvedHistory) { Remove-Item -LiteralPath $resolvedHistory -Recurse -Force }
        foreach ($name in $oldEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name]) }
    }
}

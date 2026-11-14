param(
    [string]$DshPath = '',
    [Alias('Profile')][string]$DshProfile = 'web',
    [string]$DshHome = '',
    [string]$DataDir = '',
    [int]$Port = 8765,
    [string]$Python = 'python',
    [string]$Token = '',
    [switch]$Demo
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LineBreak = [Environment]::NewLine
Push-Location $ProjectRoot
$PreviousInstallToken = $env:TEAMHUB_INSTALL_TOKEN
try {
    if ($DshProfile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Invalid profile name.' }
    if (-not $DshPath) {
        $ResolvedDsh = Get-Command dsh.cmd -ErrorAction SilentlyContinue
        if (-not $ResolvedDsh) { throw 'dsh.cmd is not on PATH. Supply -DshPath with the exact existing DSH launcher.' }
        $DshPath = $ResolvedDsh.Source
    }
    $DshPath = (Resolve-Path -LiteralPath $DshPath).Path
    if (-not $DshHome) { $DshHome = $env:DSH_HOME }
    if (-not $DshHome) { $DshHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
    if (-not [IO.Path]::IsPathRooted($DshHome)) { $DshHome = Join-Path $ProjectRoot $DshHome }
    $DshHome = [IO.Path]::GetFullPath($DshHome)
    $DshProfileManifest = Join-Path $DshHome "profiles\$DshProfile\package.json"
    if (-not (Test-Path -LiteralPath $DshProfileManifest)) {
        throw "Existing profile was not found at $DshProfileManifest. Specify -DshHome and -Profile; no profile will be created."
    }
    $env:DSH_HOME = $DshHome
    $DshVersionOutput = @(& $DshPath --version 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'The selected DSH launcher failed its version check.' }
    $DshVersionMatch = [regex]::Match(($DshVersionOutput -join $LineBreak), '(?m)^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$')
    if (-not $DshVersionMatch.Success) { throw 'Could not determine the selected DSH version.' }
    $DshVersion = $DshVersionMatch.Groups[1].Value
    $PluginManifest = Get-Content packages/dsh-plugin/package.json -Raw | ConvertFrom-Json
    $SupportedVersions = @($PluginManifest.engines.dsh -split '\s*\|\|\s*')
    if ($SupportedVersions -notcontains $DshVersion) {
        throw "Plugin requires DSH $($PluginManifest.engines.dsh); selected DSH is $DshVersion. This installer will not upgrade DSH."
    }
    $NodeOutput = @(& node --version 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Node.js is unavailable.' }
    $NodeVersion = ($NodeOutput -join '').Trim().TrimStart('v')
    if ([version]$NodeVersion -lt [version]'24.9.0') { throw 'Node.js 24.9+ is required by DSH.' }
    if (-not (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)) {
        throw 'DSH plugin management requires pnpm on PATH. Install pnpm for this existing DSH environment, then rerun.'
    }
    $Tarball = Join-Path $ProjectRoot "packages\dsh-plugin\dist\dsh-team-hub-$($PluginManifest.version).tgz"
    if (-not (Test-Path -LiteralPath $Tarball)) { throw 'Plugin tarball is missing. Use the complete release ZIP, or run npm pack in packages/dsh-plugin.' }
    if (-not (Test-Path 'web\dist\index.html')) { throw 'Prebuilt web assets are missing. Build web first or use the complete release ZIP.' }
    if (-not $DataDir) { $DataDir = if ($Demo) { '.teamhub-demo' } else { '.teamhub' } }
    if (-not [IO.Path]::IsPathRooted($DataDir)) { $DataDir = Join-Path $ProjectRoot $DataDir }
    $DataDir = [IO.Path]::GetFullPath($DataDir)
    Write-Host "Target DSH: $DshPath ($DshVersion)"
    Write-Host "Existing profile: $DshProfile"
    Write-Host "Hub data: $DataDir"
    $VersionCheckPython = $Python
    if (Test-Path '.venv\Scripts\python.exe') { $VersionCheckPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe' }
    & $VersionCheckPython -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.11+ is required. Select it with -Python, or recreate an older project virtual environment.' }
    if (-not (Test-Path '.venv\Scripts\python.exe')) {
        & $Python -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Python 3.11+ is required; virtual environment creation failed.' }
    }
    $EnvPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
    & $EnvPython -m pip install -c constraints-tested.txt -e '.[mcp]'
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
    $Helper = Join-Path $PSScriptRoot 'install_support.py'
    if ($Token) { $env:TEAMHUB_INSTALL_TOKEN = $Token }
    $PrepareArgs = @($Helper, 'prepare', '--data-dir', $DataDir, '--port', "$Port")
    if ($Demo) { $PrepareArgs += '--demo' }
    $PrepareOutput = @(& $EnvPython @PrepareArgs)
    if ($LASTEXITCODE -ne 0) { throw 'Workspace preparation failed. Existing identities were not reset.' }
    $Prepared = ($PrepareOutput -join $LineBreak) | ConvertFrom-Json
    $StartOutput = @(& $EnvPython $Helper start --data-dir $DataDir --port $Port)
    if ($LASTEXITCODE -ne 0) { throw 'Hub startup or identity check failed.' }
    $Service = ($StartOutput -join $LineBreak) | ConvertFrom-Json
    & $DshPath plugin --profile $DshProfile add $Tarball
    if ($LASTEXITCODE -ne 0) { throw 'DSH plugin installation failed. Hub may still be running; inspect the command output.' }
    $EnvOutput = @(& $EnvPython $Helper configure-env --data-dir $DataDir --dsh-home $DshHome)
    if ($LASTEXITCODE -ne 0) { throw 'Plugin package installed, but DSH environment setup failed.' }
    $EnvironmentResult = ($EnvOutput -join $LineBreak) | ConvertFrom-Json
    $Connection = Get-Content -LiteralPath $Prepared.connection_file -Raw | ConvertFrom-Json
    $env:TEAMHUB_URL = $Connection.url
    $env:TEAMHUB_TOKEN = $Connection.token
    $ConfigOutput = @(& $DshPath --profile $DshProfile --dump-config 2>&1)
    if ($LASTEXITCODE -ne 0 -or ($ConfigOutput -join $LineBreak) -notmatch 'dsh-team-hub') {
        throw 'Package installed, but composed DSH configuration could not be verified. No existing DSH process was restarted.'
    }
    $Report = [ordered]@{
        dsh_path = $DshPath; dsh_version = $DshVersion; profile = $DshProfile
        dsh_home = $DshHome; node_version = $NodeVersion; plugin_version = $PluginManifest.version
        hub_url = $Prepared.url; hub_data = $DataDir; service = $Service.service
        package_installed = $true; config_verified = $true
        runtime_tool_verified = $false; restart_existing_profile_required = $true
    }
    $ReportPath = Join-Path $DataDir 'install-report.json'
    $Report | ConvertTo-Json | Set-Content -LiteralPath $ReportPath -Encoding UTF8
    Write-Host "Installed dsh-team-hub into profile '$DshProfile'. Hub: $($Prepared.url)"
    Write-Host "Report: $ReportPath"
    Write-Host "Restart this existing DSH profile when ready, then call teamhub_status to verify runtime tools."
    Write-Host 'Existing DSH processes were left running. No Superagent source was modified.'
} finally {
    $env:TEAMHUB_INSTALL_TOKEN = $PreviousInstallToken
    $Token = ''; $Connection = $null
    Pop-Location
}

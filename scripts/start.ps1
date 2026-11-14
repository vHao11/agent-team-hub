param(
    [switch]$Demo,
    [int]$Port = 8765,
    [string]$DataDir = '',
    [string]$ListenAddress = '127.0.0.1',
    [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
if (-not $DataDir) {
    $DataDir = if ($Demo) { '.teamhub-demo' } else { '.teamhub' }
}
if (-not (Test-Path '.venv\Scripts\python.exe')) {
    & $Python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python venv creation failed. Python 3.11+ is required.' }
}
$EnvPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
& $EnvPython -m pip install -c constraints-tested.txt -e '.[mcp]'
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
if (-not (Test-Path 'web\dist\index.html')) {
    Push-Location web
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Node.js 22+ is required.' }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    } finally { Pop-Location }
}
if (-not $Demo -and -not (Test-Path (Join-Path $DataDir 'teamhub.db'))) {
    & $EnvPython -m teamhub init --data-dir $DataDir
    if ($LASTEXITCODE -ne 0) { throw 'Workspace initialization failed.' }
}
$ServeArgs = @('-m', 'teamhub', 'serve', '--data-dir', $DataDir, '--port', "$Port", '--host', $ListenAddress)
if ($Demo) { $ServeArgs += '--demo' }
& $EnvPython @ServeArgs
exit $LASTEXITCODE

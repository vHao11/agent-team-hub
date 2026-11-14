param(
  [Parameter(Mandatory=$true)][string]$TeamHubHome,
  [string]$PythonPath = '',
  [string]$DataDir = '',
  [int]$Port = 8765,
  [switch]$Demo
)

$ErrorActionPreference = 'Stop'
$base = (Resolve-Path -LiteralPath $TeamHubHome).ProviderPath
$python = if ($PythonPath) { (Resolve-Path -LiteralPath $PythonPath).ProviderPath } else { Join-Path $base '.venv-release-0.2.0\Scripts\python.exe' }
$data = if ($DataDir) { [IO.Path]::GetFullPath($DataDir) } else { Join-Path $base 'data' }
$productionData = [IO.Path]::GetFullPath((Join-Path $base 'data'))
$logs = Join-Path $base 'logs'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Team Hub 候选 Python 环境不存在。' }
$version = & $python -c "import teamhub; print(teamhub.__version__)"
if ($LASTEXITCODE -ne 0 -or ($version | Select-Object -Last 1) -ne '0.2.0') { throw 'Team Hub 候选环境版本不匹配，未启动。' }
if ($Port -lt 1 -or $Port -gt 65535) { throw '端口无效。' }
if ($Demo -and $data -ieq $productionData) { throw '演示模式不能使用正式数据目录。' }
if (-not $Demo -and -not (Test-Path -LiteralPath (Join-Path $data 'teamhub.db') -PathType Leaf)) { throw 'Team Hub 工作空间不存在。' }
if (@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Port }).Count -ne 0) { throw 'Team Hub 端口仍被占用，未启动候选服务。' }
if (-not (Test-Path -LiteralPath $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
$env:PYTHONUTF8 = '1'
Set-Location -LiteralPath $base
$serveArgs = @('-m', 'teamhub', 'serve', '--data-dir', $data, '--host', '127.0.0.1', '--port', [string]$Port)
if ($Demo) { $serveArgs += '--demo' }
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & $python @serveArgs *>> (Join-Path $logs 'service-stage2.log')
  $exitCode = $LASTEXITCODE
} finally { $ErrorActionPreference = $previousErrorAction }
if ($exitCode -ne 0) { throw ('Team Hub 候选服务异常退出，退出码：' + $exitCode) }

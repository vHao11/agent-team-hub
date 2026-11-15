param(
  [Parameter(Mandatory=$true)][string]$MachineFile,
  [Parameter(Mandatory=$true)][string]$TeamHubHome,
  [string]$PackageFile = '',
  [string]$ProxyUrl = ''
)

$ErrorActionPreference = 'Stop'
function Get-FileSha256([string]$Path) {
  $hash = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
  finally { $stream.Dispose(); $hash.Dispose() }
}
$root = Split-Path -Parent $PSScriptRoot
$machinePath = (Resolve-Path -LiteralPath $MachineFile).ProviderPath
$base = (Resolve-Path -LiteralPath $TeamHubHome).ProviderPath
$machine = Get-Content -LiteralPath $machinePath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $machine.workbenchRoot -or -not $machine.dshHome -or -not $machine.nodeExe -or -not $machine.profile) {
  throw '本机工作台配置不完整，未修改 DSH。'
}
$workbench = (Resolve-Path -LiteralPath $machine.workbenchRoot).ProviderPath
$expectedMachine = (Resolve-Path -LiteralPath (Join-Path $workbench 'machine.local.json')).ProviderPath
if ($machinePath -ine $expectedMachine) { throw '指定的本机配置不是该工作台的 machine.local.json。' }
$start = Join-Path $workbench 'scripts\start-workbench.ps1'
if (-not (Test-Path -LiteralPath $start -PathType Leaf)) { throw '找不到工作台同步脚本，未修改 DSH。' }
$port = [int]$machine.webPort
if ($port -lt 1 -or $port -gt 65535) { throw 'DSH 端口无效。' }
if (@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $port }).Count -ne 0) {
  throw 'DSH 正在运行，请先使用工作台的正常方式停止它。'
}

# 工作台规则要求先同步且工作区干净；失败时不写入 profile 或本机清单。
$oldHttp = $env:HTTP_PROXY
$oldHttps = $env:HTTPS_PROXY
try {
  if ($ProxyUrl) { $env:HTTP_PROXY = $ProxyUrl; $env:HTTPS_PROXY = $ProxyUrl }
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $start -NonInteractive
  if ($LASTEXITCODE -ne 0) { throw '工作台同步未通过，未修改 DSH。' }
  $updatedMachine = Get-Content -LiteralPath $machinePath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($key in @('workbenchRoot', 'dshHome', 'nodeExe', 'profile', 'webPort')) {
    if ([string]$updatedMachine.$key -ine [string]$machine.$key) { throw '同步后工作台目标发生变化，请重新核对后再运行。' }
  }

  if (-not $PackageFile) { $PackageFile = Join-Path $root 'packages\dsh-web-panel\dist\dsh-team-hub-web-0.1.0.tgz' }
  $packagePath = (Resolve-Path -LiteralPath $PackageFile).ProviderPath
  $dsh = Join-Path (Split-Path -Parent $machine.nodeExe) 'dsh.cmd'
  $version = @(& $dsh --version 2>&1)
  if ($LASTEXITCODE -ne 0 -or ($version -join "`n") -notmatch '(?m)^\s*0\.2\.2-rc\.[12]\s*$') {
    throw '当前 DSH 版本不在页面插件支持范围内，未修改 profile。'
  }
  $persistentPackage = Join-Path $base 'dsh-team-hub-web-0.1.0.tgz'
  $hash = Get-FileSha256 $packagePath
  if (Test-Path -LiteralPath $persistentPackage) {
    if ((Get-FileSha256 $persistentPackage) -ne $hash) {
      throw '已有同名页面插件安装包但内容不同，未覆盖。'
    }
  } else {
    Copy-Item -LiteralPath $packagePath -Destination $persistentPackage
    if ((Get-FileSha256 $persistentPackage) -ne $hash) { throw '页面插件安装包复制校验失败。' }
  }
  & (Join-Path $PSScriptRoot 'upgrade-dsh-profile-stage2.ps1') -MachineFile $machinePath `
    -PackageFile $persistentPackage -TeamHubHome $base -PluginName 'dsh-team-hub-web' `
    -CurrentVersion '0.0.0' -TargetVersion '0.1.0' -ProxyUrl $ProxyUrl
  if (-not $?) { throw '页面插件安装失败。' }
  Write-Output '请启动 Hub 和原来的 DSH profile，然后点击左侧“团队协作台”。'
} finally {
  $env:HTTP_PROXY = $oldHttp
  $env:HTTPS_PROXY = $oldHttps
}

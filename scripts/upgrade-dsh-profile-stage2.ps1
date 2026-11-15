param(
  [Parameter(Mandatory=$true)][string]$MachineFile,
  [Parameter(Mandatory=$true)][string]$PackageFile,
  [Parameter(Mandatory=$true)][string]$TeamHubHome,
  [string]$ProxyUrl = '',
  [string]$CurrentVersion = '0.1.0-workbench.3bd3d820',
  [string]$TargetVersion = '0.2.0',
  [ValidateSet('dsh-team-hub', 'dsh-team-hub-web')][string]$PluginName = 'dsh-team-hub'
)

$ErrorActionPreference = 'Stop'
function Get-FileSha256([string]$Path) {
  $hash = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
  finally { $stream.Dispose(); $hash.Dispose() }
}
$base = (Resolve-Path -LiteralPath $TeamHubHome).ProviderPath
$machinePath = (Resolve-Path -LiteralPath $MachineFile).ProviderPath
$packagePath = (Resolve-Path -LiteralPath $PackageFile).ProviderPath
$machine = Get-Content -LiteralPath $machinePath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $machine.localProfile -or [int]$machine.localProfile.version -ne 1) { throw '缺少本机严格 profile 清单，未安装插件。' }
if ($machine.workbenchRoot) {
  $status = @(& git -C ([string]$machine.workbenchRoot) status --porcelain 2>$null)
  if ($LASTEXITCODE -ne 0 -or $status.Count -ne 0) { throw '工作台状态不干净或无法核验，未安装插件。' }
}
$port = [int]$machine.webPort
if ($port -lt 1 -or $port -gt 65535) { throw 'DSH 端口配置无效。' }
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $port })
if ($listeners.Count -ne 0) { throw 'DSH 仍在运行，未修改 profile。' }

$profileDir = Join-Path (Join-Path $machine.dshHome 'profiles') $machine.profile
$manifestPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw '找不到 DSH profile 清单。' }
$nodeDir = Split-Path -Parent $machine.nodeExe
$dsh = Join-Path $nodeDir 'dsh.cmd'
if (-not (Test-Path -LiteralPath $dsh -PathType Leaf)) { throw '找不到本机 DSH 命令。' }
$name = $PluginName
if ($CurrentVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?$' -or $TargetVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?$') { throw '插件版本格式无效。' }
$expectedVersion = $TargetVersion
if ($name -eq 'dsh-team-hub' -and -not (Test-Path -LiteralPath (Join-Path $base 'admin-token.txt') -PathType Leaf)) { throw '找不到本机 Team Hub 令牌文件。' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$hasBundle = @($manifest.dsh.profile.bundles) -contains $name
$hasDependency = @($manifest.dependencies.PSObject.Properties.Name) -contains $name
$declaredBundle = @($machine.localProfile.localBundles) -contains $name
$declaredDependency = @($machine.localProfile.localDependencies) -contains $name
$installedPath = Join-Path $profileDir (Join-Path 'node_modules' (Join-Path $name 'package.json'))
if ($hasBundle -or $hasDependency -or $declaredBundle -or $declaredDependency) {
  if (-not ($hasBundle -and $hasDependency -and $declaredBundle -and $declaredDependency -and (Test-Path -LiteralPath $installedPath))) { throw '检测到不完整的 Team Hub 配置，未覆盖。' }
  $installed = Get-Content -LiteralPath $installedPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($installed.version -eq $expectedVersion) { Write-Output 'Team Hub 插件已安装，未重复修改。'; exit 0 }
  if ($installed.version -ne $CurrentVersion) { throw '检测到非预期的 Team Hub 版本，未覆盖。' }
}

$backupRoot = Join-Path $base 'profile-backups'
if (-not (Test-Path -LiteralPath $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot | Out-Null }
$backup = Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $backup | Out-Null
$paths = @(
  @{ Name='machine.local.json'; Path=$machinePath },
  @{ Name='package.json'; Path=$manifestPath },
  @{ Name='pnpm-lock.yaml'; Path=(Join-Path $profileDir 'pnpm-lock.yaml') },
  @{ Name='pnpm-workspace.yaml'; Path=(Join-Path $profileDir 'pnpm-workspace.yaml') },
  @{ Name='cordis.patch.yml'; Path=(Join-Path $profileDir 'cordis.patch.yml') },
  @{ Name='cordis.yml'; Path=(Join-Path $profileDir 'cordis.yml') }
)
$saved = @()
foreach ($entry in $paths) {
  if (Test-Path -LiteralPath $entry.Path -PathType Leaf) {
    $target = Join-Path $backup $entry.Name
    Copy-Item -LiteralPath $entry.Path -Destination $target
    if ((Get-FileSha256 $entry.Path) -ne (Get-FileSha256 $target)) { throw '安装前备份校验失败。' }
    $saved += $entry
  }
}
$profileRoot = (Resolve-Path -LiteralPath $profileDir).ProviderPath.TrimEnd('\')
$modulesPath = [IO.Path]::GetFullPath((Join-Path $profileRoot 'node_modules'))
$modulesItem = Get-Item -LiteralPath $modulesPath -ErrorAction Stop
if (-not $modulesItem.PSIsContainer -or ($modulesItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Resolve-Path -LiteralPath $modulesPath).ProviderPath -ine $modulesPath) { throw '无法安全备份现有依赖目录。' }
$nonce = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$modulesBackup = [IO.Path]::GetFullPath((Join-Path $profileRoot ('.teamhub-node-modules-before-' + $nonce)))
$modulesFailed = [IO.Path]::GetFullPath((Join-Path $profileRoot ('.teamhub-node-modules-failed-' + $nonce)))
foreach ($path in @($modulesPath, $modulesBackup, $modulesFailed)) {
  if (-not $path.StartsWith($profileRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '依赖目录不在预期的 profile 内。' }
}
if ((Test-Path -LiteralPath $modulesBackup) -or (Test-Path -LiteralPath $modulesFailed)) { throw '依赖备份目录已存在。' }
$compatPnpm = Join-Path $base 'pnpm-compat\pnpm.cmd'
if (-not (Test-Path -LiteralPath $compatPnpm -PathType Leaf)) { throw '缺少 pnpm 兼容入口。' }
$modulesPreserved = $false
$oldEnv = @{}
foreach ($key in @('DSH_HOME','PATH','HTTP_PROXY','HTTPS_PROXY')) { $oldEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
$log = Join-Path $backup 'install.log'
$changed = $false
$temporary = $null
$replaceBackup = $null
try {
  $env:DSH_HOME = [string]$machine.dshHome
  $env:PATH = $nodeDir + ';' + $oldEnv.PATH
  if ($ProxyUrl) { $env:HTTP_PROXY = $ProxyUrl; $env:HTTPS_PROXY = $ProxyUrl }
  Move-Item -LiteralPath $modulesPath -Destination $modulesBackup -ErrorAction Stop
  $modulesPreserved = $true
  $changed = $true
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = @(& $dsh plugin --profile ([string]$machine.profile) add $packagePath 2>&1)
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  $output | Out-File -LiteralPath $log -Encoding UTF8
  if ($code -ne 0) { throw ('插件安装失败，退出码：' + $code) }
  $updated = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (@($updated.dsh.profile.bundles) -notcontains $name -or @($updated.dependencies.PSObject.Properties.Name) -notcontains $name -or -not (Test-Path -LiteralPath $installedPath)) { throw '插件安装后清单不完整。' }
  $installed = Get-Content -LiteralPath $installedPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($installed.version -ne $expectedVersion) { throw '安装后的插件版本不正确。' }
  if (@($machine.localProfile.localBundles) -notcontains $name) { $machine.localProfile.localBundles = @($machine.localProfile.localBundles) + @($name) }
  if (@($machine.localProfile.localDependencies) -notcontains $name) { $machine.localProfile.localDependencies = @($machine.localProfile.localDependencies) + @($name) }
  if (-not $machine.pnpmCmd) { $machine | Add-Member -NotePropertyName pnpmCmd -NotePropertyValue $compatPnpm -Force }
  $json = $machine | ConvertTo-Json -Depth 100
  $tempDir = Join-Path (Split-Path -Parent $machinePath) '.workbench'
  if (-not (Test-Path -LiteralPath $tempDir)) { New-Item -ItemType Directory -Path $tempDir | Out-Null }
  $temporary = Join-Path $tempDir ('teamhub-machine-' + [guid]::NewGuid().ToString('N') + '.tmp')
  $replaceBackup = $temporary + '.bak'
  [IO.File]::WriteAllText($temporary, $json + "`n", (New-Object Text.UTF8Encoding($false)))
  [IO.File]::Replace($temporary, $machinePath, $replaceBackup)
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $dump = @(& $dsh --profile ([string]$machine.profile) --dump-config 2>&1)
    $dumpCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($dumpCode -ne 0 -or (($dump -join "`n") -notmatch [regex]::Escape($name))) { throw '安装后 profile 组合验证失败。' }
  Write-Output ('Team Hub 插件已安装，本机备份：' + $backup)
} catch {
  $message = $_.Exception.Message
  if ($changed) {
    try {
      foreach ($entry in $saved) { [IO.File]::Copy((Join-Path $backup $entry.Name), $entry.Path, $true) }
      foreach ($entry in $paths) {
        if (@($saved | Where-Object { $_.Path -eq $entry.Path }).Count -eq 0 -and (Test-Path -LiteralPath $entry.Path -PathType Leaf)) {
          Remove-Item -LiteralPath $entry.Path -Force -ErrorAction Stop
        }
      }
      if ($modulesPreserved) {
        if (Test-Path -LiteralPath $modulesPath) { Move-Item -LiteralPath $modulesPath -Destination $modulesFailed -ErrorAction Stop }
        Move-Item -LiteralPath $modulesBackup -Destination $modulesPath -ErrorAction Stop
      }
    } catch { throw ($message + '；自动回滚未完成，请查看本机备份。') }
  }
  throw ($message + '；已保留本机备份。')
} finally {
  if ($temporary -and (Test-Path -LiteralPath $temporary -PathType Leaf)) { Remove-Item -LiteralPath $temporary }
  if ($replaceBackup -and (Test-Path -LiteralPath $replaceBackup -PathType Leaf)) { Remove-Item -LiteralPath $replaceBackup }
  foreach ($key in $oldEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $oldEnv[$key], 'Process') }
}

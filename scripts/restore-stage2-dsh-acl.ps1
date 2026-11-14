param(
  [Parameter(Mandatory=$true)][string]$Manifest,
  [Parameter(Mandatory=$true)][string]$RuntimeRoot
)

$ErrorActionPreference = 'Stop'
$manifestPath = (Resolve-Path -LiteralPath $Manifest).ProviderPath
$root = (Resolve-Path -LiteralPath $RuntimeRoot).ProviderPath.TrimEnd('\')
$parsed = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$records = @($parsed)
if ($records.Count -eq 0) { throw 'ACL 备份为空，未修改权限。' }
$seen = @{}
foreach ($entry in $records) {
  $path = [IO.Path]::GetFullPath([string]$entry.Path)
  if (-not $path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or $seen.ContainsKey($path.ToLowerInvariant())) { throw '备份包含重复或越界路径，未修改权限。' }
  $seen[$path.ToLowerInvariant()] = $true
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Resolve-Path -LiteralPath $path).ProviderPath -ine $path) { throw 'ACL 目标不是预期的普通路径。' }
  if ((Get-Acl -LiteralPath $path).Sddl -cne [string]$entry.AfterSddl) { throw '目标权限自备份后已变化，未覆盖。' }
}

function Set-AccessSddl([string]$Path, [string]$Sddl) {
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetSecurityDescriptorSddlForm($Sddl, [System.Security.AccessControl.AccessControlSections]::Access)
  Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

$changed = @()
try {
  foreach ($entry in $records) {
    Set-AccessSddl -Path ([string]$entry.Path) -Sddl ([string]$entry.BeforeSddl)
    $changed += $entry
  }
  Write-Output ('已恢复 ' + $changed.Count + ' 项原有 ACL。')
} catch {
  foreach ($entry in $changed) { Set-AccessSddl -Path ([string]$entry.Path) -Sddl ([string]$entry.AfterSddl) }
  throw
}

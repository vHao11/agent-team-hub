param([Parameter(Mandatory=$true)][string]$Specification)
$ErrorActionPreference = 'Stop'
$spec = Get-Content -Raw -LiteralPath $Specification -Encoding UTF8 | ConvertFrom-Json
$source = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'win-job.cs') -Encoding UTF8
Add-Type -TypeDefinition $source -Language CSharp
$code = [TeamHubProcessJob]::Run([string]$spec.binary, [string[]]$spec.args, [string]$spec.cwd,
  [string]$spec.cancel, [string]$spec.result)
exit $code

param([string]$InstallerPath = (Join-Path $PSScriptRoot 'install.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($InstallerPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Move-AgentFleetReleaseDirectory', 'Protect-AgentFleetInvalidRelease')) {
  $fn = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $fn) { throw "Missing $name" }
  Invoke-Expression $fn.Extent.Text
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('fleet-release-' + [Guid]::NewGuid().ToString('N'))
$bin = Join-Path $root 'bin'; $stage = Join-Path $bin 'stage'; $target = Join-Path $bin '1.2.3'
$script:processes = @()
function Get-CimInstance { return $script:processes }
function Assert-Blocked {
  try { Protect-AgentFleetInvalidRelease $target $bin $root; throw 'UNEXPECTED_SUCCESS' }
  catch { if ($_.Exception.Message -eq 'UNEXPECTED_SUCCESS') { throw } }
  if (-not (Test-Path $target)) { throw 'Protected release moved' }
}
try {
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $stage 'node.exe'), 'synthetic executable')
  Move-AgentFleetReleaseDirectory $stage $target
  if ((Test-Path $stage) -or -not (Test-Path (Join-Path $target 'node.exe'))) { throw 'Rename incomplete' }
  # Existing destination must never merge or partially consume the source.
  New-Item -ItemType Directory -Path $stage | Out-Null
  [IO.File]::WriteAllText((Join-Path $stage 'payload'), 'preserve')
  try { Move-AgentFleetReleaseDirectory $stage $target; throw 'UNEXPECTED_SUCCESS' }
  catch { if ($_.Exception.Message -eq 'UNEXPECTED_SUCCESS') { throw } }
  if (-not (Test-Path (Join-Path $stage 'payload'))) { throw 'Source changed on failure' }
  foreach ($pointer in @('current.txt','previous.txt')) {
    [IO.File]::WriteAllText((Join-Path $bin $pointer), '1.2.3')
    Assert-Blocked
    Remove-Item (Join-Path $bin $pointer)
  }
  $script:processes = @(@{ExecutablePath=(Join-Path $target 'node.exe');CommandLine=''})
  Assert-Blocked
  $script:processes = @()
  [IO.File]::WriteAllText((Join-Path $root 'update-state.json'), '{"phase":"verifying","targetVersion":"1.2.3"}')
  Assert-Blocked
  [IO.File]::WriteAllText((Join-Path $root 'update-state.json'), '{"phase":"preparing","targetVersion":"1.2.3"}')
  Protect-AgentFleetInvalidRelease $target $bin $root
  if (Test-Path $target) { throw 'Unused invalid target not quarantined' }
  $saved = @(Get-ChildItem $bin -Directory -Filter '1.2.3.invalid-*')
  if ($saved.Count -ne 1 -or -not (Test-Path (Join-Path $saved[0].FullName 'node.exe'))) { throw 'Invalid release not preserved' }
  # A Windows file lock must never leave a partially populated destination.
  if ($env:OS -eq 'Windows_NT') {
    $lock = [IO.File]::Open((Join-Path $stage 'payload'), 'Open', 'Read', 'None')
    try { try { Move-AgentFleetReleaseDirectory $stage $target } catch {} }
    finally { $lock.Dispose() }
    $sourceExists = Test-Path (Join-Path $stage 'payload')
    $destExists = Test-Path (Join-Path $target 'payload')
    if ($sourceExists -eq $destExists) { throw 'Atomic directory rename lost or duplicated content' }
  }
  Write-Host 'Release directory regression checks passed'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }

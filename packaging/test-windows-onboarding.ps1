param([string]$InstallerPath = (Join-Path $PSScriptRoot 'install.ps1'))
$ErrorActionPreference = 'Stop'
# Parse the real installer but evaluate only its pure argument builder. Never
# download files, pair a host or change scheduled tasks in this regression.
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($InstallerPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$fn = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-AgentFleetOnboardArguments' }, $true)
if (-not $fn) { throw 'Onboarding argument builder missing' }
Invoke-Expression $fn.Extent.Text
$parameters = @{
  PanelUrl = 'https://fleet.example.com'
  MachineName = 'Test host'
  ProjectPath = 'C:\Project with spaces'
  AgentDataDir = 'C:\User data\AgentFleet'
  ExecutablePath = 'C:\User data\AgentFleet\agentfleet.cmd'
}
$withoutTicket = @(Get-AgentFleetOnboardArguments @parameters)
if ($withoutTicket -contains '--ticket') { throw 'No-ticket pairing supplied an empty ticket' }
if ($withoutTicket.Count -ne 11) { throw 'No-ticket arguments were lost' }
$fixtureTicket = 'enr_fixture.synthetic-secret'
$literalAlias = 'literal $(Write-Error injected); & %PATH%'
$withTicket = @(Get-AgentFleetOnboardArguments @parameters -EnrollmentTicket $fixtureTicket -ProjectAlias $literalAlias)
if ($withTicket.Count -ne 15) { throw 'Ticket pairing lost arguments' }
if ($withTicket[12] -cne $fixtureTicket -or $withTicket[14] -cne $literalAlias) { throw 'Ticket/alias not preserved literally' }
if ($withoutTicket[6] -cne $parameters.ProjectPath -or $withoutTicket[10] -cne $parameters.ExecutablePath) { throw 'Paths with spaces were changed' }

$guard = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-AgentFleetNpmFreshInstall' }, $true)
if (-not $guard) { throw 'Fresh install guard missing' }
Invoke-Expression $guard.Extent.Text
# No real scheduler access is needed for the pure guard regression.
function Get-ScheduledTask { return $null }
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('agentfleet-npm-guard-' + [Guid]::NewGuid().ToString('N'))
$previousFreshFlag = $env:AGENTFLEET_NPM_FRESH_INSTALL
try {
  $fixtureBin = Join-Path $fixtureRoot 'bin'
  New-Item -ItemType Directory -Path $fixtureBin -Force | Out-Null
  $fixtureLauncher = Join-Path $fixtureRoot 'agentfleet.cmd'
  $env:AGENTFLEET_NPM_FRESH_INSTALL = '1'
  Assert-AgentFleetNpmFreshInstall -AgentDataDir $fixtureRoot -AgentBinDir $fixtureBin -LauncherPath $fixtureLauncher
  foreach ($path in @($fixtureLauncher, (Join-Path $fixtureBin 'current.txt'), (Join-Path $fixtureBin 'previous.txt'), (Join-Path $fixtureRoot 'state.sqlite'), (Join-Path $fixtureRoot 'runtime-profile.json'))) {
    [IO.File]::WriteAllText($path, 'preserve synthetic state')
    $rejected = $false
    try { Assert-AgentFleetNpmFreshInstall -AgentDataDir $fixtureRoot -AgentBinDir $fixtureBin -LauncherPath $fixtureLauncher }
    catch { if ($_.Exception.Message -notlike '*existing installation detected*') { throw }; $rejected = $true }
    if (-not $rejected) { throw 'Existing installation was not protected' }
    if ([IO.File]::ReadAllText($path) -cne 'preserve synthetic state') { throw 'Guard modified state' }
    $env:AGENTFLEET_NPM_FRESH_INSTALL = ''
    Assert-AgentFleetNpmFreshInstall -AgentDataDir $fixtureRoot -AgentBinDir $fixtureBin -LauncherPath $fixtureLauncher
    $env:AGENTFLEET_NPM_FRESH_INSTALL = '1'
    Remove-Item -LiteralPath $path
  }
  function Get-ScheduledTask { [pscustomobject]@{TaskName='AgentFleet-Background'} }
  $orphanRejected = $false
  try { Assert-AgentFleetNpmFreshInstall -AgentDataDir $fixtureRoot -AgentBinDir $fixtureBin -LauncherPath $fixtureLauncher }
  catch { if ($_.Exception.Message -notlike '*existing installation detected*') { throw }; $orphanRejected = $true }
  if (-not $orphanRejected) { throw 'Orphan registered task was not protected' }
} finally {
  $env:AGENTFLEET_NPM_FRESH_INSTALL = $previousFreshFlag
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output 'PASS: ticket/browser-confirmed arguments and existing-install protection'

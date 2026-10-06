param([string]$InstallerPath = (Join-Path $PSScriptRoot 'install.ps1'))
$ErrorActionPreference = 'Stop'
# Evaluate only the handoff function: never download, install, or modify tasks.
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($InstallerPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$fn = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Register-AgentFleetUpdateHandoff' }, $true)
if (-not $fn) { throw 'Handoff function missing' }
Invoke-Expression $fn.Extent.Text
function New-ScheduledTaskAction { @{} }
function New-ScheduledTaskTrigger { @{} }
function New-ScheduledTaskPrincipal { @{} }
function New-ScheduledTaskSettingsSet { @{} }
$script:registrations = 0
function Register-ScheduledTask { $script:registrations++; throw 'TEST_ACCESS_DENIED' }
$StateRoot = Join-Path $env:TEMP 'agentfleet-handoff-test'
$StableLauncher = Join-Path $StateRoot 'agentfleet.cmd'
$env:AGENTFLEET_SUPERVISED = '1'
$env:AGENTFLEET_SUPERVISOR_TOKEN = 'test-supervisor-token'
$env:AGENTFLEET_WORKER_DATA_DIR = $StateRoot
$env:AGENTFLEET_WORKER_EXECUTABLE = $StableLauncher
Register-AgentFleetUpdateHandoff
if ($script:registrations -ne 0) { throw 'Supervised update required scheduler privileges' }
function Assert-LegacyFailure {
  $before = $script:registrations
  try { Register-AgentFleetUpdateHandoff; throw 'Expected scheduler failure' }
  catch { if ($_.Exception.Message -ne 'TEST_ACCESS_DENIED') { throw } }
  if ($script:registrations -ne $before + 1) { throw 'Legacy handoff was not attempted' }
}
$env:AGENTFLEET_WORKER_DATA_DIR = 'different-installation'
Assert-LegacyFailure
$env:AGENTFLEET_WORKER_DATA_DIR = $StateRoot
$env:AGENTFLEET_SUPERVISOR_TOKEN = ''
Assert-LegacyFailure
$env:AGENTFLEET_SUPERVISED = ''
Assert-LegacyFailure
Write-Output 'PASS: supervised update avoids registration; legacy and mismatched contexts retain fail-closed handoff'

param(
  [ValidateSet('Onboard','Update','Stage','Repair','Rollback','Uninstall')] [string]$Mode = 'Onboard',
  [string]$Url,
  [string]$Ticket,
  [string]$Name = $env:COMPUTERNAME,
  [string]$Project = (Get-Location).Path,
  [string]$Alias,
  [switch]$Purge
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$StateRoot = Join-Path $env:LOCALAPPDATA 'AgentFleet'
$BinRoot = Join-Path $StateRoot 'bin'
$CurrentFile = Join-Path $BinRoot 'current.txt'
$PreviousFile = Join-Path $BinRoot 'previous.txt'
$StableLauncher = Join-Path $StateRoot 'agentfleet.cmd'
$RuntimeProfile = Join-Path $StateRoot 'runtime-profile.json'

# Windows PowerShell 5 does not consistently honor HTTPS_PROXY for its web
# cmdlets. The background Agent detects the enabled Windows proxy and passes it
# through the environment, so apply that proxy explicitly during downloads.
$DownloadProxy = $null
foreach ($candidate in @($env:HTTPS_PROXY, $env:HTTP_PROXY, $env:https_proxy, $env:http_proxy)) {
  if (-not $candidate) { continue }
  try {
    $candidateUri = [Uri]$candidate
    if (($candidateUri.Scheme -eq 'http' -or $candidateUri.Scheme -eq 'https') -and -not $candidateUri.UserInfo) {
      $DownloadProxy = $candidateUri.AbsoluteUri
      break
    }
  } catch { }
}
function Invoke-AgentFleetRestMethod([string]$Uri) {
  $parameters = @{ Uri = $Uri }
  if ($DownloadProxy) { $parameters.Proxy = $DownloadProxy }
  Invoke-RestMethod @parameters
}
function Invoke-AgentFleetWebRequest([string]$Uri, [string]$OutFile) {
  $parameters = @{ Uri = $Uri; OutFile = $OutFile }
  if ($DownloadProxy) { $parameters.Proxy = $DownloadProxy }
  Invoke-WebRequest @parameters
}
function Register-AgentFleetUpdateHandoff {
  # An older task wrapper may exit after this installer returns. Keep the
  # handoff independent of that wrapper until the new worker verifies itself.
  # A single Start-ScheduledTask can be ignored while the old task is still
  # Running. One hidden task process keeps checking without opening a new
  # interactive PowerShell window every minute.
  $handoffName = 'AgentFleet-Update-Handoff'
  $escapedRoot = $StateRoot.Replace("'", "''")
  $handoffScript = @"
`$ErrorActionPreference = 'SilentlyContinue'
`$root = '$escapedRoot'
`$log = Join-Path `$root 'update-handoff.log'
for (`$attempt = 0; `$attempt -lt 60; `$attempt++) {
`$task = Get-ScheduledTask -TaskName 'AgentFleet-Background' -ErrorAction SilentlyContinue
`$state = `$null
try { `$state = Get-Content -Raw -LiteralPath (Join-Path `$root 'update-state.json') | ConvertFrom-Json } catch { }
if (`$state.phase -in @('succeeded','rolled_back','failed') -and `$task -and `$task.State -eq 'Running') {
  Add-Content -LiteralPath `$log -Value "`$(Get-Date -Format o) completed: `$(`$state.phase)"
  break
}
if (`$task -and `$task.State -ne 'Running') {
  Start-ScheduledTask -TaskName 'AgentFleet-Background'
  Add-Content -LiteralPath `$log -Value "`$(Get-Date -Format o) restarted background task"
} elseif (`$task -and `$state.phase -in @('staged','verifying')) {
  # A task can claim Running while its Node worker has already disappeared.
  # Only repair that empty wrapper after a grace period; leave live workers
  # and their Codex turns untouched.
  `$age = if (`$state.startedAt) { ((Get-Date).ToUniversalTime() - ([datetime]`$state.startedAt).ToUniversalTime()).TotalMinutes } else { 0 }
  if (`$age -ge 3) {
    `$worker = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { `$_.CommandLine -like '*AgentFleet*' }
    if (-not `$worker) {
      Stop-ScheduledTask -TaskName 'AgentFleet-Background'
      Start-ScheduledTask -TaskName 'AgentFleet-Background'
      Add-Content -LiteralPath `$log -Value "`$(Get-Date -Format o) restarted empty background task"
    }
  }
}
Start-Sleep -Seconds 60
}
Unregister-ScheduledTask -TaskName '$handoffName' -Confirm:`$false
"@
  $encodedHandoff = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($handoffScript))
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encodedHandoff"
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
  $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromMinutes(65)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $handoffName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

if ($Mode -eq 'Rollback') {
  if (-not (Test-Path $StableLauncher -PathType Leaf)) { throw 'installer: no managed installation to roll back' }
  & $StableLauncher service rollback --data-dir $StateRoot
  exit $LASTEXITCODE
}

if ($Mode -eq 'Uninstall') {
  if (Test-Path $CurrentFile) {
    $currentValue = (Get-Content -Raw $CurrentFile).Trim()
    $current = if ([IO.Path]::IsPathRooted($currentValue)) { $currentValue } else { Join-Path (Join-Path $BinRoot $currentValue) 'agentfleet.cmd' }
    if (Test-Path $current) { & $current service uninstall }
  }
  if (Test-Path $BinRoot) { Remove-Item -LiteralPath $BinRoot -Recurse -Force }
  if (Test-Path $StableLauncher) { Remove-Item -LiteralPath $StableLauncher -Force }
  if ($Purge -and (Test-Path $StateRoot)) { Remove-Item -LiteralPath $StateRoot -Recurse -Force }
  Write-Host 'Removed AgentFleet. Codex history and project files were not changed.'
  exit 0
}

if (-not $Url) { throw 'installer: -Url is required' }
$uri = [Uri]$Url
if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'installer: -Url must not contain credentials, query, or fragment' }
if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and @('localhost','127.0.0.1') -contains $uri.Host)) {
  throw 'installer: -Url must use HTTPS'
}
$BaseUrl = $Url.TrimEnd('/')
$temp = Join-Path ([IO.Path]::GetTempPath()) ("agentfleet-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $profileBackup = Join-Path $temp 'runtime-profile.previous'
  $codexBackup = Join-Path $temp 'codex.previous.exe'
  $hadProfile = Test-Path $RuntimeProfile -PathType Leaf
  $managedCodexPath = Join-Path (Join-Path $StateRoot 'codex') 'codex.exe'
  $hadManagedCodex = Test-Path $managedCodexPath -PathType Leaf
  $existingProfile = $null
  if ($hadProfile) {
    Copy-Item -LiteralPath $RuntimeProfile -Destination $profileBackup
    try { $existingProfile = Get-Content -Raw -LiteralPath $RuntimeProfile | ConvertFrom-Json } catch { $existingProfile = $null }
  }
  if ($hadManagedCodex) { Copy-Item -LiteralPath $managedCodexPath -Destination $codexBackup }
  $manifest = Invoke-AgentFleetRestMethod "$BaseUrl/downloads/manifest.json"
  $artifact = $manifest.artifacts.'win32-x64'
  if ($manifest.schemaVersion -ne 1 -or -not $artifact) { throw 'installer: invalid Windows release manifest' }
  $expectedName = "agentfleet-win32-x64-$($manifest.version).tar.gz"
  if ($artifact.file -ne $expectedName) { throw 'installer: release name/version mismatch' }
  $archive = Join-Path $temp $artifact.file
  # Key CDN downloads by the verified digest so an earlier cached 404 cannot
  # hide a newly published immutable release.
  Invoke-AgentFleetWebRequest "$BaseUrl/downloads/$($artifact.file)?sha256=$($artifact.sha256)" $archive
  if ((Get-Item $archive).Length -ne [long]$artifact.size) { throw 'installer: release size mismatch' }
  if ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant() -ne $artifact.sha256) { throw 'installer: release SHA-256 mismatch' }
  $entries = & tar.exe -tzf $archive
  $tarListExit = $LASTEXITCODE
  $unsafeEntries = @($entries | Where-Object { $_ -notlike 'agentfleet/*' -or $_ -match '(^|/)\.\.?(\/|$)' })
  if ($tarListExit -ne 0 -or $unsafeEntries.Count -gt 0) { throw 'installer: unsafe release archive' }
  New-Item -ItemType Directory -Force -Path $BinRoot | Out-Null
  $target = Join-Path $BinRoot $manifest.version
  if (-not (Test-Path $target)) {
    $stage = "$target.staging-$PID"
    New-Item -ItemType Directory -Path $stage | Out-Null
    & tar.exe -xzf $archive -C $stage --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw 'installer: could not extract release' }
    $launcher = Join-Path $stage 'agentfleet.cmd'
    if ((& $launcher --version) -ne $manifest.version) { throw 'installer: release version mismatch' }
    Move-Item -LiteralPath $stage -Destination $target
  } else {
    $existingLauncher = Join-Path $target 'agentfleet.cmd'
    if (-not (Test-Path $existingLauncher -PathType Leaf) -or ((& $existingLauncher --version) -ne $manifest.version)) {
      throw 'installer: existing release directory is invalid'
    }
  }
  $launcher = Join-Path $target 'agentfleet.cmd'
  $previousVersion = if (Test-Path $CurrentFile) {
    $priorValue = (Get-Content -Raw $CurrentFile).Trim()
    if ([IO.Path]::IsPathRooted($priorValue)) { Split-Path (Split-Path $priorValue -Parent) -Leaf } else { $priorValue }
  } else { $null }
  $stableContents = "@echo off`r`nsetlocal`r`nset /p AGENTFLEET_CURRENT=<`"%~dp0bin\current.txt`"`r`ncall `"%~dp0bin\%AGENTFLEET_CURRENT%\agentfleet.cmd`" %*`r`nexit /b %errorlevel%`r`n"

  if ($Mode -eq 'Stage') {
    if (-not $existingProfile) { throw 'installer: existing runtime profile is required for an update' }
    $codexVersion = if ($existingProfile.managedVersion) { [string]$existingProfile.managedVersion } else { 'preserved' }
    Write-Host 'Preserving the existing Codex runtime, profile and companion tools.'
  } else {
  $hostCodexPath = if ($existingProfile -and [string]$existingProfile.source -eq 'managed' -and (Test-Path ([string]$existingProfile.codexExecutable) -PathType Leaf)) { [string]$existingProfile.codexExecutable } else { $null }
  $hostVersion = $null
  if ($hostCodexPath) {
    $hostOutput = (& (Join-Path $target 'runtime/node.exe') (Join-Path $target 'lib/dist/src/verify-managed-runtime.js') $hostCodexPath (Join-Path $StateRoot 'codex')) -join ''
    if ($LASTEXITCODE -eq 0 -and $hostOutput -match '^([0-9]+\.[0-9]+\.[0-9]+)$') { $hostVersion = [Version]$Matches[1] }
  }
  if ($hostCodexPath -and $hostVersion -ge [Version]'0.153.2') {
    $env:AGENTFLEET_CODEX_EXECUTABLE = $hostCodexPath
    $codexVersion = $hostVersion.ToString()
    $codexSourceKind = 'managed'
    Write-Host "Reusing verified AgentFleet Codex $codexVersion. Your own Codex and session data remain unchanged."
  } else {
    $codexManifest = Invoke-AgentFleetRestMethod "$BaseUrl/downloads/codex-manifest.json"
    $codexArtifact = $codexManifest.artifacts.'win32-x64'
    if (-not $codexArtifact) { throw 'installer: invalid Windows Codex manifest' }
    $codexArchive = Join-Path $temp $codexArtifact.file
    Invoke-AgentFleetWebRequest "$BaseUrl/downloads/$($codexArtifact.file)" $codexArchive
    if ((Get-Item $codexArchive).Length -ne [long]$codexArtifact.size) { throw 'installer: Codex size mismatch' }
    if ((Get-FileHash -Algorithm SHA256 $codexArchive).Hash.ToLowerInvariant() -ne $codexArtifact.sha256) { throw 'installer: Codex SHA-256 mismatch' }
    $codexTemp = Join-Path $temp 'codex'
    New-Item -ItemType Directory -Path $codexTemp | Out-Null
    & tar.exe -xzf $codexArchive -C $codexTemp
    if ($LASTEXITCODE -ne 0) { throw 'installer: could not extract Codex' }
    $codexSource = Join-Path $codexTemp 'codex-x86_64-pc-windows-msvc.exe'
    if (-not (Test-Path $codexSource)) { throw 'installer: invalid Codex archive layout' }
    $codexDir = Join-Path $StateRoot 'codex'
    New-Item -ItemType Directory -Force -Path $codexDir | Out-Null
    Copy-Item -Force $codexSource (Join-Path $codexDir 'codex.exe')
    $env:AGENTFLEET_CODEX_EXECUTABLE = Join-Path $codexDir 'codex.exe'
    $codexVersion = [string]$codexManifest.version
    $codexSourceKind = 'managed'
  }

  $codexHome = if ($existingProfile -and $existingProfile.codexHome) { [string]$existingProfile.codexHome } elseif ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
  $profile = @{ schemaVersion = 1; codexExecutable = $env:AGENTFLEET_CODEX_EXECUTABLE; codexHome = $codexHome; source = $codexSourceKind } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText("$RuntimeProfile.new", $profile + "`n", [Text.UTF8Encoding]::new($false))
  Move-Item -Force -LiteralPath "$RuntimeProfile.new" -Destination $RuntimeProfile

  }

  if ($previousVersion -and $previousVersion -ne [string]$manifest.version) {
    [IO.File]::WriteAllText("$PreviousFile.new", $previousVersion, [Text.ASCIIEncoding]::new())
    Move-Item -Force -LiteralPath "$PreviousFile.new" -Destination $PreviousFile
  }
  [IO.File]::WriteAllText("$CurrentFile.new", [string]$manifest.version, [Text.ASCIIEncoding]::new())
  Move-Item -Force -LiteralPath "$CurrentFile.new" -Destination $CurrentFile
  [IO.File]::WriteAllText("$StableLauncher.new", $stableContents, [Text.ASCIIEncoding]::new())
  Move-Item -Force -LiteralPath "$StableLauncher.new" -Destination $StableLauncher

  Write-Host "Installed AgentFleet $($manifest.version) with Codex $codexVersion."
  if ($Mode -eq 'Repair') {
    # Restore a missing/partially installed task using the existing pairing.
    # Unlike Onboard, this does not register a project or redeem another ticket.
    & $StableLauncher service install --executable $StableLauncher --data-dir $StateRoot
    if ($LASTEXITCODE -ne 0) {
      Write-Warning 'Background service installation failed. Starting the repaired agent in this window; keep it open.'
      & $StableLauncher run --data-dir $StateRoot
    } else {
      Write-Host 'The Windows task is running. Panel connectivity is confirmed only after the host appears online; allow startup and connection time.'
    }
    exit $LASTEXITCODE
  }
  if ($Mode -eq 'Update') {
    & $StableLauncher service update --executable $StableLauncher --data-dir $StateRoot
    if ($LASTEXITCODE -eq 0) { exit 0 }
    [Console]::Error.WriteLine('installer: service update failed; restoring the previous binary')
    if ($hadProfile) { Copy-Item -Force -LiteralPath $profileBackup -Destination $RuntimeProfile } else { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $RuntimeProfile }
    if ($hadManagedCodex) { Copy-Item -Force -LiteralPath $codexBackup -Destination $managedCodexPath } else { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $managedCodexPath }
    if ($previousVersion) {
      [IO.File]::WriteAllText($CurrentFile, $previousVersion, [Text.ASCIIEncoding]::new())
      & $StableLauncher service update --executable $StableLauncher --data-dir $StateRoot
    }
    exit 1
  }
  if ($Mode -eq 'Stage') {
    & $StableLauncher service stage-background --executable $StableLauncher --data-dir $StateRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not schedule background service migration' }
    Register-AgentFleetUpdateHandoff
    Write-Host "Staged AgentFleet $($manifest.version); the task will restart into it."; exit 0 }
  $args = @('onboard','--url',$BaseUrl,'--ticket',$Ticket,'--name',$Name,'--project',$Project,'--data-dir',$StateRoot,'--executable',$StableLauncher)
  if ($Alias) { $args += @('--alias',$Alias) }
  & $launcher @args
  exit $LASTEXITCODE
} finally {
  if (Test-Path $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}

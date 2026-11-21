# ---------------------------------------------------------------------------------------------------------------------
# Windows: turns on WSL2, gives the runner its own WSL distribution (guildwise-runner, cut off from Windows: no Windows
# programs, no Windows PATH, no Windows drives), keeps it running, then runs the Linux installer inside it. An existing
# runner in your Ubuntu is kept (unless this server requires signed runners or you ask to replace it); choosing to stay in
# your default distribution is possible with GUILDWISE_WSL_DISTRO=default, without that isolation.
# Safe to run again at any time. If Windows must restart, this script continues by itself when you sign in again.
# ---------------------------------------------------------------------------------------------------------------------
# Native commands (wsl.exe) write progress to stderr; cmdlets that must fail loudly say -ErrorAction Stop.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$WorkDir = Join-Path $env:LOCALAPPDATA 'GuildwiseHQ'
$SelfPath = Join-Path $WorkDir 'install.ps1'
$LinuxScriptPath = Join-Path $WorkDir 'install-linux.sh'
$StatePath = Join-Path $WorkDir 'state.json'
$script:StepNumber = 0
$script:StepTotal = 9
$script:CurrentStep = 'installer'
$RunnerTaskName = "$AppName runner"
$OldTaskName = 'WSL Boot'
# The runner's own distribution [rv6-4] and the pinned Ubuntu 24.04 WSL image it is made from (sha256 from Canonical's
# SHA256SUMS of that release folder).
$DedicatedDistro = 'guildwise-runner'
$UbuntuRootfs = @{
  amd64 = @{ Url = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/20240423/ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz'; Sha256 = '2a790896740b14d637dbdc583cce1ba081ac53b9e9cdb46dc09a2f73abbd9934' }
  arm64 = @{ Url = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/20240423/ubuntu-noble-wsl-arm64-24.04lts.rootfs.tar.gz'; Sha256 = 'e113b8c49af3ab49b992b8e29550fc921e689f211abc338176f8243786173a32' }
}
# Installer choices that may be set in Windows and are passed on to the Linux installer (never values from the server).
$ForwardedVars = @('GUILDWISE_YES', 'GUILDWISE_LEGACY', 'GUILDWISE_DEVOPS_ORGS', 'GUILDWISE_DOCKER', 'GUILDWISE_DOCKER_SOCKET', 'GUILDWISE_ACCEPT_ROOT_EQUIVALENT', 'GUILDWISE_ACCEPT_SHARED_DAEMON', 'GUILDWISE_SKIP_BASELINE', 'GUILDWISE_DEPLOY', 'GUILDWISE_DEPLOY_PIN_COMMIT', 'GUILDWISE_ALLOW_UNSIGNED_FROM', 'GUILDWISE_WITH_YTDLP', 'GUILDWISE_SKIP_CLAUDE_INSTALL')

function Write-Info([string]$Text) { Write-Host "    $Text" -ForegroundColor DarkGray }
function Write-Good([string]$Text) { Write-Host "    [ok] $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "    [!]  $Text" -ForegroundColor Yellow }

function Send-Report([string]$Step, [string]$Status, [string]$Detail = '') {
  if (-not $SessionToken) { return }
  try {
    if ($Detail.Length -gt 400) { $Detail = $Detail.Substring(0, 400) }
    $body = @{ step = $Step; status = $Status; detail = $Detail } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "$ServerUrl/install/$SessionToken/progress" -ContentType 'application/json' -Body $body -TimeoutSec 6 | Out-Null
  } catch { }
}

function Start-Step([string]$Title) {
  $script:StepNumber++
  $script:CurrentStep = $Title
  Write-Host ''
  Write-Host ("[{0}/{1}] {2}" -f $script:StepNumber, $script:StepTotal, $Title) -ForegroundColor White
  Send-Report $Title 'start'
}
function Complete-Step([string]$Text) { Write-Good $Text; Send-Report $script:CurrentStep 'ok' $Text }

function Stop-Install([string]$What, [string]$Todo = '') {
  Write-Host ''
  Write-Host "[x] $What" -ForegroundColor Red
  if ($Todo) { Write-Host "    $Todo" }
  Send-Report $script:CurrentStep 'fail' $What
  Send-Report 'summary' 'done' "failed: $What"
  Write-Host ''
  Write-Host "$AppName did not finish. Nothing is broken: run the same command again and it carries on where it stopped."
  Write-Host "  Help:        $ServerUrl/help#install-troubleshooting"
  Write-Host "  Contact us:  $ServerUrl/contact?from=installer"
  Read-Host 'Press Enter to close this window' | Out-Null
  exit 1
}

function Get-State {
  if (Test-Path $StatePath) { try { return Get-Content $StatePath -Raw | ConvertFrom-Json } catch { } }
  return [pscustomobject]@{ rebootRequested = $false; wslRestarts = 0; ubuntuRestartRequested = $false; restartBootTime = '' }
}
function Save-State($State) { $State | ConvertTo-Json | Set-Content -Path $StatePath -Encoding ASCII }
# An older state file has no field for what was added later: Add-Member -Force sets it either way.
function Set-StateValue([string]$Name, $Value) {
  $state = Get-State
  $state | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
  Save-State $state
}

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Text for bash inside WSL. It travels as base64 inside the command line: piping a string to a native program makes
# PowerShell append a carriage return and line feed, and a trailing CR breaks bash ("fi" followed by CR is not "fi")
# and ends up inside a password. Unix line endings only.
function ConvertTo-Base64Unix([string]$Text) {
  $unix = ($Text -replace "`r", '').TrimEnd("`n") + "`n"
  return [Convert]::ToBase64String([System.Text.UTF8Encoding]::new($false).GetBytes($unix))
}
function Invoke-WslBash([string]$Distro, [string]$User, [string]$BashScript) {
  $b64 = ConvertTo-Base64Unix $BashScript
  $out = & wsl.exe -d $Distro -u $User -- bash -c "echo $b64 | base64 -d | bash" 2>&1
  $text = ($out | Out-String) -replace "`0", ''
  return @{ Code = $LASTEXITCODE; Text = $text.Trim() }
}

function Get-Distros {
  $raw = & wsl.exe -l -q 2>$null
  # With no distribution installed wsl.exe prints an explanation (and fails): that is not a list of names.
  if (-not $raw -or $LASTEXITCODE -ne 0) { return @() }
  return @(($raw | Out-String) -replace "`0", '' -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

# When Windows last started. Saved with every restart request: answering N to the prompt (or never restarting) leaves it
# unchanged, so the next run can tell "back after a restart" from "run again without one".
function Get-BootTime {
  try { return (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToString('o') } catch { return '' }
}
function Test-RestartedSince {
  $then = [string](Get-State).restartBootTime
  $now = Get-BootTime
  if (-not $then -or -not $now) { return $true }
  return ([Math]::Abs(([datetime]$now - [datetime]$then).TotalSeconds) -gt 60)
}

function Request-Restart([string]$Reason) {
  $state = Get-State
  $state.rebootRequested = $true
  $state | Add-Member -NotePropertyName restartBootTime -NotePropertyValue (Get-BootTime) -Force
  Save-State $state
  $runOnce = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
  $cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$SelfPath`""
  Set-ItemProperty -Path $runOnce -Name 'GuildwiseHQInstall' -Value $cmd -ErrorAction Stop
  Send-Report $script:CurrentStep 'warn' "Windows must restart: $Reason"
  Write-Host ''
  Write-Host "Windows needs to restart ($Reason)." -ForegroundColor Yellow
  Write-Host 'After the restart, sign in as usual: this installer opens again by itself (Windows may ask you to allow it) and carries on.'
  $answer = Read-Host 'Restart now? (y/N)'
  if ($answer -match '^(y|yes)$') { Restart-Computer -Force } else { Write-Host 'Restart Windows when you are ready; the installer continues after you sign in.' }
  exit 0
}

$WslFeatureNames = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')

# Whether this PC can run the virtual machine WSL2 needs, read from Windows itself (never from wsl.exe: an older wsl.exe
# looks fine on a PC with virtualization off). 'pass': a hypervisor runs, or the firmware has virtualization on.
# 'off': no hypervisor although VirtualMachinePlatform is on and Windows restarted with it, and the firmware says off.
# 'maybe-off': the same readings before VirtualMachinePlatform is on (the firmware flag alone is not trusted to stop).
# 'unknown': could not read, or an ARM PC. Only 'off' stops the installer.
function Get-Virtualization {
  try {
    $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
    $cpus = @(Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop)
    $vmp = [string](Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -ErrorAction Stop).State
  } catch { return @{ State = 'unknown'; Detail = "could not read it: $($_.Exception.Message)" } }
  $fw = @($cpus | ForEach-Object { $_.VirtualizationFirmwareEnabled })
  $detail = "hypervisor running: $($cs.HypervisorPresent); on in firmware: $($fw -join ', '); VirtualMachinePlatform: $vmp"
  if ($cs.HypervisorPresent -eq $true) { return @{ State = 'pass'; Detail = $detail } }
  if (@($fw | Where-Object { $_ -eq $true }).Count -gt 0) { return @{ State = 'pass'; Detail = $detail } }
  $arm = @($cpus | Where-Object { $_.Architecture -in 5, 12 }).Count -gt 0
  $saysOff = ($cs.HypervisorPresent -eq $false) -and $fw.Count -gt 0 -and @($fw | Where-Object { $_ -ne $false }).Count -eq 0
  if ($arm -or -not $saysOff) { return @{ State = 'unknown'; Detail = $detail } }
  if ($vmp -eq 'Enabled') { return @{ State = 'off'; Detail = $detail } }
  return @{ State = 'maybe-off'; Detail = $detail }
}

$script:VirtState = 'unknown'
$VirtHelp = "$ServerUrl/help/install-troubleshooting#windows-virtualization"
$VirtHint = 'Virtualization (Intel VT-x, AMD-V or SVM) may be off in the BIOS/UEFI settings of this PC (on a virtual machine: nested virtualization in its host).'
$VirtErrorPattern = '0x80370102|0x80370114|HCS_E_HYPERV_NOT_INSTALLED|virtuali[sz]ation|Hyper-V|BIOS'

# A later step that failed because WSL2 could not run: the BIOS hint goes right after the short first sentence and
# before the raw output (clipped), so it survives the 400-character limit of the progress report.
function Format-WslFailure([string]$Lead, [string]$Output = '') {
  $out = (($Output -replace "`0", '') -replace '\s+', ' ').Trim()
  if ($out.Length -gt 200) { $out = $out.Substring(0, 200) + '...' }
  $hint = if ($script:VirtState -ne 'pass' -or $out -match $VirtErrorPattern) { " $VirtHint" } else { '' }
  $tail = if ($out) { " Output: $out" } else { '' }
  return "$Lead$hint$tail"
}

# WSL2 can be used when VirtualMachinePlatform is on and wsl.exe answers --status. The legacy feature does not decide:
# the Store version of WSL runs without it. Pending is true when a feature waits for a restart.
function Get-WslReadiness {
  $states = [ordered]@{}
  foreach ($n in $WslFeatureNames) { $states[$n] = [string](Get-WindowsOptionalFeature -Online -FeatureName $n -ErrorAction Stop).State }
  $code = 1
  $raw = ''
  try { $raw = & wsl.exe --status 2>&1; $code = $LASTEXITCODE } catch { $raw = $_.Exception.Message }
  $lines = @((($raw | Out-String) -replace "`0", '') -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $last = if ($lines.Count -gt 0) { $lines[$lines.Count - 1] } else { '(no output)' }
  $pending = @($states.Values | Where-Object { $_ -match 'Pending' }).Count -gt 0
  $summary = (($WslFeatureNames | ForEach-Object { "$_ is $($states[$_])" }) -join '; ') + "; wsl.exe --status said: $last"
  return @{ Ready = ($states['VirtualMachinePlatform'] -eq 'Enabled' -and $code -eq 0); Pending = $pending; States = $states; Summary = $summary }
}

# Turns on every WSL feature that is not on yet. True when something changed, so that a restart is really pending.
# A failure is kept in $script:WslEnableError for the stop message instead of going to the trap.
$script:WslEnableError = ''
function Enable-WslFeatures {
  $changed = $false
  try {
    foreach ($f in $WslFeatureNames) {
      $before = [string](Get-WindowsOptionalFeature -Online -FeatureName $f -ErrorAction Stop).State
      if ($before -eq 'Enabled') { continue }
      Enable-WindowsOptionalFeature -Online -FeatureName $f -NoRestart -All -ErrorAction Stop | Out-Null
      $changed = $true
    }
  } catch { $script:WslEnableError = "Enabling $f failed: $($_.Exception.Message)" }
  return $changed
}

# ---- Docker Desktop and the runner's distribution [rv7-11] -----------------------------------------------------------------
# Docker Desktop's WSL integration gives a distribution its socket, which is root on the Docker Desktop VM, and that VM
# mounts the Windows drives: it must stay off for the runner's distribution.
function Get-DockerDesktopSettingsText {
  foreach ($n in @('settings-store.json', 'settings.json')) {
    $p = Join-Path $env:APPDATA "Docker\$n"
    if (Test-Path -LiteralPath $p) { return [System.IO.File]::ReadAllText($p) }
  }
  return ''
}
# '' when the integration is off for $Distro (or Docker Desktop is not installed); otherwise what is wrong.
function Get-DockerIntegrationProblem([string]$SettingsText, [string]$Distro, [bool]$IsDefault) {
  if (-not $SettingsText -or -not $SettingsText.Trim()) { return '' }
  try { $s = $SettingsText | ConvertFrom-Json -ErrorAction Stop } catch { return "Docker Desktop's settings could not be read, so its WSL integration cannot be confirmed off for $Distro" }
  if (@($s.integratedWslDistros | Where-Object { $_ -eq $Distro }).Count -gt 0) { return "Docker Desktop's WSL integration is on for $Distro" }
  if ($IsDefault -and $s.enableIntegrationWithDefaultWslDistro -eq $true) { return "Docker Desktop's WSL integration is on for your default WSL distribution, which is $Distro" }
  return ''
}
function Get-DefaultDistroName {
  try {
    $lxss = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    $guid = (Get-ItemProperty -Path $lxss -ErrorAction Stop).DefaultDistribution
    if (-not $guid) { return '' }
    return [string](Get-ItemProperty -Path (Join-Path $lxss $guid) -ErrorAction Stop).DistributionName
  } catch { return '' }
}
function Assert-NoDockerIntegration([string]$Distro) {
  $problem = Get-DockerIntegrationProblem (Get-DockerDesktopSettingsText) $Distro ((Get-DefaultDistroName) -eq $Distro)
  if ($problem) {
    Stop-Install "$problem. Its socket is root on the Docker Desktop VM, which mounts your Windows drives, so the runner would not be cut off from Windows." "Open Docker Desktop > Settings > Resources > WSL integration, switch off $Distro (and 'Enable integration with my default WSL distro' while $Distro is your default), choose Apply & restart, then run the command again. For deploys, install Docker Engine inside $Distro instead."
  }
}

# /etc/wsl.conf of the runner's distribution: no Windows programs (interop), no Windows PATH, no Windows drives, systemd
# on; with -WithUser also the default user. Root inside the distribution can change this file, which is why the runner
# never gets sudo (1.10.0 has no sudo grant at all).
function Get-DedicatedWslConfScript([switch]$WithUser) {
  $user = if ($WithUser) { "`n[user]`ndefault=$DedicatedDistro" } else { '' }
  return @'
set -e
cat > /etc/wsl.conf <<'CONF'
# Written by the workstation installer: the runner's own Linux, cut off from Windows.
[boot]
systemd=true

[interop]
enabled=false
appendWindowsPath=false

[automount]
enabled=false
mountFsTab=false
'@ + $user + @'

CONF
echo 'wsl.conf written'
'@
}

# The bash line that exports the forwarded installer choices (each value travels as base64, so no quoting can break).
function Get-ForwardedExports {
  $parts = @()
  foreach ($n in $ForwardedVars) {
    $v = [Environment]::GetEnvironmentVariable($n)
    if ($v) { $parts += "export $n=`"`$(echo $(ConvertTo-Base64Unix $v) | base64 -d)`";" }
  }
  return ($parts -join ' ')
}

# Keeps a distribution running in the background: vmIdleTimeout=-1 in .wslconfig and a task that starts it at sign-in.
function Register-KeepAlive([string]$Distro) {
  $wslConfig = Join-Path $env:USERPROFILE '.wslconfig'
  $lines = @()
  if (Test-Path $wslConfig) { $lines = @([System.IO.File]::ReadAllLines($wslConfig)) }
  $hasSetting = $lines | Where-Object { $_ -match '^\s*vmIdleTimeout\s*=\s*-1\s*$' }
  $configChanged = $false
  if (-not $hasSetting) {
    $lines = @($lines | Where-Object { $_ -notmatch '^\s*vmIdleTimeout\s*=' })
    $at = [Array]::FindIndex([string[]]$lines, [Predicate[string]]{ param($l) $l -match '^\s*\[wsl2\]\s*$' })
    if ($at -ge 0) { $lines = @($lines[0..$at]) + @('vmIdleTimeout=-1') + @($(if ($at + 1 -lt $lines.Count) { $lines[($at + 1)..($lines.Count - 1)] } else { @() })) }
    else { $lines = @($lines) + @('', '[wsl2]', 'vmIdleTimeout=-1') }
    # UTF-8 without a byte order mark, whatever the file held (Set-Content -Encoding ASCII turns accents into '?').
    [System.IO.File]::WriteAllLines($wslConfig, [string[]]$lines, [System.Text.UTF8Encoding]::new($false))
    $configChanged = $true
  }
  $taskArgs = "-d $Distro --exec sleep infinity"
  $action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument $taskArgs
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $RunnerTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Keeps $Distro running so the $AppName runner stays online." -Force -ErrorAction Stop | Out-Null
  # Older installs called this task "WSL Boot". Remove it, but only when it is ours: it starts wsl.exe in a distribution
  # with `--exec sleep infinity`. A task of that name that does something else is left alone.
  $oldTask = Get-ScheduledTask -TaskName $OldTaskName -ErrorAction SilentlyContinue
  if ($oldTask) {
    if (Test-OurKeepAliveTask $oldTask '') {
      try { Unregister-ScheduledTask -TaskName $OldTaskName -Confirm:$false -ErrorAction Stop; Write-Info "Removed the old $OldTaskName task (it is now called $RunnerTaskName)." }
      catch { Write-Info "Could not remove the old $OldTaskName task: $($_.Exception.Message)" }
    } else { Write-Info "A task called $OldTaskName exists but is not ours; it was left alone." }
  }
  if ($configChanged) { & wsl.exe --shutdown 2>&1 | Out-Null }
  Start-ScheduledTask -TaskName $RunnerTaskName
}
# A keep-alive task of ours: wsl.exe with `--exec sleep infinity`, in $Distro when one is named.
function Test-OurKeepAliveTask($Task, [string]$Distro) {
  $a = @($Task.Actions) | Select-Object -First 1
  if (-not $a -or [string]$a.Execute -notmatch 'wsl(\.exe)?$' -or [string]$a.Arguments -notmatch '--exec\s+sleep\s+infinity') { return $false }
  if ($Distro) { return ([string]$a.Arguments -match ('-d\s+' + [regex]::Escape($Distro) + '(\s|$)')) }
  return $true
}

# Waits for systemd in a distribution; with a user name, lets that user's services run without a login.
function Wait-Systemd([string]$Distro, [string]$LingerUser) {
  $linger = if ($LingerUser) { "loginctl enable-linger '$LingerUser' >/dev/null 2>&1 || true" } else { '' }
  $settle = @"
for i in `$(seq 1 40); do
  s=`$(systemctl is-system-running 2>/dev/null || true)
  case "`$s" in running|degraded) break ;; esac
  sleep 1
done
$linger
systemctl is-system-running 2>/dev/null || true
"@
  return (Invoke-WslBash $Distro 'root' $settle)
}

# The dedicated-distribution path (after step 2b): its own steps, then the end of the install.
function Install-DedicatedDistro {
  $script:StepTotal = $script:StepNumber + 5
  Start-Step "Creating the runner's own Linux ($DedicatedDistro)"
  if (-not (Get-Distros | Where-Object { $_ -eq $DedicatedDistro })) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $rootfs = $UbuntuRootfs[$arch]
    $file = Join-Path $WorkDir "ubuntu-24.04-wsl-$arch.rootfs.tar.gz"
    if (-not (Test-Path $file) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLower() -ne $rootfs.Sha256) {
      Write-Info 'Downloading Ubuntu 24.04 for the runner (about 350 MB) ...'
      try { Invoke-WebRequest -UseBasicParsing -Uri $rootfs.Url -OutFile $file -ErrorAction Stop }
      catch { Stop-Install "Could not download Ubuntu for the runner: $($_.Exception.Message)" 'Check that this PC can reach cloud-images.ubuntu.com, then run the command again.' }
    }
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLower()
    if ($got -ne $rootfs.Sha256) {
      Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
      Stop-Install "The Ubuntu download did not match its pinned checksum (got $($got.Substring(0, 12))...)." 'Run the command again; if it repeats, contact us.'
    }
    $before = Get-DefaultDistroName
    $dir = Join-Path $WorkDir "wsl\$DedicatedDistro"
    New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop | Out-Null
    $out = (& wsl.exe --import $DedicatedDistro $dir $file --version 2 2>&1 | Out-String) -replace "`0", ''
    if (-not (Get-Distros | Where-Object { $_ -eq $DedicatedDistro })) {
      Stop-Install (Format-WslFailure "Could not create the $DedicatedDistro distribution." $out) "Run the command again. Help: $VirtHelp"
    }
    # Importing the first distribution makes it the default: your own distribution stays the default when there is one.
    if ($before -and $before -ne $DedicatedDistro) { & wsl.exe --set-default $before 2>&1 | Out-Null }
  }
  $r = Invoke-WslBash $DedicatedDistro 'root' (Get-DedicatedWslConfScript)
  if ($r.Text -notmatch 'wsl\.conf written') { Stop-Install (Format-WslFailure "Could not write /etc/wsl.conf in $DedicatedDistro." $r.Text) 'Run the command again.' }
  & wsl.exe --terminate $DedicatedDistro 2>&1 | Out-Null
  Complete-Step "$DedicatedDistro is ready: no Windows programs, no Windows PATH and no Windows drives inside it; systemd is on"

  Start-Step 'Checking Docker Desktop'
  Assert-NoDockerIntegration $DedicatedDistro
  Complete-Step "Docker Desktop's WSL integration is off for $DedicatedDistro (deploys that need Docker use Docker Engine inside it)"

  Start-Step "Keeping $DedicatedDistro running in the background"
  Register-KeepAlive $DedicatedDistro
  Complete-Step "vmIdleTimeout=-1 is set and the $RunnerTaskName task starts $DedicatedDistro when you sign in"

  Start-Step "Running the Linux installer inside $DedicatedDistro"
  $null = Wait-Systemd $DedicatedDistro ''
  # No Windows drives inside: the Linux installer is copied in through the distribution's own share.
  $copied = $false
  foreach ($share in @("\\wsl.localhost\$DedicatedDistro\root", "\\wsl$\$DedicatedDistro\root")) {
    try { Copy-Item -LiteralPath $LinuxScriptPath -Destination (Join-Path $share 'guildwise-install.sh') -Force -ErrorAction Stop; $copied = $true; break } catch { }
  }
  if (-not $copied) { Stop-Install "Could not copy the Linux installer into $DedicatedDistro." 'Run the command again.' }
  Write-Info "The next lines come from $DedicatedDistro. It installs the baseline, creates the runner user there (never with sudo) and its own rootless Docker."
  $name = if ($DefaultName) { $DefaultName } else { "$env:COMPUTERNAME (WSL2)" }
  $line = "export GUILDWISE_NAME=`"`$(echo $(ConvertTo-Base64Unix $name) | base64 -d)`" GUILDWISE_ALLOW_ROOT=1 GUILDWISE_RUNNER_USER=dedicated; $(Get-ForwardedExports) exec bash /root/guildwise-install.sh"
  $runB64 = ConvertTo-Base64Unix $line
  & wsl.exe -d $DedicatedDistro -u root --cd '/root' -- bash -c "echo $runB64 | base64 -d | bash"
  $code = $LASTEXITCODE
  if ($code -ne 0) { Stop-Install "The Linux installer inside $DedicatedDistro finished with problems (exit code $code)." "Read the lines above (they come from $DedicatedDistro), fix what they say, and run the command again." }
  $r = Invoke-WslBash $DedicatedDistro 'root' (Get-DedicatedWslConfScript -WithUser)
  if ($r.Text -notmatch 'wsl\.conf written') { Write-Warn "Could not set $DedicatedDistro as the default user of its distribution: $($r.Text)" }
  & wsl.exe --terminate $DedicatedDistro 2>&1 | Out-Null
  Start-ScheduledTask -TaskName $RunnerTaskName
  Assert-NoDockerIntegration $DedicatedDistro
  Complete-Step "The runner is installed in $DedicatedDistro as the user $DedicatedDistro"

  Start-Step 'Finishing'
  Complete-Step "The runner runs in $DedicatedDistro and starts when you sign in to Windows"
  Write-Host ''
  Write-Host "$AppName is ready." -ForegroundColor Green
  Write-Host "  Open $ServerUrl/workstations to see this PC, then hire an agent onto it."
  Write-Host "  The runner works only in its own clones inside $DedicatedDistro; you get its work through git."
  Write-Host "  The runner has no sudo inside $DedicatedDistro; its Docker is its own rootless engine there (not Docker Desktop)."
  Write-Host '  Run the same command again any time to upgrade or repair.'
  Read-Host 'Press Enter to close this window' | Out-Null
  exit 0
}

trap { Stop-Install "Unexpected problem: $($_.Exception.Message)" 'Run the command again; if it repeats, contact us.' }

# ---- 0. administrator rights, and keep a copy of ourselves for the restart --------------------------------------------
New-Item -ItemType Directory -Path $WorkDir -Force -ErrorAction Stop | Out-Null
if (-not (Test-Admin)) {
  Write-Host "$AppName needs administrator rights once, to turn on Windows' Linux support (WSL2). Windows will ask you to allow it."
  # After a restart this is the saved copy itself (the one-time link may be gone by then): only fetch when it is not.
  if (-not (Test-Path $SelfPath) -or $MyInvocation.MyCommand.Path -ne $SelfPath) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $ScriptUrl -OutFile $SelfPath -ErrorAction Stop }
    catch { if (-not (Test-Path $SelfPath)) { throw } }
  }
  # The elevated copy is told whose PC this is: if Windows asked for another administrator's password, WSL and
  # Ubuntu would be set up for that account instead of yours.
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$SelfPath`"", "`"$env:USERPROFILE`"")
  Write-Host 'Carry on in the administrator window that opened. This window can be closed.'
  return
}
$OriginalProfile = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
if ($OriginalProfile -and $OriginalProfile -ne $env:USERPROFILE) {
  Stop-Install "Windows ran the installer as a different user ($env:USERNAME) than the one who started it." 'Run the command again in a PowerShell window you open as your own user, and choose Yes (not another account) when Windows asks for permission. WSL and Ubuntu belong to one Windows user.'
}
if (-not (Test-Path $SelfPath) -or $MyInvocation.MyCommand.Path -ne $SelfPath) {
  try { Invoke-WebRequest -UseBasicParsing -Uri $ScriptUrl -OutFile $SelfPath } catch { }
}
$state = Get-State
if ($state.rebootRequested) {
  Write-Host 'Welcome back: carrying on where the installer stopped.' -ForegroundColor Green
  $state.rebootRequested = $false
  Save-State $state
  Remove-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'GuildwiseHQInstall' -ErrorAction SilentlyContinue
}

Write-Host "$AppName`: set up this PC as a workstation" -ForegroundColor White
Write-Host 'Safe to run again at any time: it upgrades or repairs what is already here.' -ForegroundColor DarkGray
Send-Report 'installer' 'start' 'windows'

# ---- 1. this PC -----------------------------------------------------------------------------------------------------------
Start-Step 'Checking this PC'
$build = [Environment]::OSVersion.Version.Build
if ($build -lt 19041) { Stop-Install "This version of Windows (build $build) is too old for WSL2." 'Update to Windows 10 version 2004 (build 19041) or newer, or Windows 11, then run the command again.' }
Complete-Step "Windows build $build on $env:COMPUTERNAME"

# The Linux installer is fetched now, while the one-time link is fresh, and kept for after a restart.
try { Invoke-WebRequest -UseBasicParsing -Uri $LinuxScriptUrl -OutFile $LinuxScriptPath }
catch { if (-not (Test-Path $LinuxScriptPath)) { Stop-Install "Could not download the Linux installer from $ServerUrl." 'Check that this PC can open the address in a browser, then create a new command on the Add a workstation page.' } }

# ---- 2. WSL2 --------------------------------------------------------------------------------------------------------------
Start-Step 'Turning on WSL2 (Linux on Windows)'
$wslRestarts = [int](Get-State).wslRestarts
# Windows has not restarted since the last request (the answer was N): that request does not count.
if ($wslRestarts -gt 0 -and -not (Test-RestartedSince)) { $wslRestarts--; Set-StateValue 'wslRestarts' $wslRestarts }
$virt = Get-Virtualization
$script:VirtState = $virt.State
if ($virt.State -eq 'off') {
  Set-StateValue 'wslRestarts' 0
  Stop-Install "Virtualization is off in the BIOS/UEFI of this PC, so WSL2 cannot run. Turn on virtualization (Intel VT-x, AMD-V or SVM) in the BIOS/UEFI settings, restart the PC and run the installer again. ($($virt.Detail))" "How to turn it on: $VirtHelp   If the command has expired by then, create a new one on the Add a workstation page."
} elseif ($virt.State -eq 'maybe-off') {
  $msg = "Virtualization looks off in the BIOS/UEFI of this PC ($($virt.Detail)). WSL2 needs it: if the installer stops after the restart, turn on Intel VT-x, AMD-V or SVM in the BIOS/UEFI. Help: $VirtHelp"
  Write-Warn $msg
  Send-Report $script:CurrentStep 'warn' $msg
} elseif ($virt.State -eq 'unknown') {
  Write-Warn "Could not confirm that virtualization is on ($($virt.Detail)). Carrying on."
  Send-Report $script:CurrentStep 'warn' "Could not confirm that virtualization is on: $($virt.Detail)"
}
$wsl = Get-WslReadiness
if (-not $wsl.Ready) {
  $changed = $false
  if ($wslRestarts -eq 0) {
    Write-Info 'Turning on WSL2 ...'
    & wsl.exe --install --no-distribution 2>&1 | Out-Null
    $installed = ($LASTEXITCODE -eq 0)
    $wsl = Get-WslReadiness
    # Enable the features ourselves when wsl.exe failed or left one of them off (not just waiting for a restart).
    $off = @($wsl.States.Values | Where-Object { $_ -ne 'Enabled' -and $_ -notmatch 'Pending' })
    if (-not $wsl.Ready -and (-not $installed -or $off.Count -gt 0)) {
      Write-Info 'Enabling the Windows features WSL2 needs ...'
      $changed = Enable-WslFeatures
      $wsl = Get-WslReadiness
    }
  } elseif ($wslRestarts -eq 1) {
    # Back after the restart and still not ready: do the enabling here, once.
    Write-Info 'WSL2 is not ready after the restart. Enabling the Windows features myself ...'
    $changed = Enable-WslFeatures
    $wsl = Get-WslReadiness
  }
  if (-not $wsl.Ready) {
    # A restart only when one is really pending, and never more than twice for WSL2.
    if (($wsl.Pending -or $changed) -and $wslRestarts -lt 2) {
      Set-StateValue 'wslRestarts' ($wslRestarts + 1)
      Request-Restart 'to finish turning on WSL2'
    }
    # Both features are on but this wsl.exe has no --status (older Windows 10 without the Store update): if it can
    # still set version 2 as the default, carry on rather than stop a PC that works.
    $allOn = @($wsl.States.Values | Where-Object { $_ -ne 'Enabled' }).Count -eq 0
    if ($allOn) {
      & wsl.exe --set-default-version 2 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { $wsl.Ready = $true }
    }
    if (-not $wsl.Ready) {
      Set-StateValue 'wslRestarts' 0
      $detail = $wsl.Summary
      if ($script:WslEnableError) { $detail = "$detail; $($script:WslEnableError)" }
      $todo = "Turn on virtualization in the BIOS/UEFI of this PC, or open PowerShell and run: wsl --install   Then run the same command again. Help: $VirtHelp"
      if ($wsl.Pending) { $todo = "Restart Windows first (a feature is waiting for it). $todo" }
      Stop-Install "WSL2 is still not ready. $VirtHint $detail." $todo
    }
  }
}
Set-StateValue 'wslRestarts' 0
& wsl.exe --update 2>&1 | Out-Null
& wsl.exe --set-default-version 2 2>&1 | Out-Null
Complete-Step 'WSL2 is on'

# ---- 2b. an older runner (R21) --------------------------------------------------------------------------------------------
# The Linux installer decides, with the same rules as on Linux: an existing runner is kept unless this server requires signed
# runners and it is not one this installer verified, or GUILDWISE_LEGACY=quarantine|remove asks to replace it.
Start-Step 'Looking for an older runner'
$script:LegacyResult = 'none'
$LegacyDistro = Get-Distros | Where-Object { $_ -like 'Ubuntu*' } | Select-Object -First 1
if ($LegacyDistro) {
  $legacyUser = (& wsl.exe -d $LegacyDistro -- whoami 2>$null | Out-String).Trim()
  if ($legacyUser -and $legacyUser -ne 'root') {
    if ($RequireSignedRunners) { Write-Info 'This server accepts only signed runners: a runner in your Ubuntu that this installer did not verify is stopped and quarantined.' }
    $env:GUILDWISE_SCRIPT = $LinuxScriptPath
    $env:WSLENV = 'GUILDWISE_SCRIPT/p:GUILDWISE_LEGACY/u'
    $legacyB64 = ConvertTo-Base64Unix 'exec bash "$GUILDWISE_SCRIPT" --legacy-only'
    $legacyLines = ''
    & wsl.exe -d $LegacyDistro -u $legacyUser --cd '~' -- bash -c "echo $legacyB64 | base64 -d | bash" 2>&1 | Tee-Object -Variable legacyLines | Out-Host
    $legacyCode = $LASTEXITCODE
    $legacyText = ($legacyLines | Out-String) -replace "`0", ''
    if ($legacyCode -ne 0) { Stop-Install "Could not deal with the older runner in $LegacyDistro (exit code $legacyCode)." 'Read the lines above, fix what they say, and run the command again.' }
    if ($legacyText -match 'LEGACY_RESULT=(none|kept|quarantined|removed)') { $script:LegacyResult = $Matches[1] }
  }
}
if ($script:LegacyResult -in @('quarantined', 'removed')) {
  # Its keep-alive tasks go too, and the distribution is stopped so nothing of the old runner keeps running.
  foreach ($t in @($RunnerTaskName, $OldTaskName)) {
    $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if ($task -and (Test-OurKeepAliveTask $task $LegacyDistro)) {
      try { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction Stop; Write-Info "Removed the old runner's task $t." } catch { Write-Info "Could not remove the task ${t}: $($_.Exception.Message)" }
    }
  }
  & wsl.exe --terminate $LegacyDistro 2>&1 | Out-Null
  Complete-Step "The older runner in $LegacyDistro is stopped and $($script:LegacyResult)"
} elseif ($script:LegacyResult -eq 'kept') {
  Complete-Step "The runner in $LegacyDistro is kept"
} else {
  Complete-Step 'No older runner on this PC'
}

$WslMode = [string]$env:GUILDWISE_WSL_DISTRO
if (-not $WslMode) { $WslMode = if ($script:LegacyResult -eq 'kept') { 'default' } else { 'dedicated' } }
if ($WslMode -notin @('dedicated', 'default')) { Stop-Install "GUILDWISE_WSL_DISTRO is dedicated or default (it is $WslMode)." 'Fix it, then run the command again.' }
if ($WslMode -eq 'dedicated' -and $script:LegacyResult -eq 'kept') {
  Stop-Install "A runner is still installed in $LegacyDistro." 'Keep it there: set GUILDWISE_WSL_DISTRO=default. Replace it with the isolated runner: set GUILDWISE_LEGACY=quarantine. Then run the command again.'
}
if ($WslMode -eq 'dedicated') { Install-DedicatedDistro }
Write-Warn 'No isolation from Windows: the runner can start Windows programs and write your Windows profile (you chose your own Ubuntu; the default is a separate guildwise-runner distribution).'
Send-Report $script:CurrentStep 'warn' 'default WSL distribution: no isolation from Windows'

# ---- 3. Ubuntu --------------------------------------------------------------------------------------------------------------
Start-Step 'Installing Ubuntu'
$Distro = Get-Distros | Where-Object { $_ -like 'Ubuntu*' } | Select-Object -First 1
if (-not $Distro) {
  Write-Info 'Downloading Ubuntu (this can take a few minutes) ...'
  $ubuntuOut = ''
  & wsl.exe --install -d Ubuntu --no-launch 2>&1 | Tee-Object -Variable ubuntuOut | Out-Host
  $ubuntuOut = ($ubuntuOut | Out-String) -replace "`0", ''
  $Distro = Get-Distros | Where-Object { $_ -like 'Ubuntu*' } | Select-Object -First 1
  if (-not $Distro) {
    $ubuntuExe = Get-Command ubuntu.exe -ErrorAction SilentlyContinue
    if ($ubuntuExe) { & $ubuntuExe.Source install --root 2>&1 | Out-Host }
    $Distro = Get-Distros | Where-Object { $_ -like 'Ubuntu*' } | Select-Object -First 1
  }
  if (-not $Distro) {
    if ((Get-State).ubuntuRestartRequested -and (Test-RestartedSince)) {
      Set-StateValue 'ubuntuRestartRequested' $false
      $listed = (& wsl.exe -l -q 2>&1 | Out-String) -replace "`0", ''
      Stop-Install (Format-WslFailure 'Ubuntu is still not installed after a restart.' "$ubuntuOut $listed") "Open PowerShell and run: wsl --install -d Ubuntu   Then run the same command again. Help: $VirtHelp"
    }
    Set-StateValue 'ubuntuRestartRequested' $true
    Request-Restart 'to finish installing Ubuntu'
  }
}
Set-StateValue 'ubuntuRestartRequested' $false
# A Store distribution that was just installed still has to be registered: running a command does that. It also shows
# whether WSL2 can start at all: stop only on a virtualization error, so the user is not asked for an Ubuntu password first.
$probe = (& wsl.exe -d $Distro -u root -- true 2>&1 | Out-String) -replace "`0", ''
if ($LASTEXITCODE -ne 0 -and $probe -match $VirtErrorPattern) {
  Stop-Install (Format-WslFailure 'Ubuntu could not start.' $probe) "Help: $VirtHelp"
}
$LinuxUser = (& wsl.exe -d $Distro -- whoami 2>$null | Out-String).Trim()
if (-not $LinuxUser -or $LinuxUser -eq 'root') {
  Write-Host ''
  Write-Host '    Ubuntu needs a user name and a password. They are only for Ubuntu on this PC (not your Windows password).'
  do {
    $LinuxUser = (Read-Host '    Choose a user name (lowercase letters and digits)').Trim().ToLower()
  } until ($LinuxUser -match '^[a-z_][a-z0-9_-]{0,30}$')
  do {
    $secure = Read-Host '    Choose a password' -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  } until ($plain)
  $made = Invoke-WslBash $Distro 'root' "id -u '$LinuxUser' >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo '$LinuxUser'; echo ready"
  if ($made.Text -notmatch 'ready') { Stop-Install (Format-WslFailure 'Could not create the Ubuntu user.' $made.Text) 'Run the command again.' }
  $pwB64 = ConvertTo-Base64Unix "$LinuxUser`:$plain"
  $null = & wsl.exe -d $Distro -u root -- bash -c "echo $pwB64 | base64 -d | chpasswd" 2>&1
  $plain = $null
  $pwB64 = $null
  Complete-Step "Ubuntu user '$LinuxUser' created"
} else {
  Complete-Step "Ubuntu ($Distro) is ready for user '$LinuxUser'"
}

# ---- 4. systemd inside Ubuntu ---------------------------------------------------------------------------------------------
Start-Step 'Turning on systemd in Ubuntu (so the runner can start by itself)'
$wslConf = @"
set -e
f=/etc/wsl.conf
touch "`$f"
changed=0
if ! grep -Eq '^[[:space:]]*systemd[[:space:]]*=[[:space:]]*true' "`$f"; then
  sed -i '/^[[:space:]]*systemd[[:space:]]*=/d' "`$f"
  if grep -q '^\[boot\]' "`$f"; then sed -i '/^\[boot\]/a systemd=true' "`$f"; else printf '\n[boot]\nsystemd=true\n' >> "`$f"; fi
  changed=1
fi
if ! grep -Eq '^[[:space:]]*default[[:space:]]*=' "`$f"; then
  printf '\n[user]\ndefault=%s\n' '$LinuxUser' >> "`$f"
  changed=1
fi
if [ "`$changed" = 1 ]; then echo changed; else echo unchanged; fi
"@
$r = Invoke-WslBash $Distro 'root' $wslConf
if ($r.Text -notmatch 'changed|unchanged') { Stop-Install (Format-WslFailure 'Could not set systemd=true in /etc/wsl.conf.' $r.Text) 'Run the command again.' }
if ($r.Text -match 'changed' -and $r.Text -notmatch 'unchanged') {
  & wsl.exe --terminate $Distro 2>&1 | Out-Null
  Write-Info 'systemd switched on; Ubuntu is restarting.'
}
Complete-Step 'systemd=true and the default user are set in /etc/wsl.conf'

# ---- 5. keep WSL alive (.wslconfig) -----------------------------------------------------------------------------------------
Start-Step 'Keeping Ubuntu running in the background'
Register-KeepAlive $Distro
Complete-Step "vmIdleTimeout=-1 is set and the $RunnerTaskName task starts Ubuntu when you sign in"

# ---- 6. let the Ubuntu user run services without a login ----------------------------------------------------------------
Start-Step 'Starting Ubuntu services'
$r = Wait-Systemd $Distro $LinuxUser
if ($r.Text -match 'running|degraded') { Complete-Step 'systemd is running in Ubuntu' }
else { Write-Warn "systemd did not report ready ($($r.Text)). The installer continues and will tell you if the service could not start."; Send-Report $script:CurrentStep 'warn' $r.Text }

# ---- 7. the Linux installer ------------------------------------------------------------------------------------------------
Start-Step 'Running the Linux installer inside Ubuntu'
Write-Info 'The next lines come from Ubuntu. It may ask for your Ubuntu password to install tools.'
$env:GUILDWISE_NAME = if ($DefaultName) { $DefaultName } else { "$env:COMPUTERNAME (WSL2)" }
$env:GUILDWISE_SCRIPT = $LinuxScriptPath
# Your choices travel with it (WSLENV); GUILDWISE_RUNNER_USER too, since here the runner may run as you or as its own user.
$env:WSLENV = (@('GUILDWISE_NAME/u', 'GUILDWISE_SCRIPT/p', 'GUILDWISE_RUNNER_USER/u') + @($ForwardedVars | ForEach-Object { "$_/u" })) -join ':'
# The command carries no quote characters of its own (Windows PowerShell 5.1 strips embedded double quotes from native
# arguments, which would split a path with spaces such as C:\Users\Jane Doe): the line to run travels as base64.
$runB64 = ConvertTo-Base64Unix 'exec bash "$GUILDWISE_SCRIPT"'
& wsl.exe -d $Distro -u $LinuxUser --cd '~' -- bash -c "echo $runB64 | base64 -d | bash"
$code = $LASTEXITCODE

# ---- 8. summary -------------------------------------------------------------------------------------------------------------
Start-Step 'Finishing'
if ($code -eq 0) {
  Complete-Step 'The runner is installed in Ubuntu and starts when you sign in to Windows'
  Write-Host ''
  Write-Host "$AppName is ready." -ForegroundColor Green
  Write-Host "  Open $ServerUrl/workstations to see this PC, then hire an agent onto it."
  Write-Host '  Run the same command again any time to upgrade or repair.'
} else {
  Stop-Install "The Linux installer inside Ubuntu finished with problems (exit code $code)." 'Read the lines above (they come from Ubuntu), fix what they say, and run the command again.'
}
Read-Host 'Press Enter to close this window' | Out-Null

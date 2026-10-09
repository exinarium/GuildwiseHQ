# ---------------------------------------------------------------------------------------------------------------------
# Windows: turns on WSL2 and Ubuntu, keeps them running, then runs the Linux installer inside Ubuntu.
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
$script:StepTotal = 8
$script:CurrentStep = 'installer'

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
  return [pscustomobject]@{ rebootRequested = $false }
}
function Save-State($State) { $State | ConvertTo-Json | Set-Content -Path $StatePath -Encoding ASCII }

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

function Request-Restart([string]$Reason) {
  $state = Get-State
  $state.rebootRequested = $true
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
$features = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform') | ForEach-Object { Get-WindowsOptionalFeature -Online -FeatureName $_ -ErrorAction Stop }
$missing = @($features | Where-Object { $_.State -ne 'Enabled' })
if ($missing.Count -gt 0) {
  Write-Info 'Enabling the Windows features WSL2 needs ...'
  & wsl.exe --install --no-distribution 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    foreach ($f in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
      Enable-WindowsOptionalFeature -Online -FeatureName $f -NoRestart -All -ErrorAction Stop | Out-Null
    }
  }
  Request-Restart 'to finish turning on WSL2'
}
& wsl.exe --update 2>&1 | Out-Null
& wsl.exe --set-default-version 2 2>&1 | Out-Null
Complete-Step 'WSL2 is on'

# ---- 3. Ubuntu --------------------------------------------------------------------------------------------------------------
Start-Step 'Installing Ubuntu'
$Distro = Get-Distros | Where-Object { $_ -like 'Ubuntu*' } | Select-Object -First 1
if (-not $Distro) {
  Write-Info 'Downloading Ubuntu (this can take a few minutes) ...'
  & wsl.exe --install -d Ubuntu --no-launch 2>&1 | Out-Host
  $Distro = Get-Distros | Where-Object { $_ -like 'Ubuntu*' } | Select-Object -First 1
  if (-not $Distro) {
    $ubuntuExe = Get-Command ubuntu.exe -ErrorAction SilentlyContinue
    if ($ubuntuExe) { & $ubuntuExe.Source install --root 2>&1 | Out-Host }
    $Distro = Get-Distros | Where-Object { $_ -like 'Ubuntu*' } | Select-Object -First 1
  }
  if (-not $Distro) { Request-Restart 'to finish installing Ubuntu' }
  # A Store distribution that was just installed still has to be registered: running a command does that.
  & wsl.exe -d $Distro -u root -- true 2>&1 | Out-Null
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
  if ($made.Text -notmatch 'ready') { Stop-Install "Could not create the Ubuntu user: $($made.Text)" 'Run the command again.' }
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
if ($r.Text -notmatch 'changed|unchanged') { Stop-Install "Could not set systemd=true in /etc/wsl.conf: $($r.Text)" 'Run the command again.' }
if ($r.Text -match 'changed' -and $r.Text -notmatch 'unchanged') {
  & wsl.exe --terminate $Distro 2>&1 | Out-Null
  Write-Info 'systemd switched on; Ubuntu is restarting.'
}
Complete-Step 'systemd=true and the default user are set in /etc/wsl.conf'

# ---- 5. keep WSL alive (.wslconfig) -----------------------------------------------------------------------------------------
Start-Step 'Keeping Ubuntu running in the background'
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
Register-ScheduledTask -TaskName 'WSL Boot' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Keeps Ubuntu running so the $AppName runner stays online." -Force -ErrorAction Stop | Out-Null
if ($configChanged) { & wsl.exe --shutdown 2>&1 | Out-Null }
Start-ScheduledTask -TaskName 'WSL Boot'
Complete-Step 'vmIdleTimeout=-1 is set and the "WSL Boot" task starts Ubuntu when you sign in'

# ---- 6. let the Ubuntu user run services without a login ----------------------------------------------------------------
Start-Step 'Starting Ubuntu services'
$settle = @"
for i in `$(seq 1 40); do
  s=`$(systemctl is-system-running 2>/dev/null || true)
  case "`$s" in running|degraded) break ;; esac
  sleep 1
done
loginctl enable-linger '$LinuxUser' >/dev/null 2>&1 || true
systemctl is-system-running 2>/dev/null || true
"@
$r = Invoke-WslBash $Distro 'root' $settle
if ($r.Text -match 'running|degraded') { Complete-Step 'systemd is running in Ubuntu' }
else { Write-Warn "systemd did not report ready ($($r.Text)). The installer continues and will tell you if the service could not start."; Send-Report $script:CurrentStep 'warn' $r.Text }

# ---- 7. the Linux installer ------------------------------------------------------------------------------------------------
Start-Step 'Running the Linux installer inside Ubuntu'
Write-Info 'The next lines come from Ubuntu. It may ask for your Ubuntu password to install tools.'
$env:GUILDWISE_NAME = if ($DefaultName) { $DefaultName } else { "$env:COMPUTERNAME (WSL2)" }
$env:GUILDWISE_SCRIPT = $LinuxScriptPath
$env:WSLENV = 'GUILDWISE_NAME/u:GUILDWISE_SCRIPT/p'
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

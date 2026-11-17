# GWP-253: Windows installer names virtualization off in the BIOS; restart wording in the guide and help

## Question

1. When hardware virtualization is off in the BIOS/UEFI, WSL 2 cannot run. The Windows installer does not say so, and with an older (inbox) wsl.exe, step 2 can pass and the run then stops at step 3 with a message that does not mention the BIOS. How should the installer detect this, without relying on wsl.exe, and without ever stopping a PC whose virtualization works?
2. Where do the user guide and in-app help still say Windows restarts "once", and how should they read?

## Findings

### The installer today (`apps/server/src/installer/templates/windows.ps1`)

- Step 1 "Checking this PC" (line ~191) checks the Windows build only.
- Step 2 "Turning on WSL2" (lines 201-252) decides by `Get-WslReadiness` (line 125). That function reads the optional-feature states (`Get-WindowsOptionalFeature`) **and** the exit code of `wsl.exe --status`. Nothing reads the hardware or hypervisor state.
- **How the old wsl.exe gets through step 2.** The inbox wsl.exe has no `--status`, so `Ready` is false. Once both features are `Enabled`, line 235-237 runs `wsl.exe --set-default-version 2`. That only writes a setting and does not start a VM, so it succeeds with virtualization off and sets `$wsl.Ready = $true`. Step 3 then runs `wsl --install -d Ubuntu`, which fails (typically `0x80370102`, "a required feature is not installed"). Its output goes to `Out-Host` and is not kept. The installer asks for a restart "to finish installing Ubuntu", and after the restart it stops with "Ubuntu is still not installed after a restart". The BIOS is not mentioned.
- The existing "WSL2 is still not ready" stop (line 245) names the BIOS only in `$Todo`.
- **The web app never sees `$Todo`.** `Stop-Install` (line 41) reports `Send-Report $script:CurrentStep 'fail' $What` and `summary ... "failed: $What"`. `$Todo` is only printed in the console. `Send-Report` truncates the detail to 400 characters, which is also the limit of `installerProgressRequest.detail` in `packages/shared/src/api/installer.ts:45`. The server stores the detail as it comes (`apps/server/src/commands/installer.ts:200`), and the wizard shows the last failed step's `detail` (`AddWorkstationWizard.tsx:431`, `InstallFailure reason=...`). So **the BIOS text must be in `$What`, near its start**, or AC 6 fails.
- No server, route or shared type change is needed: `step`, `status` (`fail`/`warn`) and `detail` already carry everything.
- `$ServerUrl/help/install-troubleshooting#<anchor>` deep links work: see the comment in `apps/web/src/pages/Help.tsx:198`. The wizard's failure screen already links to `/help/install-troubleshooting`.
- `apps/server/scripts/render-installers.ts` writes to `./installer-out`. Its output is not committed and no CI step uses it, so the template is the only file that changes. `pwsh` is not installed on this workstation and CI has no PSScriptAnalyzer step, so test plan item 5 (a parse check) cannot run here.

### Reading virtualization without wsl.exe

Both values are built-in WMI properties (Windows 8 and later), read with `Get-CimInstance`, which the template already uses (`Get-BootTime`):

| Property | Meaning | Known caveat |
| --- | --- | --- |
| `Win32_ComputerSystem.HypervisorPresent` | A hypervisor is running. | True inside **any** VM guest (the host's hypervisor), whether nested virtualization is on or not. |
| `Win32_Processor.VirtualizationFirmwareEnabled` | The firmware has turned on VT-x/AMD-V. | Reads **False when a hypervisor is already running** (Hyper-V owns the extensions, which is why `systeminfo` then says "A hypervisor has been detected"). There are also community reports of False on machines where virtualization is on, mostly with an outdated BIOS. |

Two conclusions follow:

1. A hard stop on "no hypervisor and firmware flag false" alone would break the constraint "never stop a machine whose virtualization works", because of the false-False reports. It needs one more fact before it may stop.
2. That fact is the optional feature **VirtualMachinePlatform = `Enabled`**, read with `Get-WindowsOptionalFeature`, not wsl.exe. `Enabled` (as opposed to `EnablePending`) means Windows has restarted with the feature on. At that boot, Windows starts the hypervisor if the CPU and firmware allow it (hypervisorlaunchtype Auto is the default). **VMP Enabled, no hypervisor running, and the firmware flag False** is therefore strong evidence that virtualization cannot be used. A machine with a misreporting flag but working virtualization has a running hypervisor by then, so it passes.

VM guests: `HypervisorPresent` is True, so the check passes and the run behaves as today. If nested virtualization is off, a later WSL error gets the hint, and the hint text also mentions nested virtualization for VMs. **Consequence for the manual test plan:** cases 6 and 7 ("VM with nested virtualization off") cannot show the step-2 stop, because by AC 1's own definition such a VM has a hypervisor running. The stop path has to be tested on a **physical PC with VT-x/SVM switched off in the firmware**. A VM run shows the later-hint path (AC 5) instead.

Windows on ARM: ARM64 has no BIOS virtualization switch, and WMI may report the flag as False. If any processor reports `Architecture` 5 or 12 (ARM/ARM64), the result is never `off`, only `unknown`.

## Options compared

| | A. Stop when no hypervisor and flag False (the planner's brief) | B. Warn when the flag alone says off; stop only once VMP is Enabled and still no hypervisor (recommended) | C. Only add hints to later messages |
| --- | --- | --- | --- |
| VT off, fresh PC | Stops on the first run, before any restart. | Warns with the BIOS text at step 2 on the first run (console and web app), continues, asks for the usual restart, then **stops at step 2** on the run after the restart with the BIOS message. | Fails at step 2 or 3 with a hint. |
| Old wsl.exe, VT off | Stops at step 2. | Stops at step 2, before `--set-default-version 2` can fake "ready". | Still fails at step 3 (now with a hint). AC 2 not met. |
| Working PC whose firmware flag misreports False | **Falsely stopped, with no way past it.** Breaks a hard constraint. | Warns on the first run, then passes after the restart (hypervisor running). | Fine. |
| Hypervisor running (WSL 2 / Hyper-V) | Pass. | Pass. | Fine. |
| AC 1 ("stops no later than step 2") | Met. | Met: the stop is in step 2, on the run after the restart. The BIOS warning shows on the first run. | Not met. |

B costs one restart that does not help on a VT-off PC, but the user sees the BIOS warning before that restart and can fix it in the same reboot. A never blocks a working machine only if the WMI flag is always right, and it is known not to be. **Recommendation: B**, plus the later-step hints from C.

Rejected detail: on a virtualization error in step 3 the installer could stop instead of asking for the Ubuntu restart. That changes the restart-loop behaviour the card says to keep, and B already catches physical VT-off PCs in step 2. Not done.

## Design

All changes are in `apps/server/src/installer/templates/windows.ps1` (product code), the tests, and the docs. `render.ts`, the bash templates (`common.sh`, `linux.sh`, `macos.sh`), the server routes and commands, and the shared types do not change. Keep the template **ASCII only** (an existing test enforces this): no typographic quotes or dashes in the new messages.

### 1. Helpers (next to `Get-WslReadiness`)

```powershell
# Whether this PC can run WSL2's virtual machine, read from Windows itself (never from wsl.exe: an older wsl.exe looks
# fine on a PC with virtualization off). 'pass': a hypervisor runs, or the firmware has virtualization on.
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
```

Notes for the builder:
- PowerShell `$null -eq $false` is False, and `$null -ne $false` is True. So a missing property (`$null`) never counts as "off". That is the intent: unknown never stops the installer.
- `Get-WindowsOptionalFeature` needs administrator rights. The installer already holds them at step 2 (it re-launches elevated in "step 0").
- `$VirtHelp` and `$VirtHint` must be set after `$ServerUrl` exists. The render header defines it before the template body (check `render.ts`).

### 2. Step 2: the check, before anything that uses wsl.exe

Insert right after the `$wslRestarts` bookkeeping (line 204) and **before** `$wsl = Get-WslReadiness`:

```powershell
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
```

- The stop happens in step 2 (`CurrentStep` = "Turning on WSL2 (Linux on Windows)"), so the web app shows that step as failed with the BIOS text at the start of the detail. The `(detail)` is short (about 110 characters), so the whole message stays well under 400 characters.
- `Set-StateValue 'wslRestarts' 0` mirrors the existing final stop. After a BIOS fix the run starts with a fresh allowance. Nothing else in the restart loop changes: no new `Request-Restart`, and the state fields and the RunOnce resume are untouched.
- With an old wsl.exe on a VT-off PC: the first run warns (`maybe-off`), `wsl --install`/`Enable-WslFeatures` turn the features on, and the installer asks for the restart as today. On the next run VMP is `Enabled` with no hypervisor, so the run stops here, **before** line 236's `--set-default-version 2` can mark it ready. AC 2 is met.

### 3. Later messages name the BIOS (AC 5 and 6)

- **Step 2 final stop (line 245).** Put the hint in `$What` before the long summary: `Stop-Install "WSL2 is still not ready. $VirtHint $detail." $todo`, with `$todo` ending in `Help: $VirtHelp`. The existing test asserting the old literal string must be updated.
- **Step 3, Ubuntu install.** Keep the output of `wsl.exe --install -d Ubuntu --no-launch`. Use `2>&1 | Tee-Object -Variable ubuntuOut | Out-Host` so the user still sees the progress lines; strip the NULs. Then use `Format-WslFailure "Ubuntu is still not installed after a restart." "$ubuntuOut $listed"` in the existing stop at line 270. The restart request at line 273 stays as it is.
- **Step 3, start probe.** Before `whoami` (line 279), run `$probe = & wsl.exe -d $Distro -u root -- true 2>&1` for every run, not only right after the install (it replaces line 276). If `$LASTEXITCODE -ne 0` and the cleaned output matches `$VirtErrorPattern`, call `Stop-Install (Format-WslFailure 'Ubuntu could not start.' $probe) "Help: $VirtHelp"`. This stops before the user is asked to choose a Ubuntu user name and password on a VM that cannot start. Any other failure carries on as today.
- **Step 3 "Could not create the Ubuntu user" (line 291)** and **step 4 "Could not set systemd=true" (line 320):** wrap them as `Format-WslFailure 'Could not create the Ubuntu user.' $made.Text` and `Format-WslFailure 'Could not set systemd=true in /etc/wsl.conf.' $r.Text`. The hint is added only when the output looks like a virtualization error or the check did not pass, so the text of an ordinary failure on a healthy PC stays as it is (apart from the "Output:" label).
- Steps 5-8 and the global `trap` stay as they are. Nothing there starts the WSL VM for the first time.

### 4. Docs and in-app help

Keep every heading and `{#anchor}`. Add one new section, no renames.

- `docs/USER-GUIDE.md` section 3.4, step 4 (line 311). It no longer says "once" (an earlier change already made it "at most twice"), but it is still wrong: step 3 can ask for one more restart for Ubuntu. Suggested text: "Windows may ask you to restart, possibly more than once (up to twice to turn on WSL2 and once more for Ubuntu). After each restart, sign in: the installer opens again by itself; if it does not, run the command again. WSL2 needs virtualization (Intel VT-x, AMD-V or SVM) turned on in the PC's BIOS/UEFI settings: if it is off, the installer says so at step 2; turn it on, restart and run the installer again."
- `docs/USER-GUIDE.md` 9.1 table (line 2009): reword the "Windows asked to restart" row the same way (more than once, run again after each restart). Add a row "It says virtualization is off in the BIOS/UEFI": open the BIOS/UEFI settings at start-up (often F2, F10, F12 or Del, or from Windows: Settings > System > Recovery > Advanced start-up > UEFI firmware settings), turn on Intel VT-x / Virtualization Technology, or SVM / AMD-V, save, restart and run the installer again. A new table row does not touch the contents block (`guideOutline` and the TOC test are unaffected). `docs/guide/guide.html` is generated by `docs/guide/build-guide.mjs`: do not hand-edit it.
- `apps/web/src/help/articles/install-troubleshooting.md`:
  - `## Windows asked me to restart {#windows-restart}`: replace "needs one restart" with "can need more than one restart (up to two for WSL2 and one more for Ubuntu)". After each restart, sign in or run the command again. Keep the closing sentence on the BIOS/`wsl --install` and link it to the new section.
  - New section right after it: `## It says virtualization is off in the BIOS/UEFI (Windows) {#windows-virtualization}`. Cover what it means, how to reach the firmware settings, the setting names (Intel VT-x / Virtualization Technology, AMD SVM / AMD-V), and to save, restart and run the installer again. Mention that a virtual machine needs nested virtualization turned on in its host, and that a PC without such a setting may have a processor that cannot run WSL2. This anchor is the target of `$VirtHelp`.
  - Update the front-matter `summary`/keywords only if needed (adding "virtualization, BIOS" to the keywords helps the help search and the assistant topic ranking).
- `apps/web/src/help/articles/workstations-and-installer.md` line 28 (Add a workstation, step 4) and the `## Windows {#windows}` section (line 75): "Windows may ask to restart, possibly more than once; after each restart the installer carries on by itself when you sign in (or run the command again). WSL2 needs virtualization turned on in the BIOS/UEFI: see [Installer troubleshooting](/help/install-troubleshooting#windows-virtualization)."
- **Regenerate the assistant pack:** `pnpm --filter @aom/server assistant:pack`, then commit `apps/server/src/assistant/pack/**`. `apps/server/test/assistant-pack.test.ts` ("is up to date") fails otherwise. `apps/server/src/assistant/pack/topics/install-troubleshooting.md` line 5 still says "needs one restart" and is regenerated from the article.
- After the edit, grep the guide, both articles and the pack for "one restart" and "restart once". Nothing should remain.

### 5. Tests (`apps/server/test/installer-render.test.ts`)

New test "Windows step 2 checks virtualization before anything that uses wsl.exe", on `renderPowerShell(win)` with CRLF normalised:
- `step2.indexOf('Get-Virtualization')` < `step2.indexOf('Get-WslReadiness')`, < `indexOf('wsl.exe --install --no-distribution')` and < `indexOf('--set-default-version 2')`.
- The function body contains no `wsl.exe` (slice from `function Get-Virtualization` to the next `function `). This is the "does not depend on wsl.exe" rule.
- It contains `Win32_ComputerSystem`, `HypervisorPresent -eq $true` returning `'pass'` (the hypervisor-running pass), `VirtualizationFirmwareEnabled`, the `VirtualMachinePlatform` / `'Enabled'` condition for `off`, and `Architecture -in 5, 12`.
- Step 2 contains `Stop-Install "Virtualization is off in the BIOS/UEFI` with `Intel VT-x, AMD-V or SVM`, `restart the PC and run the installer again`, and `install-troubleshooting#windows-virtualization`. Only the `'off'` branch calls `Stop-Install`; the `maybe-off` and `unknown` branches call `Send-Report ... 'warn'` and no stop. The BIOS sentence sits at the start of the `$What` argument, not only in `$Todo`, which covers AC 6.
- The step 2 final stop's `$What` contains `$VirtHint`. Step 3 uses `Format-WslFailure` for the Ubuntu-not-installed stop and the start probe, and step 4 uses it for the systemd stop. `$VirtErrorPattern` contains `0x80370102`.
- The restart loop is unchanged: the existing step 2/3 tests still pass. `Request-Restart` counts stay at 1 per step. Update only the one literal assertion on the final stop.
- Bash unchanged (AC 7): the bash templates and `renderBash` are not edited. Prove it once in the hand-off by rendering `render-installers.ts` output on the base commit and on the branch and comparing `install-linux.sh` and `install-macos.sh` with `cmp`. A permanent hash test would fail on every future bash change, so it is not added. The existing `script quality` tests (bash -n, shellcheck when present) keep covering the bash output.

Also run `packages/shared` `user-guide.test.ts` and `guide-path.test.ts`, `apps/web` `help.test.tsx`, and `apps/server` `assistant-pack.test.ts`.

## Acceptance criteria mapped

| AC | Design |
| --- | --- |
| 1. No hypervisor, VT off: stop no later than step 2, BIOS/restart/re-run, help link | Section 2: `off` stop in step 2. On a fresh PC the first run warns with the same text and help link (`maybe-off`); the stop comes on the run after the WSL restart, still in step 2. **Physical PC only** (see Findings). |
| 2. Old wsl.exe now stops at the check | Section 2: the check precedes `Get-WslReadiness` and `--set-default-version 2`, and it reads only WMI and the feature state. |
| 3. Hypervisor running, flag false: pass | `HypervisorPresent -eq $true` returns `pass` first. |
| 4. VT on, no hypervisor yet: pass | Firmware flag True returns `pass`. A misreporting flag gives `maybe-off`, a warning only, never a stop before VMP is Enabled. |
| 5. Later WSL 2 error names the BIOS | Section 3: `$VirtHint` in the step-2 final stop, plus `Format-WslFailure` in steps 3-4 and the start probe. |
| 6. Web app shows the BIOS cause | The BIOS text is at the start of `$What`, which is what `Send-Report ... 'fail'` sends (400-character limit). The warnings are sent as `warn` too. No server change. |
| 7. Rendered PowerShell has the check; bash unchanged | The template change is what both the route and `render-installers.ts` serve. Tests in section 5; bash shown with `cmp`. |
| 8. USER-GUIDE: no "once", repeated restarts, BIOS note | Section 4. |
| 9. Help articles match; guide tests pass | Section 4, plus the pack regeneration. |
| 10. Tests pass plus new ones | Section 5. |

## Risks

- **No real Windows here.** The WMI behaviour (the flag reading False under a running hypervisor, `HypervisorPresent` in guests, ARM values) comes from documentation and community reports, not from a run. The hand-off must say so. Manual cases 6-10 need a Windows tester. Cases 6 and 7 need a **physical** PC with VT/SVM off (a VM shows a running hypervisor). Expected on such a PC: a warning on the first run, a restart, then the step-2 stop. If no Windows run is possible, record cases 6-10 as not run.
- **The step-3 start probe** now runs on every install (one `wsl.exe ... true`). It is harmless, but it is a new wsl call on already-installed PCs. It only stops on a virtualization-pattern match.
- **hypervisorlaunchtype off** (some users switch it off for other VM software) together with a misreporting firmware flag could still give `off`. That needs two rare conditions at once. The help section can mention `bcdedit /set hypervisorlaunchtype auto` as a second thing to check.
- **No PowerShell parser in CI.** Ask the tester or DevOps on Windows to run `[System.Management.Automation.Language.Parser]::ParseFile('install-windows.ps1', [ref]$null, [ref]$errs)` on the `render-installers.ts` output, or a PSScriptAnalyzer pass.

Sources: [Win32_Processor class](https://learn.microsoft.com/windows/win32/cimwin32prov/win32-processor), [Use PowerShell to detect if a hypervisor is present (Scripting Blog)](https://devblogs.microsoft.com/scripting/use-powershell-to-detect-if-hypervisor-is-present/), [Stack Overflow: proper way to check if Hyper-V is running](https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/63191833/what-is-the-proper-way-to-check-if-hyperv-is-running), [AskWoody: wrong Win32_Processor value persists from 1903](https://www.askwoody.com/forums/topic/error-persists-from-1903-w-win32_processor-class-in-powershell).

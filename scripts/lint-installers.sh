#!/usr/bin/env bash
# Renders the workstation installers with sample values and lints them:
#   bash -n and shellcheck (the local binary, else the koalaman/shellcheck image if Docker is available),
#   the PowerShell parser and PSScriptAnalyzer when `pwsh` is installed (skipped otherwise).
# Usage: scripts/lint-installers.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
pnpm --filter @aom/server exec tsx scripts/render-installers.ts "$OUT" >/dev/null

status=0
for f in "$OUT"/install-linux.sh "$OUT"/install-macos.sh; do bash -n "$f" || status=1; done

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x -s bash "$OUT"/install-linux.sh "$OUT"/install-macos.sh || status=1
elif command -v docker >/dev/null 2>&1; then
  docker run --rm -v "$OUT:/mnt:ro" koalaman/shellcheck:stable -x -s bash /mnt/install-linux.sh /mnt/install-macos.sh || status=1
else
  echo "shellcheck and docker are not available: skipped shellcheck" >&2
fi

if command -v pwsh >/dev/null 2>&1; then
  pwsh -NoProfile -Command '
    $errs = $null; $tokens = $null
    [System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$errs) | Out-Null
    if ($errs.Count) { $errs | ForEach-Object { $_.ToString() }; exit 1 }
    if (Get-Module -ListAvailable PSScriptAnalyzer) {
      $r = Invoke-ScriptAnalyzer -Path $args[0] -Severity Error,Warning -ExcludeRule PSAvoidUsingWriteHost,PSAvoidUsingEmptyCatchBlock,PSAvoidUsingPositionalParameters,PSUseShouldProcessForStateChangingFunctions,PSUseSingularNouns
      if ($r) { $r | ForEach-Object { "{0} line {1}: {2}" -f $_.RuleName,$_.Line,$_.Message }; exit 1 }
    } else { Write-Host "PSScriptAnalyzer not installed: only parsed" }
  ' "$OUT/install-windows.ps1" || status=1
else
  echo "pwsh is not available: skipped the PowerShell checks" >&2
fi
exit "$status"

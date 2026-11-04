import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How to run one of the runner's own scripts. Bundled (`dist/aom-runner.mjs` next to `dist/aom.mjs`): plain node.
 * From source (dev, vitest): through the tsx CLI so no build is needed.
 */
export function selfCommand(script: 'aom' | 'mock-agent'): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, `${script}.mjs`);
  if (existsSync(bundled)) return [process.execPath, bundled];
  const src = script === 'aom' ? join(here, 'aom', 'aom-cli.ts') : join(here, 'adapters', 'mock-agent.ts');
  try {
    const pkg = createRequire(import.meta.url).resolve('tsx/package.json');
    return [process.execPath, join(dirname(pkg), 'dist', 'cli.mjs'), src];
  } catch {
    return ['tsx', src];
  }
}

const q = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;

/**
 * Local test services (GWP-41): bash that starts one `socat` listener per `AOM_TEST_SERVICES` entry (`127.0.0.1:5433,[::1]:6379`)
 * inside the current network namespace and tunnels it through the Claude Code sandbox's proxy (`HTTPS_PROXY`, with its
 * per-session credential) the way git-over-SSH does. The proxy lets through only the exact `host:port` entries of the
 * sandbox settings, so editing `AOM_TEST_SERVICES` opens nothing. The proxy URL is never printed. Without a usable proxy
 * nothing is listened on and the services stay closed.
 *
 * Shared by `aom-env` and `bin/aom-bridges.sh` (sourced through `BASH_ENV` in tester shifts, GWP-102), so it:
 * - runs once per shell (`_aom_bridged` = `$$`) and skips a port that already has a listener (a nested bash, or aom-env
 *   inside an auto-bridged call, starts no second socat);
 * - detaches every socat from the caller's output (or the Bash tool would wait for the inherited pipe) and, with
 *   `setpriv`, ties it to the shell's life (`--pdeathsig KILL`), so no listener outlives the call; it installs no trap;
 * - prints nothing when `_aom_quiet` is set; the started pids are in `_aom_pids` for aom-env's own cleanup.
 */
export const TEST_SERVICE_BRIDGE = `if [ -n "\${AOM_TEST_SERVICES:-}" ] && [ "\${_aom_bridged:-}" != "$$" ]; then
  _aom_bridged=$$
  _aom_pids=()
  _aom_proxy="\${HTTPS_PROXY:-\${https_proxy:-}}"
  _aom_re='^https?://(([^:@/]+):([^@/]+)@)?([^:/@]+):([0-9]+)/?$'
  if ! command -v socat >/dev/null 2>&1; then
    [ -n "\${_aom_quiet:-}" ] || echo "aom-env: socat is not installed on this machine, test services not reachable" >&2
  elif [[ ! "$_aom_proxy" =~ $_aom_re ]]; then
    [ -n "\${_aom_quiet:-}" ] || echo "aom-env: no sandbox proxy, test services not reachable" >&2
  else
    _aom_pauth=""; [ -n "\${BASH_REMATCH[2]}" ] && _aom_pauth=",proxyauth=\${BASH_REMATCH[2]}:\${BASH_REMATCH[3]}"
    _aom_phost="\${BASH_REMATCH[4]}"; _aom_pport="\${BASH_REMATCH[5]}"
    _aom_pd=(); command -v setpriv >/dev/null 2>&1 && _aom_pd=(setpriv --pdeathsig KILL)
    IFS=',' read -r -a _aom_svcs <<<"$AOM_TEST_SERVICES"
    for _aom_sv in "\${_aom_svcs[@]}"; do
      _aom_sport="\${_aom_sv##*:}"; _aom_shost="\${_aom_sv%:*}"
      case "$_aom_sport" in ''|*[!0-9]*) [ -n "\${_aom_quiet:-}" ] || echo "aom-env: ignoring test service '$_aom_sv'" >&2; continue ;; esac
      case "$_aom_shost" in
        '[::1]') _aom_listen="TCP6-LISTEN:$_aom_sport,bind=[::1],fork,reuseaddr"; _aom_hex="00000000000000000000000001000000:$(printf '%04X' "$_aom_sport")"; _aom_tbl=/proc/net/tcp6 ;;
        127.0.0.1|localhost) _aom_listen="TCP-LISTEN:$_aom_sport,bind=127.0.0.1,fork,reuseaddr"; _aom_hex="0100007F:$(printf '%04X' "$_aom_sport")"; _aom_tbl=/proc/net/tcp ;;
        *) [ -n "\${_aom_quiet:-}" ] || echo "aom-env: ignoring test service '$_aom_sv'" >&2; continue ;;
      esac
      grep -qi "$_aom_hex 0*:0000 0A" "$_aom_tbl" 2>/dev/null && continue
      "\${_aom_pd[@]}" socat "$_aom_listen" "PROXY:$_aom_phost:$_aom_shost:$_aom_sport,proxyport=$_aom_pport$_aom_pauth" </dev/null >/dev/null 2>&1 3<&- &
      _aom_pids+=($!)
      _aom_i=0
      while [ "$_aom_i" -lt 50 ]; do
        grep -qi "$_aom_hex 0*:0000 0A" "$_aom_tbl" 2>/dev/null && break
        sleep 0.1
        _aom_i=$((_aom_i + 1))
      done
    done
  fi
  unset _aom_proxy _aom_re _aom_pauth _aom_phost _aom_pport _aom_pd _aom_svcs _aom_sv _aom_sport _aom_shost _aom_listen _aom_hex _aom_tbl _aom_i
fi
`;

/**
 * `bin/aom-bridges.sh`: sourced by every bash of a tester shift that may reach test services (`BASH_ENV`, GWP-102), so a
 * plain `curl`, `psql` or Playwright in any Bash call finds the declared ports without `aom-env`. Silent, no trap.
 */
export const AOM_BRIDGES_SCRIPT = `# Sourced through BASH_ENV: bridges the declared local test services into this shell's network (see aom-env).
_aom_quiet=1
${TEST_SERVICE_BRIDGE}unset _aom_quiet _aom_pids
`;

/**
 * `bin/aom-env`: runs a command with the tester's environment reachable (docs/design/run-and-integration-tests.md D6).
 * Each Bash call of a sandboxed agent has a network namespace of its own, so the wrapper starts a `socat` per forwarded
 * port inside it (`AOM_ENV_FORWARDS` = `<port>=<unix socket>,...`; the runner listens on the sockets) and runs the command,
 * which then finds `localhost:<port>` where it is on the workstation. `--timeout <minutes>` kills the command's whole
 * process group when it hangs (exit status 124).
 *
 * Local test services (GWP-41): when `AOM_TEST_SERVICES` lists `host:port` pairs, the wrapper also bridges each port into
 * the command's network (`TEST_SERVICE_BRIDGE`); a port that already listens (bridged by `BASH_ENV`) is left as it is.
 */
export const AOM_ENV_SCRIPT = `#!/usr/bin/env bash
# aom-env [--timeout <minutes>] -- <command> [args...]
usage() { echo "usage: aom-env [--timeout <minutes>] -- <command> [args...]" >&2; exit 2; }
minutes=20
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) [ $# -ge 2 ] || usage; minutes="$2"; shift 2 ;;
    --timeout=*) minutes="\${1#--timeout=}"; shift ;;
    --) shift; break ;;
    -*) usage ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || usage
case "$minutes" in ''|*[!0-9]*) echo "aom-env: --timeout takes whole minutes" >&2; exit 2 ;; esac
[ "$minutes" -ge 1 ] || minutes=1
pids=()
cleanup() { for p in "\${pids[@]}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT
if [ -n "\${AOM_ENV_FORWARDS:-}" ]; then
  if ! command -v socat >/dev/null 2>&1; then echo "aom-env: socat is not installed on this machine" >&2; exit 127; fi
  IFS=',' read -r -a items <<<"$AOM_ENV_FORWARDS"
  for it in "\${items[@]}"; do
    port="\${it%%=*}"; sock="\${it#*=}"
    socat "TCP-LISTEN:$port,bind=127.0.0.1,fork,reuseaddr" "UNIX-CONNECT:$sock" >/dev/null 2>&1 &
    pids+=($!)
  done
  for it in "\${items[@]}"; do
    hex=$(printf '%04X' "\${it%%=*}")
    for _ in $(seq 1 50); do
      grep -qi "0100007F:$hex 00000000:0000 0A" /proc/net/tcp 2>/dev/null && break
      sleep 0.1
    done
  done
fi
_aom_quiet=
${TEST_SERVICE_BRIDGE}pids+=("\${_aom_pids[@]}")
# Node's fetch ignores HTTP(S)_PROXY unless asked (spike (b), 2026-10-14): remote targets are reached through the sandbox proxy.
export NODE_USE_ENV_PROXY=1
if command -v timeout >/dev/null 2>&1; then
  timeout --kill-after=15 "\${minutes}m" "$@"
  rc=$?
  if [ "$rc" -eq 124 ]; then echo "aom-env: stopped after $minutes minute(s): the command did not finish (timeout)" >&2; fi
  exit "$rc"
fi
"$@"
`;

/** Name of the sourced bridge file in the runner's bin dir (tester shifts' `BASH_ENV`). */
export const AOM_BRIDGES_FILE = 'aom-bridges.sh';

/** Writes `bin/aom`, `bin/aom.cmd`, `bin/aom-env` and `bin/aom-bridges.sh` (the bin dir is prepended to PATH in agent sessions). */
export async function writeShims(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const cmd = selfCommand('aom');
  const sh = `#!/bin/sh\nexec ${cmd.map(q).join(' ')} "$@"\n`;
  await writeFile(join(binDir, 'aom'), sh);
  await chmod(join(binDir, 'aom'), 0o755);
  const bat = `@echo off\r\n${cmd.map((c) => `"${c}"`).join(' ')} %*\r\n`;
  await writeFile(join(binDir, 'aom.cmd'), bat);
  await writeFile(join(binDir, 'aom-env'), AOM_ENV_SCRIPT);
  await chmod(join(binDir, 'aom-env'), 0o755);
  await writeFile(join(binDir, AOM_BRIDGES_FILE), AOM_BRIDGES_SCRIPT);
  await chmod(join(binDir, AOM_BRIDGES_FILE), 0o644);
}

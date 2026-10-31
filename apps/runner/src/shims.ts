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
 * `bin/aom-env`: runs a command with the tester's environment reachable (docs/design/run-and-integration-tests.md D6).
 * Each Bash call of a sandboxed agent has a network namespace of its own, so the wrapper starts a `socat` per forwarded
 * port inside it (`AOM_ENV_FORWARDS` = `<port>=<unix socket>,...`; the runner listens on the sockets) and runs the command,
 * which then finds `localhost:<port>` where it is on the workstation. `--timeout <minutes>` kills the command's whole
 * process group when it hangs (exit status 124).
 *
 * Local test services (GWP-41): when `AOM_TEST_SERVICES` lists `host:port` pairs (`127.0.0.1:5433,[::1]:6379`), the wrapper
 * also starts a `socat` listener on each port inside the command's network. It tunnels through the Claude Code sandbox's
 * proxy (`HTTPS_PROXY`, with its per-session credential) the way git-over-SSH does, and the proxy lets through only the
 * exact `host:port` entries of the sandbox settings. The proxy URL is never printed. Without a usable proxy nothing is
 * listened on and the services stay closed.
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
if [ -n "\${AOM_TEST_SERVICES:-}" ]; then
  proxy="\${HTTPS_PROXY:-\${https_proxy:-}}"
  re='^https?://(([^:@/]+):([^@/]+)@)?([^:/@]+):([0-9]+)/?$'
  if ! command -v socat >/dev/null 2>&1; then
    echo "aom-env: socat is not installed on this machine, test services not reachable" >&2
  elif [[ ! "$proxy" =~ $re ]]; then
    echo "aom-env: no sandbox proxy, test services not reachable" >&2
  else
    pauth=""; [ -n "\${BASH_REMATCH[2]}" ] && pauth=",proxyauth=\${BASH_REMATCH[2]}:\${BASH_REMATCH[3]}"
    phost="\${BASH_REMATCH[4]}"; pport="\${BASH_REMATCH[5]}"
    IFS=',' read -r -a svcs <<<"$AOM_TEST_SERVICES"
    for sv in "\${svcs[@]}"; do
      sport="\${sv##*:}"; shost="\${sv%:*}"
      case "$sport" in ''|*[!0-9]*) echo "aom-env: ignoring test service '$sv'" >&2; continue ;; esac
      case "$shost" in
        '[::1]') listen="TCP6-LISTEN:$sport,bind=[::1],fork,reuseaddr"; hex="00000000000000000000000001000000:$(printf '%04X' "$sport")"; tbl=/proc/net/tcp6 ;;
        127.0.0.1|localhost) listen="TCP-LISTEN:$sport,bind=127.0.0.1,fork,reuseaddr"; hex="0100007F:$(printf '%04X' "$sport")"; tbl=/proc/net/tcp ;;
        *) echo "aom-env: ignoring test service '$sv'" >&2; continue ;;
      esac
      socat "$listen" "PROXY:$phost:$shost:$sport,proxyport=$pport$pauth" >/dev/null 2>&1 &
      pids+=($!)
      for _ in $(seq 1 50); do
        grep -qi "$hex 0*:0000 0A" "$tbl" 2>/dev/null && break
        sleep 0.1
      done
    done
  fi
fi
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

/** Writes `bin/aom`, `bin/aom.cmd` and `bin/aom-env` (prepended to PATH in agent sessions). */
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
}

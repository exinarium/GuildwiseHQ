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

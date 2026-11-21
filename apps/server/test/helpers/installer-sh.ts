import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type InstallerParams, renderBash } from '../../src/installer/render.ts';

/**
 * Runs parts of the rendered Linux installer in a throw-away HOME, with nothing installed, asked or sent: `curl` serves
 * files from `www/` (by URL path) and logs every URL, `pgrep` answers from a file, `systemctl`, `launchctl`, `sudo` and
 * `sleep` only log. Never runs anything as root and never touches the real home folder.
 */
export const shParams: InstallerParams = {
  serverUrl: 'https://hq.example.com',
  pairingCode: 'ABCD-EFGH',
  sessionToken: 'tok_0123456789abcdefghij',
  workstationName: 'Desk',
  release: { version: '1.10.0', sha256: 'f'.repeat(64) },
  generatedAt: new Date('2026-11-21T08:00:00Z'),
  expiresAt: new Date('2026-11-21T08:30:00Z'),
};

const STUBS: Record<string, string> = {
  curl: `#!/bin/bash
out=""; url=""; post=0; ca=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --cacert) ca="$2"; shift 2 ;;
    -X) post=1; shift 2 ;;
    -m|-H|--data|--retry) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ "$post" = 1 ] && exit 0
echo "curl $url" >> "$STUB_LOG"
# a server behind a private CA ($STUB_HOME/private-ca holds its PEM): without --cacert naming it, curl exits 60
if [ -f "$STUB_HOME/private-ca" ] && ! cmp -s "$ca" "$STUB_HOME/private-ca"; then exit 60; fi
p="\${url#*://}"; p="/\${p#*/}"
[ -f "$STUB_WWW$p" ] || exit 22
if [ -n "$out" ]; then cp "$STUB_WWW$p" "$out"; else cat "$STUB_WWW$p"; fi
`,
  // pgrep: prints the pids in $STUB_HOME/pids (one per call while $STUB_HOME/pids-left counts down, if present).
  pgrep: `#!/bin/bash
echo "pgrep $*" >> "$STUB_LOG"
f="$STUB_HOME/pids"
[ -s "$f" ] || exit 1
if [ -f "$STUB_HOME/pids-left" ]; then
  n=$(cat "$STUB_HOME/pids-left")
  [ "$n" -le 0 ] && exit 1
  echo $((n - 1)) > "$STUB_HOME/pids-left"
fi
cat "$f"
`,
  systemctl: '#!/bin/bash\necho "systemctl $*" >> "$STUB_LOG"\nexit 0\n',
  launchctl: '#!/bin/bash\necho "launchctl $*" >> "$STUB_LOG"\nexit 0\n',
  sudo: '#!/bin/bash\necho "sudo $*" >> "$STUB_LOG"\nexit 1\n',
  sleep: '#!/bin/bash\nexit 0\n',
};

export interface ShRun {
  home: string;
  status: number | null;
  stdout: string;
  stderr: string;
  log: string;
  cleanup: () => void;
}

export interface ShSetup {
  home: string;
  www: string;
  cleanup: () => void;
}

/** A fresh HOME with the stub programs; `www/` is what the stub curl serves. */
export function shHome(): ShSetup {
  const home = mkdtempSync(join(tmpdir(), 'aom-inst-'));
  const bin = join(home, '.stub-bin');
  mkdirSync(bin);
  for (const [name, text] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const www = join(home, '.stub-www');
  mkdirSync(www);
  return { home, www, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/**
 * Renders the Linux installer with `params`, keeps everything before `main "$@"` (function definitions and settings),
 * then runs `script` (bash) after it. `args` go to `main` when `script` is `main "$@"`.
 */
export function runSh(
  setup: ShSetup,
  script: string,
  opts: {
    params?: Partial<InstallerParams>;
    env?: Record<string, string>;
    args?: string[];
    stdin?: string;
    /** The macOS installer instead of the Linux one (its functions only; nothing here is a Mac). */
    os?: 'linux' | 'macos';
  } = {},
): ShRun {
  const text = renderBash(opts.os ?? 'linux', { ...shParams, ...opts.params });
  const body = text.slice(0, text.lastIndexOf('main "$@"'));
  const file = join(setup.home, '.run.sh');
  writeFileSync(file, `${body}\n${script}\n`);
  const log = join(setup.home, '.stub-log');
  writeFileSync(log, '');
  const r = spawnSync('bash', [file, ...(opts.args ?? [])], {
    encoding: 'utf8',
    input: opts.stdin ?? '',
    env: {
      PATH: `${join(setup.home, '.stub-bin')}:${process.env.PATH}`,
      HOME: setup.home,
      NO_COLOR: '1',
      GUILDWISE_YES: '1',
      STUB_LOG: log,
      STUB_WWW: setup.www,
      STUB_HOME: setup.home,
      ...opts.env,
    },
  });
  return {
    home: setup.home,
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    log: readFileSync(log, 'utf8'),
    cleanup: setup.cleanup,
  };
}

/** A fake installed runner: `<root>/<version>/aom-runner/aom-runner` printing its version, and `current` pointing at it. */
export function fakeRunner(home: string, version: string, opts: { sha256?: string } = {}): string {
  const root = join(home, '.local/share/guildwise/runner');
  const pkg = join(root, version, 'aom-runner');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'aom-runner'), `#!/bin/sh\n[ "$1" = --version ] && echo ${version}\nexit 0\n`);
  chmodSync(join(pkg, 'aom-runner'), 0o755);
  if (opts.sha256) writeFileSync(join(root, version, '.sha256'), opts.sha256);
  spawnSync('ln', ['-sfn', pkg, join(root, 'current')]);
  return root;
}

export const have = (cmd: string, arg = '--version') =>
  spawnSync(cmd, [arg], { encoding: 'utf8' }).status === 0;

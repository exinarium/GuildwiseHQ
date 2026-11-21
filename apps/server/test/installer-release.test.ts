import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderBash, renderPowerShell } from '../src/installer/render.ts';
import { have, runSh, type ShSetup, shHome, shParams } from './helpers/installer-sh.ts';

/**
 * R18-U, R20, R21: the installer downloads from the 1.10.0 release paths, checks the minisign signature before anything is
 * unpacked, keeps the signed-release proof, installs the root-owned tools only from a verified release, and passes the
 * user's flags (never anything from the server) to guildwise-runner setup and guildwise-admin.
 */
const FIX = join(__dirname, '../../runner/test/fixtures/minisign');
const pubLine = (name: string) => readFileSync(join(FIX, name), 'utf8').split('\n')[1] ?? '';
const TEST_PUB = pubLine('test.pub');
const OTHER_PUB = pubLine('other.pub');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const canSign = have('minisign', '-v');

/** A real release: tarball (runner + admin tools), Node runtime tarball, manifest and its signature by the test key. */
let rel: { dir: string; tgz: Buffer; tgzSha: string; manifest: string; minisig: string; node: Buffer };
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'aom-rel-'));
  const pkg = join(dir, 'pkg/aom-runner');
  mkdirSync(join(pkg, 'admin'), { recursive: true });
  writeFileSync(join(pkg, 'aom-runner'), '#!/bin/sh\n[ "$1" = --version ] && echo 1.10.0\nexit 0\n');
  chmodSync(join(pkg, 'aom-runner'), 0o755);
  writeFileSync(join(pkg, 'admin/guildwise-admin.mjs'), '#!/usr/local/lib/guildwise/node/bin/node\n');
  writeFileSync(join(pkg, 'admin/deploy-compose.mjs'), '#!/usr/local/lib/guildwise/node/bin/node\n');
  spawnSync('tar', ['-czf', join(dir, 'aom-runner-1.10.0.tgz'), '-C', join(dir, 'pkg'), 'aom-runner']);
  mkdirSync(join(dir, 'nodepkg/node-v22.0.0-linux-x64/bin'), { recursive: true });
  writeFileSync(join(dir, 'nodepkg/node-v22.0.0-linux-x64/bin/node'), '#!/bin/sh\n');
  spawnSync('tar', ['-czf', join(dir, 'node.tar.gz'), '-C', join(dir, 'nodepkg'), 'node-v22.0.0-linux-x64']);
  const tgz = readFileSync(join(dir, 'aom-runner-1.10.0.tgz'));
  const node = readFileSync(join(dir, 'node.tar.gz'));
  const nodeRuntime: Record<string, { url: string; sha256: string }> = {};
  for (const plat of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'])
    nodeRuntime[plat] = { url: 'https://nodejs.example/dist/node.tar.gz', sha256: sha256(node) };
  const manifest = `${JSON.stringify(
    {
      version: '1.10.0',
      file: 'aom-runner-1.10.0.tgz',
      sha256: sha256(tgz),
      minRunner: '1.10.0',
      floor: '1.10.0',
      allowDowngrade: false,
      nodeRuntime,
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(dir, 'manifest.json'), manifest);
  if (canSign) {
    const r = spawnSync(
      'minisign',
      ['-S', '-s', join(FIX, 'test.key'), '-m', join(dir, 'manifest.json'), '-t', 'guildwise-runner 1.10.0'],
      { encoding: 'utf8', input: '' },
    );
    if (r.status !== 0) throw new Error(`minisign: ${r.stderr}`);
  }
  rel = {
    dir,
    tgz,
    tgzSha: sha256(tgz),
    manifest,
    minisig: canSign ? readFileSync(join(dir, 'manifest.json.minisig'), 'utf8') : '',
    node,
  };
});
afterAll(() => rmSync(rel.dir, { recursive: true, force: true }));

let setup: ShSetup;
afterEach(() => setup?.cleanup());

/** Puts the release on the stub server under /api/runner/releases/ (and the tarball under the old path too). */
function serve(www: string, opts: { manifest?: string | null; minisig?: string | null; tgz?: Buffer } = {}) {
  const r = join(www, 'api/runner/releases');
  mkdirSync(r, { recursive: true });
  const m = opts.manifest === undefined ? rel.manifest : opts.manifest;
  const s = opts.minisig === undefined ? rel.minisig : opts.minisig;
  if (m !== null) writeFileSync(join(r, 'manifest.json'), m);
  if (s !== null && s !== '') writeFileSync(join(r, 'manifest.json.minisig'), s);
  writeFileSync(join(r, 'aom-runner-1.10.0.tgz'), opts.tgz ?? rel.tgz);
  mkdirSync(join(www, 'api/runner/release'), { recursive: true });
  writeFileSync(join(www, 'api/runner/release/aom-runner-1.10.0.tgz'), opts.tgz ?? rel.tgz);
  mkdirSync(join(www, 'dist'), { recursive: true });
  writeFileSync(join(www, 'dist/node.tar.gz'), rel.node);
}

const STAGE = 'parse_flags "$@"; stage_runner_release; echo "SIGNED=$STAGE_SIGNED VERSION=$STAGE_VERSION"';
const on = { requireSignedRunners: true, releasePubkey: TEST_PUB };
const off = { requireSignedRunners: false, releasePubkey: TEST_PUB };

describe('script header', () => {
  it('carries the setting and the release key (a public key line only) in bash and PowerShell', () => {
    const plain = renderBash('linux', shParams);
    expect(plain).toContain('\nREQUIRE_SIGNED_RUNNERS=0\n');
    expect(plain).toContain("\nRELEASE_PUBKEY=''\n");
    const signed = renderBash('macos', { ...shParams, requireSignedRunners: true, releasePubkey: TEST_PUB });
    expect(signed).toContain('\nREQUIRE_SIGNED_RUNNERS=1\n');
    expect(signed).toContain(`\nRELEASE_PUBKEY='${TEST_PUB}'\n`);
    for (const bad of ['PLACEHOLDER', 'untrusted comment: x', "RW'; touch /tmp/p; '", ''])
      expect(renderBash('linux', { ...shParams, releasePubkey: bad })).toContain("\nRELEASE_PUBKEY=''\n");
    const win = { ...shParams, scriptUrl: 'https://x/a.ps1', linuxScriptUrl: 'https://x/b.sh' };
    expect(renderPowerShell(win)).toContain('$RequireSignedRunners = $false\r\n');
    expect(renderPowerShell({ ...win, requireSignedRunners: true })).toContain(
      '$RequireSignedRunners = $true\r\n',
    );
  });
});

describe.skipIf(!canSign)('downloading and verifying the runner', () => {
  it('uses the 1.10.0 release paths and checks the signature, then the checksum', () => {
    setup = shHome();
    serve(setup.www);
    const r = runSh(setup, STAGE, { params: on });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('SIGNED=1 VERSION=1.10.0');
    expect(r.stdout).toContain('Release signature verified ("guildwise-runner 1.10.0")');
    expect(r.stdout).toContain('downloaded and verified (signature and checksum)');
    const urls = r.log.split('\n').filter((l) => l.startsWith('curl '));
    expect(urls).toEqual([
      'curl https://hq.example.com/api/runner/releases/manifest.json',
      'curl https://hq.example.com/api/runner/releases/manifest.json.minisig',
      'curl https://hq.example.com/api/runner/releases/aom-runner-1.10.0.tgz',
    ]);
    expect(r.log).not.toContain('/api/runner/release/');
  });

  it('a changed manifest fails before the tarball is even downloaded', () => {
    setup = shHome();
    serve(setup.www, { manifest: rel.manifest.replace('"floor": "1.10.0"', '"floor": "1.0.0"') });
    const r = runSh(setup, STAGE, { params: off });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'The runner release signature did not verify: the signature does not match the file.',
    );
    expect(r.log).not.toContain('.tgz');
  });

  it('a release signed by another key than the server trusts is refused', () => {
    setup = shHome();
    serve(setup.www);
    const r = runSh(setup, STAGE, { params: { requireSignedRunners: true, releasePubkey: OTHER_PUB } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('signed by another key than the one this server trusts');
  });

  it('a tarball that does not match the signed checksum is refused', () => {
    setup = shHome();
    serve(setup.www, { tgz: Buffer.from('not the release') });
    const r = runSh(setup, STAGE, { params: on });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('did not match its checksum');
  });

  it('an enforcing server needs a signed release; with the setting off an unsigned one is accepted by checksum', () => {
    setup = shHome();
    serve(setup.www, { minisig: null });
    const refused = runSh(setup, STAGE, { params: on });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'This server requires signed runners, but its runner release is not signed.',
    );
    const accepted = runSh(setup, STAGE, { params: off });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain('SIGNED=0 VERSION=1.10.0');
    expect(accepted.stdout).toContain('"Only signed runners" is off here');
  });

  it('a server without the 1.10.0 paths is refused, and the old download path is never used', () => {
    setup = shHome();
    serve(setup.www, { manifest: null, minisig: null });
    const refused = runSh(setup, STAGE, { params: on });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('offers no runner release manifest');
    const off2 = runSh(setup, STAGE, {
      params: { ...off, release: { version: '1.10.0', sha256: rel.tgzSha } },
    });
    expect(off2.status).toBe(1);
    expect(off2.stderr).toContain('offers no 1.10.0 runner release (no release manifest)');
    for (const r of [refused, off2]) expect(r.log).not.toContain('/api/runner/release/');
  });

  it('the offline route (--from-file) uses local files and still checks the signature', () => {
    setup = shHome();
    const local = join(setup.home, 'offline');
    mkdirSync(local);
    for (const f of ['manifest.json', 'manifest.json.minisig', 'aom-runner-1.10.0.tgz'])
      copyFileSync(join(rel.dir, f), join(local, f));
    const r = runSh(setup, STAGE, { params: on, args: ['--from-file', local] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('SIGNED=1');
    expect(r.log).not.toContain('curl https://hq.example.com');
    writeFileSync(join(local, 'manifest.json'), rel.manifest.replace('1.10.0"', '1.10.1"'));
    expect(runSh(setup, STAGE, { params: on, args: ['--from-file', local] }).status).toBe(1);
  });

  it('keeps the verified manifest and signature in the runner root (the signed-release proof)', () => {
    setup = shHome();
    serve(setup.www);
    const r = runSh(setup, 'stage_runner_release >/dev/null; place_runner_release', { params: on });
    expect(r.status, r.stderr).toBe(0);
    const root = join(setup.home, '.local/share/guildwise/runner');
    expect(readFileSync(join(root, 'manifest.json'), 'utf8')).toBe(rel.manifest);
    expect(readFileSync(join(root, 'manifest.json.minisig'), 'utf8')).toBe(rel.minisig);
    expect(statSync(join(root, 'manifest.json')).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(root, '1.10.0/.sha256'), 'utf8')).toBe(rel.tgzSha);
    expect(existsSync(join(root, 'current/aom-runner'))).toBe(true);
    expect(existsSync(join(setup.home, '.local/bin/guildwise-runner'))).toBe(true);
    // an unsigned release leaves no proof behind (the old one would not match it)
    rmSync(join(setup.www, 'api/runner/releases/manifest.json.minisig'));
    rmSync(join(root, '1.10.0'), { recursive: true });
    const u = runSh(setup, 'stage_runner_release >/dev/null; place_runner_release', { params: off });
    expect(u.status, u.stderr).toBe(0);
    expect(existsSync(join(root, 'manifest.json'))).toBe(false);
    expect(existsSync(join(root, 'manifest.json.minisig'))).toBe(false);
  });
});

// as_root replaced: logs the command and runs it without root (owners dropped), with ADMIN_DIR in the test folder.
const AS_ROOT = `
ADMIN_DIR="$HOME/admin"; ADMIN="$ADMIN_DIR/guildwise-admin"; BUNDLED_NODE_BIN="$ADMIN_DIR/node/bin"
as_root() {
  echo "as_root $*" >> "$STUB_LOG"
  case "$1" in
    chown) return 0 ;;
    install) shift; local a=(); while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; install "\${a[@]}" ;;
    "$ADMIN") return 0 ;;
    *) "$@" ;;
  esac
}`;

describe.skipIf(!canSign)('the root-owned tools', () => {
  it('come from the verified release with the pinned Node runtime of the signed manifest, mode 755', () => {
    setup = shHome();
    serve(setup.www);
    const r = runSh(setup, `${AS_ROOT}\nstage_runner_release >/dev/null; install_admin_tools`, {
      params: on,
    });
    expect(r.status, r.stderr).toBe(0);
    const admin = join(setup.home, 'admin');
    for (const t of ['guildwise-admin', 'deploy-compose']) {
      expect(readFileSync(join(admin, t), 'utf8')).toContain('#!/usr/local/lib/guildwise/node/bin/node');
      expect(statSync(join(admin, t)).mode & 0o777).toBe(0o755);
    }
    expect(existsSync(join(admin, 'node/bin/node'))).toBe(true);
    expect(readFileSync(join(admin, 'node/.sha256'), 'utf8').trim()).toBe(sha256(rel.node));
    expect(r.log).toContain('curl https://nodejs.example/dist/node.tar.gz');
    expect(r.log).toMatch(/as_root install -o 0 -g 0 -m 0755 .*guildwise-admin\.mjs/);
    expect(r.log).toContain('--no-same-owner');
  });

  it('a release without deploy-compose still installs guildwise-admin (narrow Docker is then unavailable)', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `${AS_ROOT}
STAGE_SIGNED=1; STAGE_DIR="$HOME/stage"; STAGE_PKG="$STAGE_DIR/pkg"; STAGE_MANIFEST="$STAGE_DIR/m.json"
mkdir -p "$STAGE_PKG/aom-runner/admin" "$ADMIN_DIR/node"
printf '#!/x\\n' > "$STAGE_PKG/aom-runner/admin/guildwise-admin.cjs"
echo "${'a'.repeat(64)}" > "$ADMIN_DIR/node/.sha256"
manifest_get() { echo "https://nodejs.example/n.tgz ${'a'.repeat(64)}"; }
install_admin_tools`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(setup.home, 'admin/guildwise-admin'))).toBe(true);
    expect(existsSync(join(setup.home, 'admin/deploy-compose'))).toBe(false);
    expect(r.stdout + r.stderr).toContain('has no deploy-compose');
  });

  it('a Node runtime that does not match the signed manifest is refused', () => {
    setup = shHome();
    serve(setup.www);
    writeFileSync(join(setup.www, 'dist/node.tar.gz'), 'tampered');
    const r = runSh(setup, `${AS_ROOT}\nstage_runner_release >/dev/null; install_admin_tools`, {
      params: on,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('The Node runtime did not match its checksum in the signed release manifest.');
    expect(existsSync(join(setup.home, 'admin/guildwise-admin'))).toBe(false);
  });

  it('are never installed from an unsigned release, unless this very server was allowed (test machines)', () => {
    setup = shHome();
    serve(setup.www, { minisig: null });
    const refused = runSh(
      setup,
      `${AS_ROOT}\nparse_flags "$@"; stage_runner_release >/dev/null; install_admin_tools`,
      {
        params: off,
      },
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('installed only from a signed runner release');
    expect(refused.log).not.toContain('as_root');
    const other = runSh(
      setup,
      `${AS_ROOT}\nparse_flags "$@"; stage_runner_release >/dev/null; install_admin_tools`,
      {
        params: off,
        args: ['--allow-unsigned-from', 'https://other.example.com'],
      },
    );
    expect(other.status).toBe(1);
    const allowed = runSh(
      setup,
      `${AS_ROOT}\nparse_flags "$@"; stage_runner_release >/dev/null; install_admin_tools`,
      {
        params: off,
        args: ['--allow-unsigned-from', 'https://hq.example.com'],
      },
    );
    expect(allowed.status, allowed.stderr).toBe(0);
  });
});

describe('the dedicated runner user', () => {
  it('is created by guildwise-admin, and everything after runs as that user in its own home', () => {
    setup = shHome();
    const rhome = join(setup.home, 'runner-home');
    const r = runSh(
      setup,
      `${AS_ROOT}
ADMIN_TOOLS_READY=1
user_home() { echo "${rhome}"; }
parse_flags "$@"; RUNNER_MODE=dedicated
setup_runner_user
echo "AS=$RUNNER_AS ROOT=$RUNNER_ROOT DATA=$DATA_DIR BIN=$BIN_DIR"
sudo() { echo "sudo $*" >> "$STUB_LOG"; }
runner status`,
      { args: ['--yes'] },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toMatch(/guildwise-admin user create\n/);
    expect(r.stdout).toContain(
      `AS=guildwise-runner ROOT=${rhome}/.local/share/guildwise/runner DATA=${rhome}/.aom-runner BIN=${rhome}/.local/bin`,
    );
    // as_runner goes through sudo -u guildwise-runner with its own HOME and PATH (the root-owned Node first after its bin)
    expect(r.log).toMatch(
      new RegExp(
        `sudo -u guildwise-runner -H env HOME=${rhome} PATH=${rhome}/.local/bin:${setup.home}/admin/node/bin:`,
      ),
    );
    expect(r.log).toContain(`${rhome}/.local/share/guildwise/runner/current/aom-runner status`);
  });

  it('has its service written and started by guildwise-admin service install (the W9 command shape)', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `ADMIN=/usr/local/lib/guildwise/guildwise-admin
as_root() { echo "as_root $*" >> "$STUB_LOG"; return 0; }
write_as_runner() { echo "mode $(cat)" >> "$STUB_LOG"; }
RUNNER_AS=guildwise-runner; RUNNER_NAME=guildwise-runner; RUNNER_ROOT=/home/guildwise-runner/.local/share/guildwise/runner
install_service`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain(
      'as_root /usr/local/lib/guildwise/guildwise-admin service install --runner-root /home/guildwise-runner/.local/share/guildwise/runner --start',
    );
    expect(r.log).toContain('as_root systemctl restart guildwise-runner.service');
    expect(r.log).not.toContain('systemctl --user');
    // a mode the runner's self-update knows (systemd | launchd | background)
    expect(r.log).toContain('mode systemd\n');
  });

  it('adds only its own clone folder, never your folders', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `RUNNER_AS=guildwise-runner; RUNNER_HOME="$HOME/rh"; RUNNER_NAME=guildwise-runner
as_runner() { "$@"; }
runner() { echo "runner $*" >> "$STUB_LOG"; }
add_repo_folders`,
      { env: { GUILDWISE_REPO_DIRS: '/home/someone/src' } },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain(`runner repos add ${setup.home}/rh/src`);
    expect(r.log).not.toContain('/home/someone/src');
    expect(r.stdout).toContain('GUILDWISE_REPO_DIRS is ignored');
  });
});

describe('setting local permissions', () => {
  const PERMS = (policy: string, extra = '') => `${AS_ROOT}
ADMIN_TOOLS_READY=1
parse_flags "$@"
RUNNER_MODE=dedicated; RUNNER_AS=""; RUNNER_NAME=guildwise-runner; RUNNER_HOME="$HOME/rh"
mkdir -p "$RUNNER_HOME/.config/aom-runner"; printf '%s' '${policy}' > "$RUNNER_HOME/.config/aom-runner/policy.json"
runner() {
  if [ "$1 \${2:-}" = "setup --help" ]; then return 0; fi
  local stdin=""; [ -t 0 ] || stdin="$(cat)"
  echo "runner $* stdin=\${stdin}" >> "$STUB_LOG"
}
as_root() { echo "as_root $*" >> "$STUB_LOG"; case "$1" in test) return 1 ;; esac; return 0; }
${extra}
set_local_permissions`;

  it('runs guildwise-runner setup with only the flags given, then the root parts through guildwise-admin', () => {
    setup = shHome();
    const r = runSh(setup, PERMS('{"docker":"narrow","devops":{"agents":{},"sudo":true}}'), {
      args: [
        '--yes',
        '--devops-orgs',
        'none',
        '--sudo',
        'on',
        '--docker',
        'narrow',
        '--deploy',
        'ask',
        '--deploy-pin-commit',
        '--approve-app',
        'web=/srv/web app',
      ],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain(
      'runner setup --runner-user dedicated --yes --devops-orgs none --sudo on --docker narrow --deploy ask --deploy-pin-commit stdin=',
    );
    const admin = `${setup.home}/admin/guildwise-admin`;
    expect(r.log).toContain(`as_root ${admin} docker narrow --user guildwise-runner`);
    expect(r.log).toContain(`as_root ${admin} sudo on --user guildwise-runner`);
    expect(r.log).toContain(
      `as_root ${admin} approve-app web --source /srv/web app --user guildwise-runner --yes`,
    );
    expect(r.stdout).toContain('Local permissions set');
  });

  it('the docker group passes --accept-root-equivalent to guildwise-admin only when accepted here', () => {
    setup = shHome();
    const policy = '{"docker":"group","devops":{"agents":{},"sudo":false}}';
    const ok = runSh(setup, PERMS(policy), { args: ['--docker', 'group', '--accept-root-equivalent'] });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.log).toContain(
      `as_root ${setup.home}/admin/guildwise-admin docker group --user guildwise-runner --accept-root-equivalent`,
    );
    // a policy.json that asks for the group without a yes on this machine (no flag, no keyboard) runs nothing as root
    const refused = runSh(setup, PERMS(policy));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('root-equivalence was not accepted here');
    expect(refused.log).not.toMatch(/guildwise-admin docker/);
  });

  it('sudo from policy.json alone (no --sudo on, no keyboard) is refused, nothing runs as root', () => {
    setup = shHome();
    const r = runSh(setup, PERMS('{"docker":"none","devops":{"agents":{},"sudo":true}}'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('policy.json asks for sudo, but it was not turned on here');
    expect(r.log).not.toMatch(/guildwise-admin sudo on/);
  });

  it('stops the dedicated runner service before setup writes policy.json', () => {
    setup = shHome();
    const r = runSh(
      setup,
      PERMS(
        '{"docker":"none","devops":{"agents":{},"sudo":false}}',
        'RUNNER_AS=guildwise-runner; as_runner() { "$@"; }',
      ),
    );
    expect(r.status, r.stderr).toBe(0);
    const stop = r.log.indexOf('as_root systemctl stop guildwise-runner.service');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(r.log.indexOf('runner setup'));
  });

  it('with no flags and no keyboard, setup gets --yes (the safest values) and nothing else', () => {
    setup = shHome();
    const r = runSh(setup, PERMS('{"docker":"none","devops":{"agents":{},"sudo":false}}'));
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain('runner setup --runner-user dedicated --yes stdin=');
    expect(r.log).not.toMatch(/guildwise-admin (docker|sudo|approve-app)/);
  });

  it('runs nothing as root for a policy value outside the known list', () => {
    setup = shHome();
    const r = runSh(setup, PERMS('{"docker":"group; touch /tmp/x","devops":{"sudo":"yes"}}'));
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).not.toMatch(/guildwise-admin (docker|sudo)/);
  });

  it('hands the sudo password from standard input to setup, never on a command line', () => {
    setup = shHome();
    const r = runSh(setup, PERMS('{"docker":"none"}', 'RUNNER_MODE=current'), {
      args: ['--sudo', 'on', '--sudo-password-stdin'],
      stdin: 'hunter2\n',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain(
      'runner setup --runner-user current --yes --sudo on --sudo-password-stdin stdin=hunter2',
    );
    expect(r.log.split('\n').filter((l) => l.includes('hunter2'))).toHaveLength(1);
  });

  it('an upgrade of a runner kept for your user, without a keyboard or flags, changes nothing (it keeps working)', () => {
    setup = shHome();
    const r = runSh(setup, PERMS('{}', 'RUNNER_MODE=current; LEGACY_RESULT=kept'), {
      env: { GUILDWISE_YES: '0' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).not.toContain('runner setup');
    expect(r.stdout).toContain('Local permissions not changed');
  });

  it('a runner without guildwise-runner setup (an older release on a self-hosted server) is left as it is', () => {
    setup = shHome();
    const r = runSh(setup, `runner() { return 1; }\nset_local_permissions`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('has no guildwise-runner setup');
  });
});

describe('installer flags', () => {
  const FLAGS = 'parse_flags "$@"; echo OK';
  it.each([
    [['--runner-user', 'root'], '--runner-user is dedicated or current'],
    [['--sudo', 'yes'], '--sudo is on or off'],
    [['--docker', 'group'], 'needs --accept-root-equivalent'],
    [['--devops-orgs', 'owned'], '--devops-orgs is none or organization ids'],
    [['--approve-app', 'web'], '--approve-app is <app>=<absolute folder>'],
    [['--approve-app', 'web=srv/web'], '--approve-app is <app>=<absolute folder>'],
    [['--approve-app', 'my_app=/srv/web'], '--approve-app is <app>=<absolute folder>'],
    [['--docker', 'none', '--approve-app', 'web=/srv/web'], '--approve-app needs --docker narrow'],
    [['--allow-unsigned-from', 'https://x.example/path'], 'an exact origin'],
    [['--deploy', 'auto'], '--deploy is ask or off'],
    [['--sudo-password-stdin'], 'no password came on standard input'],
    [['--frobnicate'], 'Unknown option: --frobnicate'],
    [['--legacy'], '--legacy needs a value'],
  ])('%j is refused', (args, msg) => {
    setup = shHome();
    const r = runSh(setup, FLAGS, { args });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(msg);
  });

  it('accepts the documented set', () => {
    setup = shHome();
    const r = runSh(setup, FLAGS, {
      args: [
        '--yes',
        '--runner-user',
        'dedicated',
        '--legacy',
        'quarantine',
        '--devops-orgs',
        '0b6f6c1e-6a1c-4f3e-9f55-0a4f3a0c9b11,1b6f6c1e-6a1c-4f3e-9f55-0a4f3a0c9b12',
        '--sudo=off',
        '--docker',
        'group',
        '--accept-root-equivalent',
        '--deploy',
        'off',
        '--allow-unsigned-from',
        'http://localhost:4000',
        '--choose-folders',
      ],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('OK');
  });
});

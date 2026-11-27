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

  it('a server behind a private CA: --ca-file is used for every release download; without it the real cause is named', () => {
    setup = shHome();
    serve(setup.www);
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    writeFileSync(join(setup.home, 'private-ca'), pem);
    const ca = join(setup.home, 'caddy-root.crt');
    writeFileSync(ca, pem);
    const ok = runSh(setup, STAGE, { params: on, args: ['--ca-file', ca] });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('SIGNED=1 VERSION=1.10.0');
    // the three release files all came through (the stub refuses any call without the CA)
    expect(ok.log.split('\n').filter((l) => l.startsWith('curl '))).toHaveLength(3);
    const without = runSh(setup, STAGE, { params: on });
    expect(without.status).toBe(1);
    expect(without.stderr).toContain(
      'Could not fetch the runner release manifest from https://hq.example.com',
    );
    expect(without.stderr).toContain('the server certificate is not trusted');
    expect(without.stderr).toContain('--ca-file');
    expect(without.stderr).not.toContain('offers no runner release manifest');
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
    expect(existsSync(join(admin, 'deploy-compose'))).toBe(false);
    for (const t of ['guildwise-admin']) {
      expect(readFileSync(join(admin, t), 'utf8')).toContain('#!/usr/local/lib/guildwise/node/bin/node');
      expect(statSync(join(admin, t)).mode & 0o777).toBe(0o755);
    }
    expect(existsSync(join(admin, 'node/bin/node'))).toBe(true);
    expect(readFileSync(join(admin, 'node/.sha256'), 'utf8').trim()).toBe(sha256(rel.node));
    expect(r.log).toContain('curl https://nodejs.example/dist/node.tar.gz');
    expect(r.log).toMatch(/as_root install -o 0 -g 0 -m 0755 .*guildwise-admin\.mjs/);
    expect(r.log).toContain('--no-same-owner');
  });

  it('a release without guildwise-admin stops (narrow mode and deploy-compose are gone)', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `${AS_ROOT}
STAGE_SIGNED=1; STAGE_DIR="$HOME/stage"; STAGE_PKG="$STAGE_DIR/pkg"; STAGE_MANIFEST="$STAGE_DIR/m.json"
mkdir -p "$STAGE_PKG/aom-runner/admin" "$ADMIN_DIR/node"
echo "${'a'.repeat(64)}" > "$ADMIN_DIR/node/.sha256"
manifest_get() { echo "https://nodejs.example/n.tgz ${'a'.repeat(64)}"; }
install_admin_tools`,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('The runner release has no guildwise-admin.');
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
DOCKER_SOCKET_PATHS=("$HOME/none/docker.sock" "$HOME/none/run-docker.sock")
parse_flags "$@"
RUNNER_MODE=dedicated; RUNNER_AS=""; RUNNER_NAME=guildwise-runner; RUNNER_HOME="$HOME/rh"
mkdir -p "$RUNNER_HOME/.config/aom-runner"; printf '%s' '${policy}' > "$RUNNER_HOME/.config/aom-runner/policy.json"
runner() {
  if [ "$1 \${2:-}" = "setup --help" ]; then return 0; fi
  local stdin=""; [ -t 0 ] || stdin="$(cat)"
  echo "runner $* stdin=\${stdin}" >> "$STUB_LOG"
}
as_root() { echo "as_root $*" >> "$STUB_LOG"; case "$1" in test) return 1 ;; esac; return 0; }
install_docker_binaries() { echo "install_docker_binaries" >> "$STUB_LOG"; }
setup_runner_docker() { echo "setup_runner_docker" >> "$STUB_LOG"; }
${extra}
set_local_permissions`;

  it('runs guildwise-runner setup with only the flags given (plus what it detected), then the root parts', () => {
    setup = shHome();
    const r = runSh(setup, PERMS('{"docker":"rootless","devops":{"agents":{}}}'), {
      args: [
        '--yes',
        '--devops-orgs',
        'none',
        '--docker',
        'rootless',
        '--deploy',
        'ask',
        '--deploy-pin-commit',
      ],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain(
      'runner setup --runner-user dedicated --yes --devops-orgs none --docker rootless --docker-found none --deploy ask --deploy-pin-commit stdin=',
    );
    const admin = `${setup.home}/admin/guildwise-admin`;
    // the legacy clean-up always comes first, then the Docker root part, then the runner's own set-up
    const order = [
      `as_root ${admin} cleanup-legacy --user guildwise-runner`,
      'install_docker_binaries',
      `as_root ${admin} docker rootless --user guildwise-runner`,
      'setup_runner_docker',
    ].map((l) => r.log.indexOf(l));
    for (const n of order) expect(n).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r.log).not.toMatch(/guildwise-admin (sudo|approve-app)/);
    expect(r.stdout).toContain('Local permissions set');
  });

  it('host passes --accept-root-equivalent to guildwise-admin only when accepted here', () => {
    setup = shHome();
    const policy = '{"docker":"host","acceptRootEquivalent":true}';
    const ok = runSh(setup, PERMS(policy), { args: ['--docker', 'host', '--accept-root-equivalent'] });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.log).toContain(
      `as_root ${setup.home}/admin/guildwise-admin docker host --accept-root-equivalent --user guildwise-runner`,
    );
    // a policy.json that asks for the installed Docker without a yes here (no flag, no keyboard) runs nothing for it
    const refused = runSh(setup, PERMS(policy));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('root-equivalence was not accepted here');
    expect(refused.log).not.toMatch(/guildwise-admin docker host/);
  });

  it('shared (owner 2026-11-21): the socket from policy.json and --accept-shared-daemon, only when accepted here', () => {
    setup = shHome();
    const policy = '{"docker":"shared","dockerHost":"unix:///run/docker-svc/docker.sock"}';
    // installer-policy-seal: after root's step the runner records the acceptance in its sealed policy (stubbed here)
    const record =
      'record_supported() { return 0; }; runner_fresh() { echo "runner_fresh $*" >> "$STUB_LOG"; }';
    const ok = runSh(setup, PERMS(policy, record), {
      args: [
        '--docker',
        'shared',
        '--docker-socket',
        '/run/docker-svc/docker.sock',
        '--accept-shared-daemon',
      ],
    });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.log).toContain('runner_fresh policy record-shared-docker');
    expect(ok.log).toContain(
      '--docker shared --docker-found none --docker-socket /run/docker-svc/docker.sock --accept-shared-daemon',
    );
    expect(ok.log).toContain(
      `as_root ${setup.home}/admin/guildwise-admin docker shared --docker-socket /run/docker-svc/docker.sock --accept-shared-daemon --user guildwise-runner`,
    );
    const refused = runSh(setup, PERMS(policy));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('shared Docker daemon, but it was not accepted here');
  });

  it('detect_docker: a root socket is "rootful"; a socket elsewhere whose daemon is rootless is "shared"', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `mkdir -p "$HOME/run/docker-svc"
python3 -c "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])" "$HOME/run/docker-svc/docker.sock"
ln -s "$HOME/run/docker-svc/docker.sock" "$HOME/run/docker.sock"
DOCKER_SOCKET_PATHS=("$HOME/var-run/docker.sock" "$HOME/run/docker.sock")
detect_docker; echo "A=$DOCKER_FOUND"
AUTHORIZED=1
as_root() { if [ "$1" = env ]; then echo '["name=seccomp","name=rootless"]'; fi; }
detect_docker; echo "B=$DOCKER_FOUND $DOCKER_SOCKET"`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('A=rootful');
    expect(r.stdout).toContain(`B=shared ${setup.home}/run/docker-svc/docker.sock`);
  });

  it('stops the dedicated runner service before setup writes policy.json', () => {
    setup = shHome();
    const r = runSh(setup, PERMS('{"docker":"none"}', 'RUNNER_AS=guildwise-runner; as_runner() { "$@"; }'));
    expect(r.status, r.stderr).toBe(0);
    const stop = r.log.indexOf('as_root systemctl stop guildwise-runner.service');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(r.log.indexOf('runner setup'));
  });

  it('with no flags and no keyboard, setup gets --yes and what was detected, nothing else', () => {
    setup = shHome();
    const r = runSh(setup, PERMS('{"docker":"none"}'));
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain('runner setup --runner-user dedicated --yes --docker-found none stdin=');
    expect(r.log).not.toMatch(/guildwise-admin (docker (rootless|host|shared)|sudo|approve-app)/);
  });

  it('runs nothing for a policy value outside the known list', () => {
    setup = shHome();
    const r = runSh(setup, PERMS('{"docker":"group; touch /tmp/x"}'));
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).not.toMatch(/guildwise-admin docker (rootless|host|shared|group)/);
  });

  it('never asks for GitHub: no gh in the installer flow (owner 2026-11-21)', () => {
    for (const os of ['linux', 'macos'] as const) {
      const text = renderBash(os, shParams);
      expect(text).not.toMatch(/\bgh (auth|login)\b/);
      expect(text).not.toMatch(/GITHUB_TOKEN|GH_TOKEN/);
    }
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

describe('one authorization (owner 2026-11-21) and the baseline', () => {
  /** A sudo stub that keeps a timestamp after -v (unless $NO_TIMESTAMP) and logs every call. */
  const SUDO = `
sudo() {
  echo "sudo $*" >> "$STUB_LOG"
  case "$1" in
    -v) touch "$HOME/.ts"; return 0 ;;
    -n) [ -f "$HOME/.ts" ] && [ -z "\${NO_TIMESTAMP:-}" ] || return 1; shift; [ "$1" = -v ] && return 0; [ "$1" = -u ] && return 0; "$@" ;;
    *) return 0 ;;
  esac
}
id() { if [ "$1" = -u ]; then echo 1000; else command id "$@"; fi; }
`;
  it('authorize_once: a single sudo -v, then only sudo -n', () => {
    setup = shHome();
    const r = runSh(setup, `${SUDO}\nauthorize_once; as_root true; as_root echo hi; stop_keepalive`);
    expect(r.status, r.stderr).toBe(0);
    const calls = r.log.split('\n').filter((l) => l.startsWith('sudo '));
    expect(calls.filter((l) => l === 'sudo -v')).toHaveLength(1);
    expect(calls.filter((l) => l !== 'sudo -v').every((l) => l.startsWith('sudo -n'))).toBe(true);
    expect(r.stdout).toContain('Administrator rights given once for this install');
    expect(r.stdout).toContain('install the baseline packages');
  });

  it('F3: a host that keeps no sudo timestamp stops with "run the installer as root"', () => {
    setup = shHome();
    const r = runSh(setup, `${SUDO}\nauthorize_once`, { env: { NO_TIMESTAMP: '1' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'sudo keeps no authorization on this computer: run the installer as root (sudo bash <installer>)',
    );
  });

  it('a lapsed authorization stops with "run again" instead of a confusing failure', () => {
    setup = shHome();
    const r = runSh(setup, `${SUDO}\nauthorize_once; rm -f "$HOME/.ts"; as_root false`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('The administrator authorization of this install ran out.');
  });

  const BASE = (present: string, extra = '') => `
PKG=apt; SUDO="sudo -n"
dpkg-query() { case " ${present} " in *" $3 "*) echo "install ok installed" ;; *) return 1 ;; esac; }
apt-cache() { [ "$2" = libasound2t64 ]; }
pkg_install() { echo "pkg_install $*" >> "$STUB_LOG"; \${PKG_FAIL:+return 1}; return 0; }
have() { return 0; }
ensure_modern_git() { :; }
${extra}
parse_flags "$@"; install_baseline`;

  it('apt: one call per group with only the missing packages; t64 names where the archive has them; idempotent', () => {
    setup = shHome();
    const r = runSh(setup, BASE('ca-certificates curl git'));
    expect(r.status, r.stderr).toBe(0);
    const calls = r.log.split('\n').filter((l) => l.startsWith('pkg_install '));
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain('build-essential');
    expect(calls[0]).not.toMatch(/ curl | git /);
    expect(calls[1]).toContain('libasound2t64');
    expect(calls[1]).not.toContain('libatk1.0-0t64');
    expect(calls[3]).toBe('pkg_install uidmap dbus-user-session iptables slirp4netns');
  });

  it('a failing core group stops; another group only warns', () => {
    setup = shHome();
    const core = runSh(setup, BASE(''), { env: { PKG_FAIL: '1' } });
    expect(core.status).toBe(1);
    expect(core.stderr).toContain('Installing the core packages failed');
    const all =
      'ca-certificates curl git unzip zip tar gzip xz-utils bzip2 build-essential pkg-config python3 openssh-client jq socat bubblewrap';
    const fonts = runSh(setup, BASE(all), { env: { PKG_FAIL: '1' } });
    expect(fonts.status, fonts.stderr).toBe(0);
    expect(fonts.stdout).toContain('Could not install the playwright packages');
  });

  it('--skip-baseline installs nothing: missing core stops, the rest warns', () => {
    setup = shHome();
    const r = runSh(setup, BASE(''), { args: ['--skip-baseline'] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--skip-baseline installs nothing');
    expect(r.log).not.toContain('pkg_install');
    const all =
      'ca-certificates curl git unzip zip tar gzip xz-utils bzip2 build-essential pkg-config python3 openssh-client jq socat bubblewrap';
    const w = runSh(setup, BASE(all), { args: ['--skip-baseline'] });
    expect(w.status, w.stderr).toBe(0);
    expect(w.stdout).toContain('Missing playwright packages (--skip-baseline installs nothing)');
    expect(w.log).not.toContain('pkg_install');
  });

  it('dnf and pacman have their own lists; an unknown package manager stops unless --skip-baseline', () => {
    setup = shHome();
    const dnf = runSh(setup, BASE('', 'PKG=dnf; rpm() { return 1; }'));
    expect(dnf.log).toContain('gcc-c++');
    const pac = runSh(setup, BASE('', 'PKG=pacman; pacman() { return 1; }'));
    expect(pac.log).toContain('base-devel');
    const none = runSh(setup, BASE('', 'PKG=""'));
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('--skip-baseline');
  });

  it('manifest_get docker:<plat>:<part> reads the pinned rootless Docker binaries, and nothing malformed', () => {
    setup = shHome();
    const m = JSON.stringify({
      dockerRootless: {
        'linux-x64': {
          docker: { url: 'https://download.docker.com/x/docker.tgz', sha256: 'a'.repeat(64) },
          extras: { url: 'http://insecure/x.tgz', sha256: 'b'.repeat(64) },
        },
      },
    });
    const r = runSh(
      setup,
      `printf '%s' '${m}' > "$HOME/m.json"
manifest_get "$HOME/m.json" docker:linux-x64:docker; echo "rc=$?"
manifest_get "$HOME/m.json" docker:linux-x64:extras; echo "rc=$?"
manifest_get "$HOME/m.json" docker:linux-x64:compose; echo "rc=$?"
manifest_get "$HOME/m.json" docker:darwin-arm64:docker; echo "rc=$?"`,
    );
    expect(r.stdout).toContain(`https://download.docker.com/x/docker.tgz ${'a'.repeat(64)}\nrc=0`);
    expect(r.stdout.match(/rc=1/g)).toHaveLength(3);
  });

  it('the pinned docker-rootless.json has docker, extras and compose for both Linux platforms', () => {
    const pins = JSON.parse(readFileSync(join(__dirname, '../../../scripts/docker-rootless.json'), 'utf8'));
    for (const plat of ['linux-x64', 'linux-arm64'])
      for (const part of ['docker', 'extras', 'compose']) {
        expect(pins[plat][part].url).toMatch(
          /^https:\/\/(download\.docker\.com|github\.com\/docker\/compose)\//,
        );
        expect(pins[plat][part].sha256).toMatch(/^[0-9a-f]{64}$/);
      }
  });
});

describe('macOS: Docker Desktop and the Command Line Tools (not yet tested on hardware)', () => {
  it('waits for Docker Desktop: shows the link, rechecks on Enter until _ping answers', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `n=0
desktop_docker_answers() { n=$((n+1)); [ "$n" -ge 3 ]; }
interactive() { return 0; }
wait_enter() { return 0; }
parse_flags "$@"; wait_for_docker_desktop; echo "checks=$n"`,
      { os: 'macos' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('https://www.docker.com/products/docker-desktop/');
    expect(r.stdout).toContain('checks=3');
  });

  it('--docker none skips the wait; without a keyboard it never loops (host stops with the link)', () => {
    setup = shHome();
    const W = 'desktop_docker_answers() { return 1; }\nparse_flags "$@"; wait_for_docker_desktop; echo done';
    expect(runSh(setup, W, { os: 'macos', args: ['--docker', 'none'] }).stdout).toContain('done');
    const y = runSh(setup, W, { os: 'macos' });
    expect(y.status, y.stderr).toBe(0);
    expect(y.stdout).toContain('the runner gets no Docker');
    const h = runSh(setup, W, { os: 'macos', args: ['--docker', 'host', '--accept-root-equivalent'] });
    expect(h.status).toBe(1);
    expect(h.stderr).toContain('https://www.docker.com/products/docker-desktop/');
  });
});

describe('installer flags', () => {
  const FLAGS = 'parse_flags "$@"; echo OK';
  it.each([
    [['--runner-user', 'root'], '--runner-user is dedicated or current'],
    [['--sudo', 'on'], 'Unknown option: --sudo'],
    [['--docker', 'group'], '--docker is rootless, host, shared or none'],
    [['--docker', 'narrow'], '--docker is rootless, host, shared or none'],
    [['--docker', 'host'], 'needs --accept-root-equivalent'],
    [['--docker', 'shared', '--docker-socket', '/run/x/docker.sock'], 'needs --accept-shared-daemon'],
    [
      ['--docker', 'shared', '--accept-shared-daemon', '--docker-socket', '/tmp/x.sock'],
      '--docker-socket /run/<name>/docker.sock',
    ],
    [
      ['--docker', 'shared', '--accept-shared-daemon', '--docker-socket', '/run/./docker.sock'],
      '--docker-socket /run/<name>/docker.sock',
    ],
    [['--devops-orgs', 'owned'], '--devops-orgs is none or organization names or ids'],
    [['--approve-app', 'web=/srv/web'], 'Unknown option: --approve-app'],
    [['--allow-unsigned-from', 'https://x.example/path'], 'an exact origin'],
    [['--deploy', 'auto'], '--deploy is ask or off'],
    [['--sudo-password-stdin'], 'Unknown option: --sudo-password-stdin'],
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
        '--docker',
        'host',
        '--accept-root-equivalent',
        '--skip-baseline',
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

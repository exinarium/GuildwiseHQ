import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fakeRunner, runSh, type ShSetup, shHome } from './helpers/installer-sh.ts';

/**
 * UAT R25 F3: on a host with umask 0002 (stock Ubuntu) the installer left the runner tree group-writable and the runner
 * refused to start. F4: the installer takes --ca-file (GUILDWISE_CA_FILE) and gives it to the runner service as
 * NODE_EXTRA_CA_CERTS, without turning TLS checks off.
 */
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const off = { requireSignedRunners: false };

let rel: { dir: string; tgz: Buffer; manifest: string };
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'aom-rel-'));
  const pkg = join(dir, 'pkg/aom-runner');
  mkdirSync(join(pkg, 'dist/lib'), { recursive: true });
  writeFileSync(join(pkg, 'aom-runner'), '#!/bin/sh\n[ "$1" = --version ] && echo 1.10.0\nexit 0\n');
  chmodSync(join(pkg, 'aom-runner'), 0o755);
  writeFileSync(join(pkg, 'dist/lib/x.mjs'), 'export {};\n');
  spawnSync('tar', ['-czf', join(dir, 'aom-runner-1.10.0.tgz'), '-C', join(dir, 'pkg'), 'aom-runner']);
  const tgz = readFileSync(join(dir, 'aom-runner-1.10.0.tgz'));
  const manifest = `${JSON.stringify({
    version: '1.10.0',
    file: 'aom-runner-1.10.0.tgz',
    sha256: sha256(tgz),
    minRunner: '1.10.0',
    floor: '1.10.0',
    allowDowngrade: false,
    nodeRuntime: {},
  })}\n`;
  rel = { dir, tgz, manifest };
});
afterAll(() => rmSync(rel.dir, { recursive: true, force: true }));

let setup: ShSetup;
afterEach(() => setup?.cleanup());

function serve(www: string) {
  const r = join(www, 'api/runner/releases');
  mkdirSync(r, { recursive: true });
  writeFileSync(join(r, 'manifest.json'), rel.manifest);
  writeFileSync(join(r, 'aom-runner-1.10.0.tgz'), rel.tgz);
}

/** bash sources BASH_ENV before the script: the host's own umask, as a stock Ubuntu account has it. */
function hostUmask(home: string, mask: string): Record<string, string> {
  const f = join(home, '.bash-env');
  writeFileSync(f, `umask ${mask}\n`);
  return { BASH_ENV: f };
}

/** Every file and folder under `dir` (symlinks skipped) that its group or others can write. */
function groupOrOtherWritable(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (statSync(d).mode & 0o022) out.push(d);
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (st.mode & 0o022) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const PLACE = 'parse_flags "$@"; stage_runner_release >/dev/null; place_runner_release';

describe('F3: the runner tree is never group or other writable', () => {
  it('a umask 0002 host: the installed tree has no group or other write', () => {
    setup = shHome();
    serve(setup.www);
    const r = runSh(setup, PLACE, { params: off, env: hostUmask(setup.home, '0002') });
    expect(r.status, r.stderr).toBe(0);
    const root = join(setup.home, '.local/share/guildwise/runner');
    expect(groupOrOtherWritable(root)).toEqual([]);
    expect(statSync(join(root, '1.10.0/aom-runner')).mode & 0o777).toBe(0o755);
  });

  it('a tree an earlier installer left group-writable is repaired on the next run', () => {
    setup = shHome();
    serve(setup.www);
    const root = fakeRunner(setup.home, '1.9.0');
    spawnSync('chmod', ['-R', 'g+w,o+w', root]);
    expect(groupOrOtherWritable(root).length).toBeGreaterThan(0);
    const r = runSh(setup, PLACE, { params: off, env: hostUmask(setup.home, '0002') });
    expect(r.status, r.stderr).toBe(0);
    expect(groupOrOtherWritable(root)).toEqual([]);
  });
});

describe('F3: the installer only tightens the umask', () => {
  it.each([
    ['0002', '0022'],
    ['0022', '0022'],
    ['0077', '0077'],
    ['0027', '0027'],
  ])('a host umask %s becomes %s', (host, want) => {
    setup = shHome();
    const r = runSh(setup, 'umask', { env: hostUmask(setup.home, host) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(want);
  });

  it('a kept newer runner (not replaced) is repaired as well', () => {
    setup = shHome();
    serve(setup.www);
    const root = fakeRunner(setup.home, '1.11.0');
    spawnSync('chmod', ['-R', 'g+w', root]);
    const r = runSh(setup, PLACE, { params: off });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('is newer than this server');
    expect(groupOrOtherWritable(root)).toEqual([]);
  });
});

describe('F4: --ca-file gives the runner service a private CA', () => {
  it('refuses a missing file and a file without a certificate', () => {
    setup = shHome();
    const missing = runSh(setup, 'parse_flags "$@"', { args: ['--ca-file', join(setup.home, 'nope.pem')] });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('--ca-file is a readable PEM certificate file');
    writeFileSync(join(setup.home, 'bad.pem'), 'not a certificate\n');
    const bad = runSh(setup, 'parse_flags "$@"', { env: { GUILDWISE_CA_FILE: join(setup.home, 'bad.pem') } });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('--ca-file holds no PEM certificate');
  });

  it('copies the CA into the runner root and puts NODE_EXTRA_CA_CERTS in the user unit and the fallback launcher', () => {
    setup = shHome();
    serve(setup.www);
    const ca = join(setup.home, 'caddy-root.crt');
    writeFileSync(ca, PEM);
    const r = runSh(
      setup,
      `${PLACE}; write_unit_file >/dev/null; write_fallback_launcher; as_runner printenv NODE_EXTRA_CA_CERTS`,
      { params: off, args: ['--ca-file', ca] },
    );
    expect(r.status, r.stderr).toBe(0);
    const root = join(setup.home, '.local/share/guildwise/runner');
    const copy = join(root, 'ca.pem');
    expect(readFileSync(copy, 'utf8')).toBe(PEM);
    expect(statSync(copy).mode & 0o777).toBe(0o644);
    // pairing (as_runner) sees it too
    expect(r.stdout.trim().split('\n').pop()).toBe(copy);
    const unit = readFileSync(join(setup.home, '.config/systemd/user/aom-runner.service'), 'utf8');
    expect(unit).toContain(`Environment="NODE_EXTRA_CA_CERTS=${copy}"\n`);
    expect(unit).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(readFileSync(join(root, 'start-runner.sh'), 'utf8')).toContain(
      `export NODE_EXTRA_CA_CERTS="${copy}"`,
    );
  });

  it('a re-run without the flag keeps the CA; without any CA the unit has no such line', () => {
    setup = shHome();
    serve(setup.www);
    const ca = join(setup.home, 'caddy-root.crt');
    writeFileSync(ca, PEM);
    expect(runSh(setup, PLACE, { params: off, args: ['--ca-file', ca] }).status).toBe(0);
    const again = runSh(setup, `${PLACE}; write_unit_file >/dev/null`, { params: off });
    expect(again.status, again.stderr).toBe(0);
    const unitFile = join(setup.home, '.config/systemd/user/aom-runner.service');
    expect(readFileSync(unitFile, 'utf8')).toContain('NODE_EXTRA_CA_CERTS=');
    rmSync(join(setup.home, '.local/share/guildwise/runner/ca.pem'));
    const none = runSh(setup, `${PLACE}; write_unit_file >/dev/null`, { params: off });
    expect(none.status, none.stderr).toBe(0);
    expect(readFileSync(unitFile, 'utf8')).not.toContain('NODE_EXTRA_CA_CERTS');
  });

  it('the dedicated user: guildwise-admin service install gets --ca-file', () => {
    setup = shHome();
    serve(setup.www);
    const ca = join(setup.home, 'caddy-root.crt');
    writeFileSync(ca, PEM);
    const r = runSh(
      setup,
      `${PLACE}; as_root() { echo "as_root $*" >> "$STUB_LOG"; }; record_service_mode() { :; }; install_dedicated_service`,
      { params: off, args: ['--ca-file', ca] },
    );
    expect(r.status, r.stderr).toBe(0);
    const root = join(setup.home, '.local/share/guildwise/runner');
    expect(r.log).toContain(
      `service install --runner-root ${root} --ca-file ${join(root, 'ca.pem')} --start`,
    );
  });
});

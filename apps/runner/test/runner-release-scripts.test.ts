import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RunnerReleaseManifestSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { verifyMinisign } from '../src/update/minisign.ts';
import { FIXTURES, manifestText, minisignSign, OTHER_PUB, TEST_KEY_ID, TEST_PUB } from './minisign-helper.ts';

/** The release scripts of core DESIGN R18-U and R30 (scripts/*runner*), run against temp copies and the test-only keys. */
const REPO = resolve(import.meta.dirname, '..', '..', '..');
const script = (name: string) => join(REPO, 'scripts', name);
const run = (cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  spawnSync(cmd, args, { cwd: o.cwd ?? REPO, env: { ...process.env, ...o.env }, encoding: 'utf8' });
const hasMinisign = spawnSync('minisign', ['-v']).status === 0;

describe('runner-key-check.mjs: public keys only', () => {
  it('prints the key line and the key id of a minisign public key', () => {
    const r = run('node', [script('runner-key-check.mjs'), join(FIXTURES, 'test.pub')]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^RW[A-Za-z0-9+/]{54}$/);
    expect(
      run('node', [script('runner-key-check.mjs'), '--id', join(FIXTURES, 'test.pub')]).stdout.trim(),
    ).toBe(TEST_KEY_ID);
  });

  it('refuses a secret key (plain or passphrase), a file with more lines, and garbage, printing nothing of it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-keys-'));
    const three = join(dir, 'three.pub');
    writeFileSync(three, `${readFileSync(join(FIXTURES, 'test.pub'), 'utf8')}extra line\n`);
    const junk = join(dir, 'junk.pub');
    writeFileSync(junk, 'untrusted comment: x\nnot a key\n');
    for (const f of [join(FIXTURES, 'test.key'), join(FIXTURES, 'protected.key'), three, junk]) {
      const r = run('node', [script('runner-key-check.mjs'), f]);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(run('node', [script('runner-key-check.mjs'), join(FIXTURES, 'test.key')]).stderr).toMatch(
      /SECRET key/,
    );
  });
});

describe('set-runner-release-key.sh', () => {
  function sandbox(): string {
    const dir = mkdtempSync(join(tmpdir(), 'aom-setkey-'));
    mkdirSync(join(dir, 'scripts'));
    for (const f of ['set-runner-release-key.sh', 'runner-key-check.mjs'])
      copyFileSync(script(f), join(dir, 'scripts', f));
    return dir;
  }

  it('writes the .pub file and the generated release-key.ts from a public key', () => {
    const dir = sandbox();
    const r = run('bash', [join(dir, 'scripts', 'set-runner-release-key.sh'), join(FIXTURES, 'test.pub')], {
      cwd: dir,
    });
    expect(r.status, r.stderr).toBe(0);
    const pub = readFileSync(join(dir, 'apps/runner/release-key/guildwise-runner-release.pub'), 'utf8');
    expect(pub.split('\n')[1]).toBe(TEST_PUB.split('\n')[1]);
    const ts = readFileSync(join(dir, 'packages/shared/src/security/release-key.ts'), 'utf8');
    expect(ts).toContain(`OFFICIAL_RUNNER_RELEASE_KEY_ID: string | null = '${TEST_KEY_ID}'`);
    expect(ts).toContain(TEST_PUB.split('\n')[1] as string);
    expect(ts).not.toContain("= 'PLACEHOLDER'");
  });

  it('refuses a secret key and writes nothing', () => {
    const dir = sandbox();
    const r = run('bash', [join(dir, 'scripts', 'set-runner-release-key.sh'), join(FIXTURES, 'test.key')], {
      cwd: dir,
    });
    expect(r.status).not.toBe(0);
    expect(spawnSync('ls', [join(dir, 'apps')]).status).not.toBe(0);
  });

  it('the repository still holds the placeholder (the owner sets his key after the merge)', () => {
    expect(
      readFileSync(join(REPO, 'apps/runner/release-key/guildwise-runner-release.pub'), 'utf8'),
    ).toContain('PLACEHOLDER');
  });
});

describe('runner-manifest.mjs', () => {
  it('writes the manifest of the tgz: version, file, sha256, floor, no downgrade', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-manifest-'));
    const tgz = join(dir, 'aom-runner-1.10.0.tgz');
    writeFileSync(tgz, 'runner bytes');
    const r = run('node', [script('runner-manifest.mjs'), tgz, '1.10.0', '1.10.0']);
    expect(r.status, r.stderr).toBe(0);
    const m = RunnerReleaseManifestSchema.parse(JSON.parse(r.stdout));
    expect(m).toMatchObject({
      version: '1.10.0',
      file: 'aom-runner-1.10.0.tgz',
      floor: '1.10.0',
      allowDowngrade: false,
    });
    expect(m.sha256).toBe(createHash('sha256').update('runner bytes').digest('hex'));
    expect(run('node', [script('runner-manifest.mjs'), tgz, '1.10.1', '1.10.0']).status).not.toBe(0);
  });
});

describe.skipIf(!hasMinisign)('sign-runner-release.sh (key holder only; here with the test-only key)', () => {
  it('signs manifest.json with the trusted comment and verifies it with the public key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-sign-'));
    const m = join(dir, 'manifest.json');
    writeFileSync(m, manifestText('1.10.0', 'a'.repeat(64)));
    const r = run(
      'bash',
      [
        script('sign-runner-release.sh'),
        m,
        '--key',
        join(FIXTURES, 'test.key'),
        '--pub',
        join(FIXTURES, 'test.pub'),
      ],
      {
        env: { HOME: dir },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const v = verifyMinisign(readFileSync(m), readFileSync(`${m}.minisig`, 'utf8'), TEST_PUB);
    expect(v).toMatchObject({ ok: true, trustedComment: 'guildwise-runner 1.10.0' });
    // the retained per-version manifest gets the same signature (W12 serves it for pins)
    const kept = join(dir, 'manifest-1.10.0.json');
    expect(verifyMinisign(readFileSync(kept), readFileSync(`${kept}.minisig`, 'utf8'), TEST_PUB).ok).toBe(
      true,
    );
  });
});

describe.skipIf(!hasMinisign)('runner-release.sh (the image build modes)', () => {
  function core(version = '1.10.0'): string {
    const dir = mkdtempSync(join(tmpdir(), 'aom-image-'));
    mkdirSync(join(dir, 'apps/runner/src'), { recursive: true });
    mkdirSync(join(dir, 'apps/runner/release-key'), { recursive: true });
    writeFileSync(join(dir, 'apps/runner/src/version.ts'), `export const RUNNER_VERSION = '${version}';\n`);
    copyFileSync(
      join(REPO, 'apps/runner/release-key/guildwise-runner-release.pub'),
      join(dir, 'apps/runner/release-key/guildwise-runner-release.pub'),
    );
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.9.0] - 2026-11-15\n');
    return dir;
  }
  function signedRelease(dir: string, key: 'test.key' | 'other.key' = 'test.key', tamper = false) {
    const rel = join(dir, 'runner-release');
    mkdirSync(rel);
    writeFileSync(join(rel, 'aom-runner-1.10.0.tgz'), 'runner bytes');
    const sha = spawnSync('sha256sum', [join(rel, 'aom-runner-1.10.0.tgz')], {
      encoding: 'utf8',
    }).stdout.split(' ')[0] as string;
    const text = manifestText('1.10.0', sha);
    writeFileSync(join(rel, 'manifest.json'), text);
    writeFileSync(join(rel, 'manifest.json.minisig'), minisignSign(text, key, 'guildwise-runner 1.10.0'));
    if (tamper) writeFileSync(join(rel, 'aom-runner-1.10.0.tgz'), 'other bytes');
  }
  const pubLine = (pub: string) => pub.split('\n')[1] as string;

  it('own-key: verifies runner-release/ with the build-arg key and copies the three assets', () => {
    const dir = core();
    signedRelease(dir);
    const out = join(dir, 'out');
    const r = run('bash', [script('runner-release.sh'), 'own-key', out], {
      cwd: dir,
      env: { CORE_DIR: dir, AOM_RUNNER_RELEASE_PUBKEY: pubLine(TEST_PUB) },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(spawnSync('ls', [out], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort()).toEqual([
      'aom-runner-1.10.0.tgz',
      'manifest-1.10.0.json',
      'manifest-1.10.0.json.minisig',
      'manifest.json',
      'manifest.json.minisig',
    ]);
    // the per-version copy verifies on its own (a pin to this release can be served later)
    expect(
      verifyMinisign(
        readFileSync(join(out, 'manifest-1.10.0.json')),
        readFileSync(join(out, 'manifest-1.10.0.json.minisig'), 'utf8'),
        TEST_PUB,
      ).ok,
    ).toBe(true);
  });

  it('own-key: the build fails on a signature by another key or a tgz that does not match', () => {
    for (const [key, tamper, pub] of [
      ['test.key', false, OTHER_PUB],
      ['other.key', false, TEST_PUB],
      ['test.key', true, TEST_PUB],
    ] as const) {
      const dir = core();
      signedRelease(dir, key, tamper);
      const r = run('bash', [script('runner-release.sh'), 'own-key', join(dir, 'out')], {
        cwd: dir,
        env: { CORE_DIR: dir, AOM_RUNNER_RELEASE_PUBKEY: pubLine(pub) },
      });
      expect(r.status).not.toBe(0);
    }
  });

  it('official: refuses the placeholder key before downloading anything', () => {
    const dir = core();
    const r = run('bash', [script('runner-release.sh'), 'official', join(dir, 'out')], {
      cwd: dir,
      env: { CORE_DIR: dir, RUNNER_RELEASE_BASE_URL: 'http://127.0.0.1:9/none' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/placeholder|not found/);
  });
});

describe('the Dockerfile runner-release stage', () => {
  const docker = readFileSync(join(REPO, 'Dockerfile'), 'utf8');
  it('is its own stage with the three modes, only the runtime copies from it, and no secret key is copied', () => {
    expect(docker).toMatch(/FROM build AS runner-release/);
    expect(docker).toMatch(/ARG RUNNER_RELEASE=official/);
    expect(docker).toMatch(/scripts\/runner-release\.sh "\$RUNNER_RELEASE" \/out\/release/);
    expect(docker).toMatch(/COPY --from=runner-release [^\n]*\/out\/release \/app\/release/);
    const worker = docker.slice(docker.indexOf('AS video-worker'), docker.indexOf('AS runtime'));
    expect(worker).not.toMatch(/runner-release/);
    expect(docker).not.toMatch(/\.key\b(?!s)/);
    expect(readFileSync(join(REPO, '.dockerignore'), 'utf8')).toMatch(/\*\*\/\*\.key/);
  });
});

describe('package-runner.sh keeps a per-version manifest', () => {
  it('writes manifest-<version>.json next to manifest.json and drops stale signatures of both', () => {
    const sh = readFileSync(join(REPO, 'scripts/package-runner.sh'), 'utf8');
    expect(sh).toMatch(/rm -f "\$OUT\/manifest\.json\.minisig" "\$OUT\/manifest-\$VERSION\.json\.minisig"/);
    expect(sh).toMatch(/cp "\$OUT\/manifest\.json" "\$OUT\/manifest-\$VERSION\.json"/);
  });
});

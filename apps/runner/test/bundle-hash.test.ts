import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BundleError, inspectBundle, readBundleAtCommit, readBundleFromDir } from '../src/delivery/bundle.ts';
import { DeliveryService } from '../src/delivery/service.ts';
import { deliveryWorld, FOLDER, P5_FIXTURE } from './delivery-fixture.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';

cleanupTmp();

describe('the delivery bundle hash (docs/design/ceo-front-door.md 9.4)', () => {
  it('is stable and independent of the order files are listed in', async () => {
    const a = readBundleFromDir(P5_FIXTURE);
    const b = readBundleFromDir(P5_FIXTURE);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toHaveLength(64);
    const reversed = { ...a, files: [...a.files].reverse() };
    const { makeBundle } = await import('../src/delivery/bundle.ts');
    expect(makeBundle(reversed.files).hash).toBe(a.hash);
  });

  it('a git vault is read AT A COMMIT: working-tree edits and later commits do not change it', async () => {
    const w = await deliveryWorld();
    const c1 = w.commitRecipe();
    await w.vaults.syncNow('v1');
    const dir = w.vaults.dir('v1');
    const first = await readBundleAtCommit(dir, FOLDER, c1);
    // an uncommitted edit in the clone's working tree is ignored
    writeFileSync(
      join(dir, FOLDER, 'delivery', 'scripts', 'local.sh'),
      '#!/usr/bin/env bash\necho tampered\n',
    );
    expect((await readBundleAtCommit(dir, FOLDER, c1)).hash).toBe(first.hash);
    // a later commit changes the hash only for that commit
    const c2 = w.commitRecipe((d) =>
      writeFileSync(join(d, 'scripts', 'smoke-local.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 }),
    );
    await w.vaults.syncNow('v1');
    sh(dir, 'git', ['checkout', '--', '.']);
    expect((await readBundleAtCommit(dir, FOLDER, c2)).hash).not.toBe(first.hash);
    expect((await readBundleAtCommit(dir, FOLDER, c1)).hash).toBe(first.hash);
  });

  it('the executable bit is part of the hash; a symlink is refused', async () => {
    const dir = tmp('aom-bundle-');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'recipe.yaml'), 'version: 1\n');
    writeFileSync(join(dir, 'scripts', 'a.sh'), 'echo hi\n');
    chmodSync(join(dir, 'scripts', 'a.sh'), 0o644);
    const plain = readBundleFromDir(dir);
    chmodSync(join(dir, 'scripts', 'a.sh'), 0o755);
    expect(readBundleFromDir(dir).hash).not.toBe(plain.hash);
    symlinkSync('/etc/passwd', join(dir, 'link'));
    expect(() => readBundleFromDir(dir)).toThrow(BundleError);
  });

  it('inspect reports the recipe, the lint and a secret in a file by kind (never the secret)', async () => {
    const dir = tmp('aom-bundle-');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(
      join(dir, 'recipe.yaml'),
      'version: 1\nenvironments:\n  - { name: local, target: t, script: scripts/a.sh }\n',
    );
    writeFileSync(
      join(dir, 'scripts', 'a.sh'),
      '#!/bin/sh\nexport TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
      { mode: 0o755 },
    );
    const r = inspectBundle(readBundleFromDir(dir), null);
    expect(r.ok && r.recipe).toBeTruthy();
    expect(r.ok && r.lint).toEqual([
      expect.objectContaining({ code: 'secret_in_file', path: 'scripts/a.sh' }),
    ]);
    expect(JSON.stringify(r)).not.toContain('ghp_abcdef');
  });

  it('an inspect of the P5 fixture in a git vault is clean, and a local vault gives the same hash from the folder', async () => {
    const w = await deliveryWorld();
    const commit = w.commitRecipe();
    const svc = new DeliveryService({ vaults: w.vaults as never, rpc: async () => ({ ok: false }) });
    const r = await svc.inspect({
      projectId: '019da000-0000-7000-8000-000000000003',
      vault: { vaultId: 'v1', storage: 'git', folder: FOLDER },
      commit,
    });
    expect(r.ok && r.present).toBe(true);
    expect(r.ok && r.vaultCommit).toBe(commit);
    expect(r.ok && r.lint.filter((l) => (l as { level: string }).level === 'error')).toEqual([]);
    expect(r.ok && r.hash).toBe(readBundleFromDir(P5_FIXTURE).hash);
  });
});

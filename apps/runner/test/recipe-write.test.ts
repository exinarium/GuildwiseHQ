import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bundleHash, compileSetup, localAdoptEnv, type RecipeWritePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { readBundleAtCommit } from '../src/delivery/bundle.ts';
import { DeliveryService } from '../src/delivery/service.ts';
import { deliveryWorld, FOLDER } from './delivery-fixture.ts';
import { cleanupTmp, sh } from './helpers.ts';

cleanupTmp();

const PROJECT = '019da000-0000-7000-8000-000000000003';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const env = (over: Record<string, unknown> = {}) => ({
  ...localAdoptEnv({
    name: 'uat',
    label: 'Test copy',
    target: 'aom-uat',
    composeFile: '~/uat/docker-compose.yml',
    service: 'app',
    imageName: 'uat-app',
    appUrl: 'http://localhost:4700',
  }),
  ...over,
});

function payload(
  storage: 'git' | 'local',
  over: Partial<RecipeWritePayload> = {},
  setup: unknown = { environments: [env()] },
  opts: Parameters<typeof compileSetup>[1] = {},
): RecipeWritePayload {
  const c = compileSetup(setup, opts);
  if (!c.ok) throw new Error(c.issues.join('; '));
  return {
    projectId: PROJECT,
    vault: { vaultId: 'v1', storage, folder: FOLDER },
    files: c.files,
    keep: c.keep,
    commitMessage: 'delivery setup (guided)',
    expectedHash: c.hash,
    setupHash: c.hash,
    ...over,
  };
}

const service = (w: Awaited<ReturnType<typeof deliveryWorld>>) =>
  new DeliveryService({ vaults: w.vaults, rpc: async () => ({ ok: true, result: {} }) });

describe('recipe.write (guided deploy setup)', () => {
  it('writes the generated files in one commit with the modes, pushes it, and reports what is there', async () => {
    const w = await deliveryWorld();
    const p = payload('git');
    const r = await service(w).write(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ committed: true, pushed: true });
    expect(r.inspected.ok && r.inspected.hash).toBe(p.expectedHash);
    // the setup is part of the inspection, so the server can see guided environments
    expect(r.inspected.ok && (r.inspected as { setup?: unknown }).setup).toBeTruthy();
    sh(w.vault.other, 'git', ['pull', '--rebase', 'origin', 'main']);
    expect(
      sh(w.vault.other, 'git', ['ls-tree', 'HEAD', `${FOLDER}/delivery/scripts/uat.sh`]).startsWith('100755'),
    ).toBe(true);
    expect(
      sh(w.vault.other, 'git', ['ls-tree', 'HEAD', `${FOLDER}/delivery/recipe.yaml`]).startsWith('100644'),
    ).toBe(true);
    expect(sh(w.vault.other, 'git', ['log', '-1', '--pretty=%s'])).toContain('delivery setup (guided)');
    const bundle = await readBundleAtCommit(w.vaults.dir('v1'), FOLDER, r.vaultCommit as string);
    expect(bundle.files.map((f) => f.path)).toEqual(['recipe.yaml', 'scripts/uat.sh', 'setup.json']);
    // the same files again: a success without a new commit
    const again = await service(w).write(p);
    expect(again.ok && again.committed).toBe(false);
  });

  it('a local vault is rewritten in place', async () => {
    const w = await deliveryWorld({ storage: 'local' });
    const r = await service(w).write(payload('local'));
    expect(r.ok && r.committed).toBe(false);
    expect(existsSync(join(w.vaults.localDir('v1'), FOLDER, 'delivery', 'scripts', 'uat.sh'))).toBe(true);
  });

  it('refuses a path outside delivery/, a secret in a file, and files that are not what was previewed', async () => {
    const w = await deliveryWorld();
    const svc = service(w);
    const base = payload('git');
    for (const path of ['../x.sh', '/etc/x', 'a/../../b', 'scripts//x', './x']) {
      const files = [...base.files, { path, mode: '644' as const, content: 'x' }];
      const entries = files.map((f) => ({ path: f.path, mode: f.mode, sha256: sha(f.content) }));
      const r = await svc.write({ ...base, files, expectedHash: bundleHash(entries) });
      expect(r.ok, path).toBe(false);
    }
    const leaked = [
      ...base.files,
      { path: 'notes.txt', mode: '644' as const, content: 'password = "correct-horse-battery"' },
    ];
    const r2 = await svc.write({
      ...base,
      files: leaked,
      expectedHash: bundleHash(leaked.map((f) => ({ path: f.path, mode: f.mode, sha256: sha(f.content) }))),
    });
    expect(!r2.ok && r2.error).toContain('contains a hard-coded credential');
    const r3 = await svc.write({ ...base, expectedHash: 'f'.repeat(64) });
    expect(!r3.ok && r3.error).toContain('preview again');
    // nothing was written
    sh(w.vault.other, 'git', ['pull', '--rebase', 'origin', 'main']);
    expect(existsSync(join(w.vault.other, FOLDER, 'delivery'))).toBe(false);
  });

  it('keeps the hand-written script of a custom environment, and refuses when it is not there', async () => {
    const w = await deliveryWorld();
    const svc = service(w);
    const first = await svc.write(
      payload(
        'git',
        {},
        { environments: [env({ mode: 'custom' })] },
        { customScripts: { uat: '#!/bin/sh\necho mine\n' } },
      ),
    );
    expect(first.ok).toBe(true);
    // a later write that leaves the script alone (keep) carries it over
    const setup = { environments: [env({ mode: 'custom', label: 'Renamed' })] };
    const second = await svc.write(payload('git', {}, setup));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const bundle = await readBundleAtCommit(w.vaults.dir('v1'), FOLDER, second.vaultCommit as string);
    expect(bundle.files.find((f) => f.path === 'scripts/uat.sh')?.content.toString()).toBe(
      '#!/bin/sh\necho mine\n',
    );
    expect(bundle.files.find((f) => f.path === 'scripts/uat.sh')?.mode).toBe('755');
    // an environment that never had a script cannot be kept
    const w2 = await deliveryWorld();
    const lost = await service(w2).write(payload('git', {}, setup));
    expect(!lost.ok && lost.error).toContain('not in delivery/ any more');
  });

  it('is replaced as a whole: a file that is no longer generated disappears', async () => {
    const w = await deliveryWorld();
    const svc = service(w);
    await svc.write(payload('git'));
    const second = await svc.write(
      payload('git', {}, { environments: [env({ name: 'staging', target: 'stg' })] }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const bundle = await readBundleAtCommit(w.vaults.dir('v1'), FOLDER, second.vaultCommit as string);
    expect(bundle.files.map((f) => f.path)).toEqual(['recipe.yaml', 'scripts/staging.sh', 'setup.json']);
  });
});

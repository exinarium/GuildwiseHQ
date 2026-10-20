import { webcrypto } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBundleAtCommit, readBundleFromDir } from '../src/delivery/bundle.ts';
import { DeliveryService } from '../src/delivery/service.ts';
import { DeploySecrets } from '../src/secrets/deploy.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { redact, unregisterSecret } from '../src/secrets/redact.ts';
import { deliveryWorld, FOLDER, P5_FIXTURE } from './delivery-fixture.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';

cleanupTmp();

const PROJECT = '019da000-0000-7000-8000-000000000003';

function service(w: Awaited<ReturnType<typeof deliveryWorld>>, storage: 'git' | 'local') {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const svc = new DeliveryService({
    vaults: w.vaults,
    rpc: async (_shift, method, params) => {
      calls.push({ method, params });
      if (params.phase === 'begin')
        return {
          ok: true,
          result: { projectId: PROJECT, vault: { vaultId: 'v1', storage, folder: FOLDER } },
        };
      return {
        ok: true,
        result: {
          recorded: true,
          status: 'observed',
          hash: (params.inspected as { hash: string }).hash,
          lint: [],
        },
      };
    },
  });
  return { svc, calls };
}

function scratch(): string {
  const dir = tmp('aom-scratch-');
  cpSync(P5_FIXTURE, dir, { recursive: true });
  return dir;
}

describe('aom recipe save (docs/design/ceo-front-door.md 10)', () => {
  it('copies the scratch folder into <folder>/delivery/ of a git vault, commits and pushes it, and reports its hash', async () => {
    const w = await deliveryWorld();
    const { svc, calls } = service(w, 'git');
    const r = await svc.save('shift-1', { dir: scratch(), project: 'P5' });
    expect(r.ok).toBe(true);
    const res = (r as { result: { committed: boolean; pushed: boolean; vaultCommit: string; hash: string } })
      .result;
    expect(res).toMatchObject({ committed: true, pushed: true, hash: readBundleFromDir(P5_FIXTURE).hash });
    // the commit is on the remote, executable bits intact
    sh(w.vault.other, 'git', ['pull', '--rebase', 'origin', 'main']);
    const mode = sh(w.vault.other, 'git', ['ls-tree', 'HEAD', `${FOLDER}/delivery/scripts/local.sh`]);
    expect(mode.startsWith('100755')).toBe(true);
    expect((await readBundleAtCommit(w.vaults.dir('v1'), FOLDER, res.vaultCommit)).hash).toBe(res.hash);
    expect(calls.map((c) => c.params.phase)).toEqual(['begin', 'done']);
    // saving the same files again is a success without a new commit
    const again = (await svc.save('shift-1', { dir: scratch(), project: 'P5' })) as {
      result: { committed: boolean; vaultCommit: string };
    };
    expect(again.result.committed).toBe(false);
    expect(again.result.vaultCommit).toBe(res.vaultCommit);
  });

  it('a local vault is rewritten in place (no commit)', async () => {
    const w = await deliveryWorld({ storage: 'local' });
    const { svc } = service(w, 'local');
    const r = (await svc.save('shift-1', { dir: scratch(), project: 'P5' })) as {
      ok: boolean;
      result: { committed: boolean; hash: string };
    };
    expect(r.ok).toBe(true);
    expect(r.result.committed).toBe(false);
    expect(existsSync(join(w.vaults.localDir('v1'), FOLDER, 'delivery', 'recipe.yaml'))).toBe(true);
    expect(readBundleFromDir(join(w.vaults.localDir('v1'), FOLDER, 'delivery')).hash).toBe(r.result.hash);
  });

  it('refuses a folder with a secret in it (named by file, never the value), a symlink, or no recipe.yaml', async () => {
    const w = await deliveryWorld();
    const { svc } = service(w, 'git');
    const withSecret = scratch();
    writeFileSync(
      join(withSecret, 'scripts', 'oops.sh'),
      'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
    );
    const r1 = (await svc.save('s', { dir: withSecret, project: 'P5' })) as { ok: boolean; error: string };
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('scripts/oops.sh');
    expect(r1.error).not.toContain('ghp_abcdef');
    const withLink = scratch();
    symlinkSync('/etc', join(withLink, 'etc'));
    expect(((await svc.save('s', { dir: withLink, project: 'P5' })) as { error: string }).error).toContain(
      'symlink',
    );
    const noRecipe = tmp('aom-scratch-');
    writeFileSync(join(noRecipe, 'a.sh'), 'echo');
    chmodSync(join(noRecipe, 'a.sh'), 0o755);
    expect(((await svc.save('s', { dir: noRecipe, project: 'P5' })) as { error: string }).error).toContain(
      'no recipe.yaml',
    );
    // nothing reached the vault
    expect(existsSync(join(w.vaults.dir('v1'), FOLDER, 'delivery'))).toBe(false);
  });

  it('does not write through a symlink in the vault', async () => {
    const w = await deliveryWorld({ storage: 'local' });
    const dir = w.vaults.localDir('v1');
    const outside = tmp('aom-outside-');
    mkdirSync(join(dir, 'projects'), { recursive: true });
    symlinkSync(outside, join(dir, FOLDER));
    const { svc } = service(w, 'local');
    const r = (await svc.save('s', { dir: scratch(), project: 'P5' })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(existsSync(join(outside, 'delivery'))).toBe(false);
  });
});

async function seal(publicKeyB64: string, text: string): Promise<string> {
  const key = await webcrypto.subtle.importKey(
    'spki',
    Buffer.from(publicKeyB64, 'base64'),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  return Buffer.from(
    await webcrypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(text)),
  ).toString('base64');
}

describe('deploy secrets (kept on the workstation only)', () => {
  afterEach(() => unregisterSecret('prod-key-value-123'));

  it('stores only ciphertext, hands the value to the deploy and hides it from logs', async () => {
    const dir = tmp('aom-secrets-');
    const keys = new RunnerKeys(join(dir, 'secrets', 'runner-key.pem'));
    const s = new DeploySecrets({ secretsDir: join(dir, 'secrets'), keys });
    expect(
      s.setFor({
        projectId: PROJECT,
        name: 'P5_PROD_DEPLOY_KEY',
        keyId: keys.publicKey.keyId,
        ciphertext: await seal(keys.publicKey.publicKey, 'prod-key-value-123'),
      }),
    ).toEqual({ stored: true });
    expect(readFileSync(join(dir, 'secrets', 'deploy.json'), 'utf8')).not.toContain('prod-key-value-123');
    expect(s.valuesFor(PROJECT, ['P5_PROD_DEPLOY_KEY', 'NOT_SET'])).toEqual({
      values: { P5_PROD_DEPLOY_KEY: 'prod-key-value-123' },
      missing: ['NOT_SET'],
    });
    expect(redact('key prod-key-value-123 end')).toBe('key *** end');
    // another project's name space is separate
    expect(s.valuesFor('019da000-0000-7000-8000-0000000000ff', ['P5_PROD_DEPLOY_KEY']).missing).toEqual([
      'P5_PROD_DEPLOY_KEY',
    ]);
  });

  it('refuses a lower-case name and a value sealed for another key', async () => {
    const dir = tmp('aom-secrets-');
    const keys = new RunnerKeys(join(dir, 'secrets', 'runner-key.pem'));
    const s = new DeploySecrets({ secretsDir: join(dir, 'secrets'), keys });
    expect(
      s.setFor({ projectId: PROJECT, name: 'lower', keyId: keys.publicKey.keyId, ciphertext: 'x' }).stored,
    ).toBe(false);
    expect(
      s.setFor({ projectId: PROJECT, name: 'GOOD_NAME', keyId: 'another-key', ciphertext: 'x' }).stored,
    ).toBe(false);
  });
});

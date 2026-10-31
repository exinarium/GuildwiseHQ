import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShiftBrief } from '@aom/shared';
import { BUILTIN_ROLES } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildShiftSettings } from '../src/adapters/claude-policy.ts';
import {
  readVaultContext,
  readVaultContexts,
  withVaultContext,
  withVaultContexts,
} from '../src/vaults/context.ts';
import { shiftVaultsOf } from '../src/shifts/supervisor.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';
import { IDENTITY, makeVault } from './vault-fixtures.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const ORG = { vaultId: 'vault-org', kind: 'org' as const, folder: 'projects/toy' };
const PRJ = { vaultId: 'vault-prj', kind: 'project' as const, folder: 'projects/toy' };

async function runCard(
  vaults: Array<{ vaultId: string; kind: 'org' | 'project' }>,
  startExtra: Record<string, unknown>,
) {
  let seen: any;
  const adapter = new ScriptedAdapter(async (i, ctl) => {
    seen = i;
    await ctl.post('/v1/report', {
      report: { kind: 'outcome', outcomeId: 'handoff', note: 'n', data: {} },
    });
  });
  h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
  const origins: Record<string, ReturnType<typeof makeVault>> = {};
  for (const v of vaults)
    origins[v.vaultId] = makeVault({
      'standing-orders.md': `Rules of ${v.vaultId}\n`,
      'projects/toy/PROJECT.md': `# Toy from ${v.vaultId}\n`,
    });
  h.server.send('command', {
    commandId: 'cfg',
    command: 'vault.configure',
    payload: {
      vaults: vaults.map((v) => ({
        vaultId: v.vaultId,
        kind: v.kind,
        name: v.vaultId,
        remoteUrl: origins[v.vaultId]!.origin,
        syncIntervalSec: 3600,
      })),
      identity: IDENTITY,
      workstationName: 'Desk',
    },
  });
  expect((await h.server.waitFor('command.result', (m) => m.commandId === 'cfg')).ok).toBe(true);
  const { ended } = await h.runShift({ stage: 'build', startExtra });
  return { seen, ended };
}

describe('card shift: organization vault and project vault', () => {
  it('mounts both vaults read-only and lists both under Folders you can read', async () => {
    const { seen, ended } = await runCard(
      [
        { vaultId: 'vault-prj', kind: 'project' },
        { vaultId: 'vault-org', kind: 'org' },
      ],
      { vault: PRJ, vaults: [PRJ, ORG] },
    );
    expect(ended.outcome).toBeDefined();
    const dirs = (seen.readDirs as string[]).filter((d) => /vault-(org|prj)$/.test(d));
    expect(dirs.map((d) => d.split('/').pop()).sort()).toEqual(['vault-org', 'vault-prj']);
    for (const d of dirs) expect(seen.addDirs).not.toContain(d);
    expect(seen.instructionsMarkdown).toContain('Folders you can read');
    for (const d of dirs) expect(seen.instructionsMarkdown).toContain(d);
    expect(seen.instructionsMarkdown).toContain('Rules of vault-org');
    expect(seen.instructionsMarkdown).toContain('Rules of vault-prj');
    expect(seen.instructionsMarkdown).toContain('Organization vault standing orders');
    expect(seen.instructionsMarkdown).toContain('Project vault standing orders');
    // PROJECT.md comes from the first (primary) vault
    expect(seen.instructionsMarkdown).toContain('Toy from vault-prj');
  });

  it('a vault with no clone here is skipped and the shift still starts', async () => {
    const { seen } = await runCard([{ vaultId: 'vault-prj', kind: 'project' }], {
      vault: PRJ,
      vaults: [PRJ, ORG],
    });
    const dirs = (seen.readDirs as string[]).filter((d) => /vault-(org|prj)$/.test(d));
    expect(dirs.map((d) => d.split('/').pop())).toEqual(['vault-prj']);
  });

  it('an older server message (single vault, no vaults) mounts that vault read-only', async () => {
    const { seen } = await runCard([{ vaultId: 'vault-org', kind: 'org' }], { vault: ORG });
    const dirs = (seen.readDirs as string[]).filter((d) => /vault-(org|prj)$/.test(d));
    expect(dirs.map((d) => d.split('/').pop())).toEqual(['vault-org']);
    expect(seen.addDirs.some((d: string) => /vault-org$/.test(d))).toBe(false);
    expect(seen.instructionsMarkdown).toContain('Vault standing orders');
    expect(seen.instructionsMarkdown).not.toContain('Organization vault standing orders');
  });
});

describe('readVaultContexts / withVaultContexts', () => {
  const clone = (dir: string, id: string, orders: string) => {
    const root = join(dir, id);
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'standing-orders.md'), orders);
    return root;
  };
  const brief = { project: { key: 'T' }, standingOrders: [] } as unknown as ShiftBrief;

  it('one vault gives the same brief as withVaultContext', async () => {
    const dir = tmp('aom-vaults-');
    clone(dir, 'vault-org', 'Be kind\n');
    const single = await readVaultContext(dir, ORG);
    const many = await readVaultContexts(dir, [ORG]);
    expect(withVaultContexts(brief, many)).toEqual(withVaultContext(brief, single));
  });

  it('drops duplicates and vaults without a clone, and labels two vaults', async () => {
    const dir = tmp('aom-vaults-');
    clone(dir, 'vault-org', 'Org rule\n');
    clone(dir, 'vault-prj', 'Project rule\n');
    const ctxs = await readVaultContexts(dir, [
      PRJ,
      ORG,
      PRJ,
      { vaultId: 'nope', kind: 'org', folder: 'projects/toy' },
    ]);
    expect(ctxs).toHaveLength(2);
    const titles = withVaultContexts(brief, ctxs).standingOrders.map((o) => o.title);
    expect(titles).toEqual(['Project vault standing orders', 'Organization vault standing orders']);
  });
});

describe('policy: both vaults of a builder are read-only folders', () => {
  it('readable, never writable, secret files denied in each', () => {
    const base = tmp('aom-vaults-');
    const dirs = ['vault-org', 'vault-prj'].map((id) => {
      const root = join(base, id);
      mkdirSync(join(root, 'projects/toy'), { recursive: true });
      writeFileSync(join(root, 'standing-orders.md'), 'rules\n');
      writeFileSync(join(root, '.env'), 'SECRET=1\n');
      writeFileSync(join(root, 'projects/toy/server.pem'), 'x\n');
      return root;
    });
    const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
    const s = buildShiftSettings(
      (builder as NonNullable<typeof builder>).permissions,
      policyCtx({ readDirs: dirs }),
      POLICY_PATHS,
      'builder',
    );
    const fs = s.sandbox?.filesystem;
    for (const d of dirs) {
      expect(s.permissions.additionalDirectories).toContain(d);
      expect(s.permissions.deny).toContain(`Edit(//${d.slice(1)}/**)`);
      expect(s.permissions.deny).toContain(`Read(//${d.slice(1)}/**/.env)`);
      expect(s.permissions.deny).toContain(`Read(//${d.slice(1)}/**/*.pem)`);
      expect(fs?.denyWrite).toContain(d);
      expect(fs?.allowWrite).not.toContain(d);
      expect(fs?.allowRead).toContain(join(d, 'standing-orders.md'));
    }
    expect(fs?.allowRead.some((p) => p.endsWith('.env') || p.endsWith('.pem'))).toBe(false);
  });
});

describe('shiftVaultsOf: which vaults a shift reads', () => {
  it('card: every named vault; an older message falls back to its single vault', () => {
    expect(shiftVaultsOf({ kind: 'card', vault: PRJ, vaults: [PRJ, ORG] })).toEqual([PRJ, ORG]);
    expect(shiftVaultsOf({ kind: 'card', vault: ORG })).toEqual([ORG]);
    expect(shiftVaultsOf({ kind: 'card', vault: null })).toEqual([]);
  });
  it('question, BA task and CEO keep their single vault, even if a list is present; devops reads none', () => {
    for (const kind of ['question', 'ba_task', 'ceo'])
      expect(shiftVaultsOf({ kind, vault: PRJ, vaults: [PRJ, ORG] })).toEqual([PRJ]);
    expect(shiftVaultsOf({ kind: 'devops', vault: PRJ })).toEqual([]);
  });
});

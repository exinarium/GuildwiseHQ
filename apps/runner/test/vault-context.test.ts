import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyManagedSection, renderTasteSeedSection, TASTE_HEADER } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { readVaultContext } from '../src/vaults/context.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

describe('readVaultContext: the managed taste section', () => {
  it('strips the site-managed block from taste.md so the rules are not shown twice', async () => {
    const vaults = tmp();
    const root = join(vaults, 'v1');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'projects', 'toy'), { recursive: true });
    const withBlock = applyManagedSection(
      `${TASTE_HEADER}- Prefer articles like "x" (rated useful).\n`,
      TASTE_HEADER,
      'seed',
      3,
      renderTasteSeedSection([{ text: 'Skip beginner tutorials', interestId: null }]),
    ).text;
    writeFileSync(join(root, 'projects', 'toy', 'taste.md'), withBlock);
    const ctx = await readVaultContext(vaults, { vaultId: 'v1', folder: 'projects/toy' } as never);
    expect(ctx?.taste).toContain('Prefer articles like "x"');
    expect(ctx?.taste).not.toContain('aom:section');
    expect(ctx?.taste).not.toContain('Skip beginner tutorials');
  });
});

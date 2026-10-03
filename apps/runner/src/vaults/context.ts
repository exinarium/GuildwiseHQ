import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ShiftBrief, ShiftVault } from '@aom/shared';

export interface VaultShiftContext {
  /** The one directory passed to the runtime as `--add-dir`. */
  addDir: string;
  standingOrders: Array<{ title: string; body: string }>;
  projectDoc?: string;
}

const read = async (file: string): Promise<string | undefined> => {
  if (!existsSync(file)) return undefined;
  const text = (await readFile(file, 'utf8')).trim();
  return text || undefined;
};

/**
 * What a card shift may see of the knowledge vault (docs/ARCHITECTURE.md section 16.1): only the clone of the vault
 * the server named for this card (its domain vault or its project vault). Reads `standing-orders.md`,
 * `<folder>/standing-orders.md` and `<folder>/PROJECT.md`. No clone yet: no vault context.
 */
export async function readVaultContext(
  vaultsDir: string,
  vault: ShiftVault,
): Promise<VaultShiftContext | null> {
  const root = join(vaultsDir, vault.vaultId);
  if (!existsSync(join(root, '.git'))) return null;
  const orders: Array<{ title: string; body: string }> = [];
  const global = await read(join(root, 'standing-orders.md'));
  if (global) orders.push({ title: 'Vault standing orders', body: global });
  const project = await read(join(root, ...vault.folder.split('/'), 'standing-orders.md'));
  if (project) orders.push({ title: 'Project standing orders (vault)', body: project });
  const projectDoc = await read(join(root, ...vault.folder.split('/'), 'PROJECT.md'));
  return { addDir: root, standingOrders: orders, ...(projectDoc ? { projectDoc } : {}) };
}

/** Merges vault content into the brief the instructions are rendered from. */
export function withVaultContext(brief: ShiftBrief, ctx: VaultShiftContext | null): ShiftBrief {
  if (!ctx) return brief;
  return {
    ...brief,
    project: { ...brief.project, ...(ctx.projectDoc ? { projectDoc: ctx.projectDoc } : {}) },
    standingOrders: [...ctx.standingOrders, ...brief.standingOrders],
  };
}

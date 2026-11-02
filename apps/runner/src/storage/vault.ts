import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeVaultPath, STORAGE_MAX_CLASH, storageClashName } from '@aom/shared';
import { writeVaultBinary } from '../vaults/write.ts';
import { existsSync } from 'node:fs';
import { fromNodeError } from './errors.ts';
import { PROBE_BODY, PROBE_NAME, type Spooled, type StorageConnector, StorageError, type StorageTarget } from './types.ts';

export interface VaultAccess {
  /** Runs `fn` with the vault's folder while no sync of that vault runs. Throws when the vault is not here. */
  exclusive<T>(vaultId: string, fn: (dir: string) => Promise<T>): Promise<T>;
  isLocal(vaultId: string): boolean;
  /** Pushes a committed change; a failure must not fail the write. */
  push?(vaultId: string): Promise<void>;
}

/** A folder inside a knowledge vault, written through the vault's own clone and commit path. */
export class VaultConnector implements StorageConnector {
  constructor(
    private readonly vaults: VaultAccess,
    private readonly vaultId: string,
    private readonly folder: string,
  ) {
    if (folder && !isSafeVaultPath(folder)) throw new StorageError('invalid', 'The vault folder is not allowed.');
  }

  private rel(parts: string[]): string {
    return [this.folder, ...parts].filter(Boolean).join('/');
  }

  private async withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    try {
      return await this.vaults.exclusive(this.vaultId, fn);
    } catch (err) {
      if (err instanceof StorageError) throw err;
      if (/not configured|not here/i.test(String((err as Error)?.message)))
        throw new StorageError('not_found', 'The vault is not set up on this workstation.');
      throw fromNodeError(err);
    }
  }

  async probe(): Promise<void> {
    await this.withDir(async (dir) => {
      const rel = this.rel([PROBE_NAME()]);
      if (!isSafeVaultPath(rel)) throw new StorageError('invalid', 'The vault folder is not allowed.');
      await writeVaultBinary(dir, { path: rel, commitMessage: 'probe' }, Buffer.from(PROBE_BODY), { commit: false });
      await rm(join(dir, ...rel.split('/')), { force: true });
    });
  }

  async put(target: StorageTarget, file: Spooled): Promise<{ path: string }> {
    const path = await this.withDir(async (dir) => {
      const bytes = await readFile(file.file);
      for (let n = 1; n <= STORAGE_MAX_CLASH; n++) {
        const name = n === 1 ? target.name : storageClashName(target.name, n);
        const rel = this.rel([...target.folder, name]);
        if (!isSafeVaultPath(rel)) throw new StorageError('invalid', 'The destination path is not allowed.');
        if (existsSync(join(dir, ...rel.split('/')))) continue;
        await writeVaultBinary(dir, { path: rel, commitMessage: `Add ${name}` }, bytes, {
          commit: !this.vaults.isLocal(this.vaultId),
        });
        return rel;
      }
      throw new StorageError('conflict', 'Too many files with the same name.');
    });
    // The file is committed; a failed push syncs later.
    await this.vaults.push?.(this.vaultId).catch(() => undefined);
    return { path };
  }

  async delete(path: string): Promise<void> {
    await this.withDir(async (dir) => {
      if (!isSafeVaultPath(path)) return;
      await rm(join(dir, ...path.split('/')), { force: true });
    });
  }
}
void mkdir;
void writeFile;

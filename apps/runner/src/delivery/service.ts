import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  DELIVERY_DIR,
  findSecret,
  type IpcRpcResponse,
  RECIPE_FILE,
  type RecipeInspectPayload,
  type RecipeInspectResult,
} from '@aom/shared';
import { type Logger, nullLogger } from '../log.ts';
import type { DeliveryFile } from '../vaults/delivery.ts';
import {
  BundleError,
  headCommit,
  inspectBundle,
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_FILES,
  readBundleAtCommit,
  readBundleFromDir,
} from './bundle.ts';

export interface DeliveryVaults {
  exclusive<T>(vaultId: string, fn: (dir: string) => Promise<T>): Promise<T>;
  saveDelivery(cmd: { vaultId: string; folder: string; files: DeliveryFile[]; message: string }): Promise<{
    changed: boolean;
    committed: boolean;
    commit: string | null;
    pushed: boolean;
    paused: boolean;
  }>;
}

/** `recipe.inspect` and `aom recipe save` (docs/design/ceo-front-door.md 9.4 and 10): the workstation reads and writes the vault. */
export class DeliveryService {
  private readonly log: Logger;
  constructor(
    private readonly deps: {
      vaults: DeliveryVaults;
      rpc: (shiftId: string, method: string, params: Record<string, unknown>) => Promise<IpcRpcResponse>;
      log?: Logger;
    },
  ) {
    this.log = deps.log ?? nullLogger;
  }

  /** What `<folder>/delivery/` of the project vault holds, with its content hash. Never throws: a failure is an answer. */
  async inspect(p: RecipeInspectPayload): Promise<RecipeInspectResult> {
    try {
      return await this.deps.vaults.exclusive(p.vault.vaultId, async (dir) => {
        if (p.vault.storage === 'local')
          return inspectBundle(
            readBundleFromDir(join(dir, ...p.vault.folder.split('/'), DELIVERY_DIR)),
            null,
          );
        const commit = p.commit ?? (await headCommit(dir));
        if (!commit)
          return inspectBundle({ files: [], hash: readBundleFromDir(join(dir, '.aom-none')).hash }, null);
        return inspectBundle(await readBundleAtCommit(dir, p.vault.folder, commit), commit);
      });
    } catch (err) {
      this.log.warn(`recipe.inspect failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        ok: false,
        error: (err instanceof BundleError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
        ).slice(0, 400),
      };
    }
  }

  /** Reads a scratch folder into files, refusing symlinks, secrets and oversize. */
  private readScratch(dir: string): { files: DeliveryFile[] } | { error: string } {
    if (!isAbsolute(dir)) return { error: '--dir must be an absolute path' };
    let root: string;
    try {
      root = realpathSync(dir);
    } catch {
      return { error: `${dir} does not exist` };
    }
    const files: DeliveryFile[] = [];
    let total = 0;
    let problem: string | null = null;
    const walk = (abs: string, rel: string): void => {
      for (const name of readdirSync(abs).sort()) {
        if (name === '.git' || problem) continue;
        const p = join(abs, name);
        const r = rel ? `${rel}/${name}` : name;
        const st = lstatSync(p);
        if (st.isSymbolicLink()) {
          problem = `${r} is a symlink: a recipe holds plain files only`;
          return;
        }
        if (st.isDirectory()) walk(p, r);
        else if (st.isFile()) {
          const content = readFileSync(p);
          total += content.length;
          if (files.length >= MAX_BUNDLE_FILES || total > MAX_BUNDLE_BYTES) {
            problem = 'the recipe folder is too big';
            return;
          }
          if (!content.subarray(0, 4096).includes(0)) {
            const secret = findSecret(content.toString('utf8'));
            if (secret) {
              problem = `${r} contains ${secret}: a recipe names its secrets and never holds them (set the value on the workstation)`;
              return;
            }
          }
          files.push({ path: r, mode: st.mode & 0o111 ? '755' : '644', content });
        }
      }
    };
    walk(root, '');
    if (problem) return { error: problem };
    if (!files.some((f) => f.path === RECIPE_FILE)) return { error: `the folder has no ${RECIPE_FILE}` };
    return { files };
  }

  /**
   * `aom recipe save --dir <scratch> --project KEY` from DevOps: the server names the project vault, the workstation writes
   * the files into `<folder>/delivery/` (a git vault: one commit, pushed), then reads the result back and reports its hash.
   */
  async save(shiftId: string, params: Record<string, unknown>): Promise<IpcRpcResponse> {
    const project = String(params.project ?? '').trim();
    const dir = String(params.dir ?? '').trim();
    if (!project || !dir)
      return { ok: false, error: 'usage: aom recipe save --dir <scratch folder> --project KEY' };
    const begin = await this.deps.rpc(shiftId, 'recipe.save', { phase: 'begin', project });
    if (!begin.ok) return begin;
    const info = begin.result as { vault: { vaultId: string; storage: 'git' | 'local'; folder: string } };
    const read = this.readScratch(dir);
    if ('error' in read) return { ok: false, error: read.error };
    let saved: Awaited<ReturnType<DeliveryVaults['saveDelivery']>>;
    try {
      saved = await this.deps.vaults.saveDelivery({
        vaultId: info.vault.vaultId,
        folder: info.vault.folder,
        files: read.files,
        message: `delivery recipe for ${project.toUpperCase()} (saved by DevOps)`,
      });
    } catch (err) {
      return {
        ok: false,
        error:
          `could not write the recipe into the vault: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            400,
          ),
      };
    }
    const inspected = await this.inspect({
      projectId: String((begin.result as { projectId?: string }).projectId ?? ''),
      vault: info.vault,
      ...(saved.commit ? { commit: saved.commit } : {}),
    } as RecipeInspectPayload);
    const done = await this.deps.rpc(shiftId, 'recipe.save', { phase: 'done', project, inspected });
    if (!done.ok) return done;
    return {
      ok: true,
      result: {
        ...(done.result as Record<string, unknown>),
        committed: saved.committed,
        pushed: saved.pushed,
        vaultCommit: saved.commit,
        message: saved.paused
          ? 'Saved in the vault clone, but syncing is paused by a conflict: the recipe is not pushed yet.'
          : 'Saved into the project vault. The Owner approves this exact version with a button.',
      },
    };
  }
}

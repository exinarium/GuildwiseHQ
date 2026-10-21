import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  type BundleEntry,
  bundleHash,
  DELIVERY_DIR,
  DeployProbeParamsSchema,
  findSecret,
  type IpcRpcResponse,
  isSafeVaultPath,
  RECIPE_FILE,
  type RecipeInspectPayload,
  type RecipeInspectResult,
  type RecipeWritePayload,
  type RecipeWriteResult,
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
import type { DeployKeys } from './deploy-keys.ts';
import { runDeployProbe } from './probe.ts';

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
      keys?: DeployKeys;
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

  /**
   * `recipe.write` (guided deploy setup): replaces `<folder>/delivery/` with the generated files (and the `keep` files of the
   * current folder) in one commit and reports what is there now. Refuses a path outside `delivery/`, a file the secret scan
   * flags, files that do not hash to what the preview showed, and a kept file that is not there. Never throws.
   */
  async write(p: RecipeWritePayload): Promise<RecipeWriteResult> {
    const fail = (error: string): RecipeWriteResult => ({ ok: false, error: error.slice(0, 480) });
    try {
      const seen = new Set<string>();
      const entries: BundleEntry[] = [];
      let total = 0;
      for (const f of p.files) {
        if (
          f.path.startsWith('/') ||
          f.path.includes('\\') ||
          f.path.split('/').some((x) => x === '' || x === '.' || x === '..')
        )
          return fail(`refusing the path ${f.path}: files go inside delivery/`);
        if (!isSafeVaultPath(`${p.vault.folder}/${DELIVERY_DIR}/${f.path}`))
          return fail(`refusing the path ${f.path}`);
        if (seen.has(f.path)) return fail(`${f.path} is listed twice`);
        seen.add(f.path);
        const secret = findSecret(f.content);
        if (secret)
          return fail(`${f.path} contains ${secret}: a recipe names its secrets and never holds them`);
        total += Buffer.byteLength(f.content);
        entries.push({
          path: f.path,
          mode: f.mode,
          sha256: createHash('sha256').update(f.content).digest('hex'),
        });
      }
      if (total > MAX_BUNDLE_BYTES) return fail('the generated files are too big');
      if (bundleHash(entries) !== p.expectedHash)
        return fail('the files do not match what you previewed: preview again');
      const files: DeliveryFile[] = p.files.map((f) => ({
        path: f.path,
        mode: f.mode,
        content: Buffer.from(f.content, 'utf8'),
      }));
      // files of the current folder that stay as they are (hand-written scripts)
      if (p.keep.length) {
        const current = await this.deps.vaults.exclusive(p.vault.vaultId, async (dir) =>
          p.vault.storage === 'local'
            ? readBundleFromDir(join(dir, ...p.vault.folder.split('/'), DELIVERY_DIR))
            : readBundleAtCommit(dir, p.vault.folder, (await headCommit(dir)) ?? 'HEAD'),
        );
        for (const k of p.keep) {
          if (seen.has(k)) continue;
          const found = current.files.find((f) => f.path === k);
          if (!found)
            return fail(
              `the hand-written script ${k} is not in delivery/ any more: switch that environment back to guided`,
            );
          files.push({ path: found.path, mode: found.mode, content: found.content });
          seen.add(k);
        }
      }
      const saved = await this.deps.vaults.saveDelivery({
        vaultId: p.vault.vaultId,
        folder: p.vault.folder,
        files,
        message: p.commitMessage,
      });
      const inspected = await this.inspect({
        projectId: p.projectId,
        vault: p.vault,
        ...(saved.commit ? { commit: saved.commit } : {}),
      });
      return {
        ok: true,
        committed: saved.committed,
        pushed: saved.pushed,
        vaultCommit: saved.commit,
        inspected,
      };
    } catch (err) {
      this.log.warn(`recipe.write failed: ${err instanceof Error ? err.message : String(err)}`);
      return fail(
        `could not write the recipe into the vault: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** `aom deploy probe` (DevOps in a scan): the same fixed probe, answered here and returned as JSON. */
  async probeFor(
    params: Record<string, unknown>,
    shiftId?: string,
    targets: Array<{ name: string; host: string | null }> = [],
  ): Promise<IpcRpcResponse> {
    const p = DeployProbeParamsSchema.safeParse(params);
    if (!p.success)
      return {
        ok: false,
        error:
          'usage: aom deploy probe --local | --ssh-hosts | --target <name> [--compose-file F] [--dir D] [--url U]',
      };
    const v = p.data;
    // A scan may look at its project's own servers only, never at any alias that happens to be in ~/.ssh/config.
    if (v.target) {
      const t = targets.find((x) => x.name.toLowerCase() === v.target?.toLowerCase());
      if (!t) return { ok: false, error: `there is no deploy target called ${v.target} in this project` };
      if (!t.host) return { ok: false, error: `${t.name} runs on a computer, not on a server: use --local` };
      v.host = t.host;
    } else if (v.host && !targets.some((t) => t.host === v.host)) {
      return {
        ok: false,
        error: `${v.host} is not the server of one of this project's deploy targets: use --target <name>`,
      };
    }
    const scope = v.host ? 'ssh_target' : v.sshHosts ? 'ssh_hosts' : 'local';
    const r = await runDeployProbe(
      {
        projectId: '00000000-0000-4000-8000-000000000000',
        scope,
        ...(v.host ? { host: v.host } : {}),
        hints: {
          ...(v.composeFile ? { composeFiles: v.composeFile } : {}),
          ...(v.dir ? { dirs: v.dir } : {}),
          ...(v.url ? { urls: v.url } : {}),
        },
      },
      this.deps.keys ? { keys: this.deps.keys } : {},
    );
    // The server keeps what the scan saw (the wizard shows the same facts); a failure to tell it changes nothing for DevOps.
    if (shiftId)
      void this.deps
        .rpc(shiftId, 'deploy.probe.record', { scope, ...(v.host ? { host: v.host } : {}), result: r })
        .catch(() => undefined);
    return { ok: true, result: r };
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

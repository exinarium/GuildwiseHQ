import { join } from 'node:path';
import { type GraphIndexPayload, type GraphIndexResult, isSafeVaultFolder } from '@aom/shared';
import { type Logger, nullLogger } from '../log.ts';
import type { RunnerPaths } from '../paths.ts';
import type { VaultManager } from '../vaults/manager.ts';
import { GraphIndexError, indexRepository } from './indexer.ts';

export interface GraphServiceDeps {
  paths: RunnerPaths;
  vaults: VaultManager;
  /** The local clone of a repository by its normalized remote URL. */
  findRepo: (remoteUrlNormalized: string) => Promise<{ localPath: string } | undefined>;
  /** `RUNNER_VERSION`: stamped into the manifest. */
  version: string;
  log?: Logger;
  now?: () => Date;
}

/**
 * The runner's side of the project graph (docs/design/project-graphs.md sections 5 to 7). `index` answers the server's
 * `graph.index` and `graph.update` commands: it reads the clone at a commit, writes the graph into the project vault, and
 * tells the server only counts and a commit (never anything derived from code).
 */
export class GraphService {
  private readonly log: Logger;

  constructor(private readonly deps: GraphServiceDeps) {
    this.log = deps.log ?? nullLogger;
  }

  /** The `graph/` directory of a project inside its vault folder. */
  graphDir(vaultDir: string, folder: string): string {
    return join(vaultDir, ...folder.split('/'), 'graph');
  }

  get cacheDir(): string {
    return this.deps.paths.graphCache;
  }

  async index(payload: GraphIndexPayload): Promise<GraphIndexResult> {
    const { vaults } = this.deps;
    if (!isSafeVaultFolder(payload.vault.folder)) return { ok: false, reason: 'no_vault' };
    const repo = await this.deps.findRepo(payload.remoteUrlNormalized);
    if (!repo) return { ok: false, reason: 'no_clone' };
    const v = vaults.vault(payload.vault.vaultId);
    if (!v) return { ok: false, reason: 'no_vault' };
    try {
      const out = await vaults.exclusive(payload.vault.vaultId, (dir) =>
        indexRepository({
          repoPath: repo.localPath,
          repoKey: payload.repoKey,
          repoName: payload.repoName,
          ref: payload.workingBranch,
          graphDir: this.graphDir(dir, payload.vault.folder),
          cacheDir: this.cacheDir,
          indexerVersion: this.deps.version,
          ...(this.deps.now ? { now: this.deps.now } : {}),
        }),
      );
      // the vault's own sync commits and pushes what changed (a repository vault); a local folder has nothing to sync
      if (v.storage !== 'local' && out.written + out.deleted > 0) void vaults.syncNow(payload.vault.vaultId);
      this.log.info(
        `graph indexed ${payload.repoName}: ${out.files} files, ${out.nodes} nodes, ${out.edges} edges in ${out.durationMs} ms (${out.written} written, ${out.unchanged} unchanged)`,
      );
      if (out.parseFailures > 0) this.log.warn(`graph: the parser failed on ${out.parseFailures} files: ${out.firstParseFailure}`);
      return {
        ok: true,
        commit: out.commit,
        files: out.files,
        nodes: out.nodes,
        edges: out.edges,
        modules: out.modules,
        indexerVersion: this.deps.version,
        durationMs: out.durationMs,
      };
    } catch (err) {
      if (err instanceof GraphIndexError) return { ok: false, reason: err.code };
      // the message may name a path: it stays in the runner's log and never reaches the server
      this.log.warn(`graph index of ${payload.repoName} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, reason: 'error' };
    }
  }
}

import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type GraphIndexPayload,
  type GraphIndexResult,
  type GraphScope,
  type IpcRpcResponse,
  isSafeVaultFolder,
} from '@aom/shared';
import { type Logger, nullLogger } from '../log.ts';
import type { RunnerPaths } from '../paths.ts';
import type { VaultManager } from '../vaults/manager.ts';
import { briefQueryText, cardHints, graphBriefSection } from './brief.ts';
import { GraphIndexError, indexRepository } from './indexer.ts';
import { loadGraph } from './load.ts';
import { GraphIndex } from './query.ts';
import { manifestPath } from './store.ts';

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
/** The most an `aom graph query` may be asked to return, whatever `--budget` says. */
const MAX_BUDGET_TOKENS = 6000;

export class GraphService {
  private readonly log: Logger;
  private readonly loaded = new Map<string, { key: string; index: GraphIndex }>();

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
      if (out.parseFailures > 0)
        this.log.warn(`graph: the parser failed on ${out.parseFailures} files: ${out.firstParseFailure}`);
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
      this.log.warn(
        `graph index of ${payload.repoName} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, reason: 'error' };
    }
  }

  // ------------------------------------------------------------------------------------------------ queries

  /**
   * The loaded graph of a project, from the vault's shards (docs/design/project-graphs.md section 7). Loaded again only when
   * the manifest changed. Null when nothing is indexed here (no clone of the vault on this workstation, or no index yet).
   */
  load(scope: GraphScope): GraphIndex | null {
    if (!isSafeVaultFolder(scope.folder) || !this.deps.vaults.vault(scope.vaultId)) return null;
    const dir = this.graphDir(this.deps.vaults.dir(scope.vaultId), scope.folder);
    let key: string;
    try {
      const st = statSync(manifestPath(dir));
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
    const have = this.loaded.get(dir);
    if (have?.key === key) return have.index;
    const g = loadGraph(dir, this.cacheDir);
    if (!g) return null;
    const index = new GraphIndex(g);
    this.loaded.set(dir, { key, index });
    return index;
  }

  /** `aom graph query|path|explain|impact`: answered here, from memory, never by the server. */
  rpc(method: string, params: Record<string, unknown>, scope: GraphScope | undefined): IpcRpcResponse {
    if (!scope || scope.arm === 'off')
      return { ok: false, error: 'the code graph is not available for this work' };
    const index = this.load(scope);
    if (!index)
      return {
        ok: false,
        error:
          'the code graph is not available on this workstation yet (it is built where the project vault is kept)',
      };
    const str = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : '');
    const num = (k: string, d: number) =>
      typeof params[k] === 'number' && Number.isFinite(params[k]) ? (params[k] as number) : d;
    let text: string;
    switch (method) {
      case 'graph.query': {
        if (!str('text').trim())
          return { ok: false, error: 'usage: aom graph query "<words>" [--budget <tokens>]' };
        const budget = Math.max(200, Math.min(MAX_BUDGET_TOKENS, num('budget', 1500)));
        text = index.query(str('text'), { budget }).text;
        break;
      }
      case 'graph.path':
        if (!str('a') || !str('b')) return { ok: false, error: 'usage: aom graph path <a> <b>' };
        text = index.path(str('a'), str('b'));
        break;
      case 'graph.explain':
        if (!str('node')) return { ok: false, error: 'usage: aom graph explain <node>' };
        text = index.explain(str('node'));
        break;
      case 'graph.impact':
        if (!str('node')) return { ok: false, error: 'usage: aom graph impact <file or symbol> [--depth 2]' };
        text = index.impact(str('node'), num('depth', 2));
        break;
      default:
        return { ok: false, error: `${method} is not a graph verb` };
    }
    return { ok: true, result: { text } };
  }

  /** The "Graph context" section of a shift's instructions (at most 1.5 KB), or null: off, nothing indexed, or nothing known. */
  briefSection(
    scope: GraphScope | undefined,
    card: { title: string; fields: Record<string, unknown> },
  ): string | null {
    if (scope?.arm !== 'on') return null;
    const index = this.load(scope);
    if (!index) return null;
    return graphBriefSection(index, {
      title: card.title,
      affectedAreas: typeof card.fields.affectedAreas === 'string' ? card.fields.affectedAreas : undefined,
      hints: cardHints(card.fields),
    });
  }
}

export { briefQueryText };

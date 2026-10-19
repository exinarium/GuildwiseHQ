import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type GraphIndexPayload,
  type GraphIndexResult,
  type GraphOrgPayload,
  type GraphOrgResult,
  type GraphScope,
  type IpcRpcResponse,
  isSafeVaultFolder,
  type OrgGraphScope,
} from '@aom/shared';
import { type Logger, nullLogger } from '../log.ts';
import type { RunnerPaths } from '../paths.ts';
import type { VaultManager } from '../vaults/manager.ts';
import { briefQueryText, cardHints, graphBriefSection } from './brief.ts';
import { GraphIndexError, indexRepository } from './indexer.ts';
import { loadGraph } from './load.ts';
import {
  assembleOrgGraph,
  describeDrafts,
  type OrgProject,
  readOrgGraph,
  routeRequest,
  writeOrgGraph,
} from './org.ts';
import { GraphIndex } from './query.ts';
import { fenceUntrusted } from './sanitize.ts';
import { manifestPath } from './store.ts';
import { updateRepository } from './update.ts';

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

  /** `graph.index`: a full index of one repository into the project vault. */
  index(payload: GraphIndexPayload): Promise<GraphIndexResult> {
    return this.execute(payload, false);
  }

  /**
   * `graph.update`: the graph of one repository brought to a merge commit (section 6 of the design). Without a target
   * commit it is a full index.
   */
  update(payload: GraphIndexPayload): Promise<GraphIndexResult> {
    return this.execute(payload, !!payload.toCommit);
  }

  private async execute(payload: GraphIndexPayload, isUpdate: boolean): Promise<GraphIndexResult> {
    const { vaults } = this.deps;
    if (!isSafeVaultFolder(payload.vault.folder)) return { ok: false, reason: 'no_vault' };
    const repo = await this.deps.findRepo(payload.remoteUrlNormalized);
    if (!repo) return { ok: false, reason: 'no_clone' };
    const v = vaults.vault(payload.vault.vaultId);
    if (!v) return { ok: false, reason: 'no_vault' };
    this.remember(payload);
    try {
      const base = {
        repoPath: repo.localPath,
        repoKey: payload.repoKey,
        repoName: payload.repoName,
        ref: payload.workingBranch,
        cacheDir: this.cacheDir,
        indexerVersion: this.deps.version,
        ...(this.deps.now ? { now: this.deps.now } : {}),
      };
      const out = await vaults.exclusive(payload.vault.vaultId, async (dir) => {
        const graphDir = this.graphDir(dir, payload.vault.folder);
        if (!isUpdate || !payload.toCommit)
          return { ...(await indexRepository({ ...base, graphDir })), update: undefined };
        const u = await updateRepository({
          ...base,
          graphDir,
          toCommit: payload.toCommit,
          ...(payload.merge
            ? {
                work: { ref: payload.merge.ref, title: payload.merge.title, at: payload.merge.at, paths: [] },
              }
            : {}),
        });
        return {
          ...u,
          update: { fromCommit: u.fromCommit, filesChanged: u.filesChanged, fullReindex: u.fullReindex },
        };
      });
      // the vault's own sync commits and pushes what changed (a repository vault); a local folder has nothing to sync
      if (v.storage !== 'local' && out.written + out.deleted > 0) void vaults.syncNow(payload.vault.vaultId);
      this.log.info(
        `graph ${isUpdate ? 'updated' : 'indexed'} ${payload.repoName}: ${out.files} files, ${out.nodes} nodes, ${out.edges} edges in ${out.durationMs} ms (${out.written} written, ${out.unchanged} unchanged)`,
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
        ...(out.update
          ? {
              ...(out.update.fromCommit ? { fromCommit: out.update.fromCommit } : {}),
              filesChanged: out.update.filesChanged,
              fullReindex: out.update.fullReindex,
            }
          : {}),
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

  // ------------------------------------------------------------------------------------------- regeneration

  private get jobsFile(): string {
    return join(this.cacheDir, 'jobs.json');
  }

  /** The last index request per repository, kept so a graph the vault sync had to discard can be rebuilt without the server. */
  private remember(payload: GraphIndexPayload): void {
    try {
      const jobs = this.readJobs();
      jobs[`${payload.vault.vaultId}|${payload.vault.folder}|${payload.repoKey}`] = {
        ...payload,
        fromCommit: undefined,
        toCommit: undefined,
        merge: undefined,
      };
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(this.jobsFile, JSON.stringify(jobs));
    } catch {
      // regeneration then waits for the server's next request
    }
  }

  private readJobs(): Record<string, GraphIndexPayload> {
    try {
      return existsSync(this.jobsFile)
        ? (JSON.parse(readFileSync(this.jobsFile, 'utf8')) as Record<string, GraphIndexPayload>)
        : {};
    } catch {
      return {};
    }
  }

  /**
   * A sync of the vault resolved a conflict in generated graph files by itself (design section 4: they are never a desk
   * item): the graph of that folder is rebuilt from the clones, and the next sync commits the result.
   */
  async regenerate(vaultId: string, folders: string[]): Promise<number> {
    let n = 0;
    for (const job of Object.values(this.readJobs())) {
      if (job.vault.vaultId !== vaultId || !folders.includes(job.vault.folder)) continue;
      const r = await this.index(job);
      if (r.ok) n++;
    }
    return n;
  }

  // ---------------------------------------------------------------------------------- the organization graph

  /**
   * `graph.org`: builds the organization graph from the project graphs this workstation can read and writes it to
   * `org/graph/` of the organization vault (docs/design/project-graphs.md section 8). The answer to the server is counts.
   */
  async buildOrg(payload: GraphOrgPayload): Promise<GraphOrgResult> {
    const { vaults } = this.deps;
    const v = vaults.vault(payload.vault.vaultId);
    if (!v) return { ok: false, reason: 'no_vault' };
    try {
      const projects: OrgProject[] = payload.projects.map((p) => ({
        projectId: p.projectId,
        key: p.key,
        name: p.name,
        retired: p.retired,
        graph: p.graph
          ? (this.load({ vaultId: p.graph.vaultId, folder: p.graph.folder, arm: 'on' })?.g ?? null)
          : null,
      }));
      const g = assembleOrgGraph(projects, payload.assertions);
      const wr = await vaults.exclusive(payload.vault.vaultId, async (dir) =>
        writeOrgGraph(dir, g, this.deps.version),
      );
      if (v.storage !== 'local' && wr.written + wr.deleted > 0) void vaults.syncNow(payload.vault.vaultId);
      this.log.info(
        `organization graph: ${projects.length} projects (${projects.filter((p) => p.graph).length} with a graph), ${g.derived.length} derived links, ${wr.written} files written`,
      );
      return {
        ok: true,
        projects: projects.length,
        withGraph: projects.filter((p) => p.graph).length,
        drafts: g.derived.filter((d) => d.status === 'draft').length,
        links: g.derived.length + g.assertions.length,
      };
    } catch (err) {
      this.log.warn(`organization graph failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, reason: 'error' };
    }
  }

  /**
   * `aom ceo route "<request>"`: the projects and areas a request belongs to, from `org/graph/` of the organization vault
   * on this workstation. Read-only; null when the graph is not here.
   */
  route(scope: OrgGraphScope | undefined, request: string, opts: { drafts?: boolean } = {}): string | null {
    if (!scope || !this.deps.vaults.vault(scope.vaultId)) return null;
    const data = readOrgGraph(this.deps.vaults.dir(scope.vaultId));
    if (!data) return null;
    return fenceUntrusted(
      'organization graph',
      opts.drafts ? describeDrafts(data) : routeRequest(data, request),
    );
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
    // names in the answer come from the repository: data for the agent, never instructions
    return { ok: true, result: { text: fenceUntrusted('code graph', text) } };
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

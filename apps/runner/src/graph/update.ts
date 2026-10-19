import { git } from '../git/git.ts';
import { changedPaths, isAncestor } from './gitio.ts';
import { type IndexOptions, type IndexOutcome, indexRepository } from './indexer.ts';
import { readManifest } from './store.ts';
import { readWork } from './work.ts';

export interface UpdateOptions extends Omit<IndexOptions, 'commit' | 'update'> {
  /** The commit a merge produced: the graph is brought to it. */
  toCommit: string;
}

export interface UpdateOutcome extends IndexOutcome {
  /** The commit the manifest recorded before this update (absent: there was no graph). */
  fromCommit?: string;
  /** Files added, changed or removed between the two commits (all files for a full re-index). */
  filesChanged: number;
  /** The update fell back to a full index (no graph yet, a commit unknown here, or the old commit is no ancestor). */
  fullReindex: boolean;
}

/**
 * Brings a repository's graph to the commit a merge produced (docs/design/project-graphs.md section 6). The per-file facts
 * cache is keyed by blob id, so only the files that changed between the two commits are parsed again; the resolver then
 * runs over the facts of all files, which gives exactly the graph a full index of that commit would give (the changed
 * files' links into unchanged files and the unchanged files' links into changed ones included), and only the shards whose
 * bytes changed are written. A force-push or rebase (the recorded commit is not an ancestor) is a full index.
 */
export async function updateRepository(opts: UpdateOptions): Promise<UpdateOutcome> {
  const manifest = readManifest(opts.graphDir);
  const entry = manifest?.repos.find((r) => r.repoKey === opts.repoKey);
  const known = (await git(opts.repoPath, ['cat-file', '-e', `${opts.toCommit}^{commit}`])).exitCode === 0;
  // already there (the same merge reported twice): nothing to do, and it is not a merge for the communities' count
  const noted =
    !opts.work ||
    readWork(opts.graphDir, opts.repoKey).some((w) => w.ref === opts.work?.ref && w.commit === opts.toCommit);
  if (entry && known && entry.commit === opts.toCommit && noted)
    return {
      commit: entry.commit,
      files: entry.files,
      nodes: entry.nodes,
      edges: entry.edges,
      modules: entry.modules,
      parseErrors: entry.parseErrors,
      parseFailures: 0,
      written: 0,
      unchanged: 0,
      deleted: 0,
      cacheHits: 0,
      cacheMisses: 0,
      symbolsInVault: entry.symbolsInVault,
      communitiesReused: true,
      durationMs: 0,
      fromCommit: entry.commit,
      filesChanged: 0,
      fullReindex: false,
    };
  let fullReindex = !entry || !known;
  let changed: { changed: string[]; deleted: string[] } | null = null;
  if (entry && known && entry.commit !== opts.toCommit) {
    if (!(await isAncestor(opts.repoPath, entry.commit, opts.toCommit))) fullReindex = true;
    else {
      changed = await changedPaths(opts.repoPath, entry.commit, opts.toCommit);
      if (!changed) fullReindex = true;
    }
  }
  const paths = changed ? [...changed.changed, ...changed.deleted] : [];
  // the modules the merge touched: what its own commit changed against its first parent (the card's work, not the gap
  // since the last update)
  let workPaths: string[] = [];
  if (opts.work && known) {
    const own = await changedPaths(opts.repoPath, `${opts.toCommit}^`, opts.toCommit);
    workPaths = own ? [...own.changed, ...own.deleted] : paths;
  }
  const out = await indexRepository({
    ...opts,
    ...(known ? { commit: opts.toCommit } : {}),
    update: !fullReindex,
    ...(opts.work ? { work: { ...opts.work, paths: workPaths } } : {}),
  });
  return {
    ...out,
    ...(entry ? { fromCommit: entry.commit } : {}),
    filesChanged: fullReindex ? out.files : paths.length,
    fullReindex,
  };
}

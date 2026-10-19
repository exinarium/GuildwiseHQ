import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRAPH_SCHEMA_VERSION, sha256Hex } from '@aom/shared';
import { type BuildFile, buildGraph } from './build.ts';
import { FactsCache } from './cache.ts';
import { GENERATED_MARKER, isManifest, langOf, selectFiles } from './discover.ts';
import { BlobReader, listTree, looksBinary, resolveCommit } from './gitio.ts';
import { parseManifest } from './manifests.ts';
import type { Manifest as PkgManifest } from './modules.ts';
import { PARSER_PACKAGE, parseFile, parserFingerprint } from './parse.ts';
import { renderRepo } from './shards.ts';
import { type Manifest, type ManifestRepo, readManifest, renderManifest, writeFiles } from './store.ts';
import type { FileFacts } from './types.ts';

export const DEFAULT_MAX_EXPORT_NODES = 50_000;

export interface IndexOptions {
  /** The clone to read (its object store; the working tree is never touched). */
  repoPath: string;
  repoKey: string;
  repoName: string;
  /** The branch to index (the project's working branch); HEAD when it does not exist. */
  ref?: string | null | undefined;
  /** Pin the commit instead of resolving `ref` (an update to a merge commit). */
  commit?: string;
  /** The vault's `<folder>/graph` directory. */
  graphDir: string;
  /** The runner's local graph cache folder (facts cache, and the shards of a repository too big for the vault). */
  cacheDir: string;
  indexerVersion: string;
  indexedBy?: string;
  now?: () => Date;
  maxExportNodes?: number;
  /** Merges applied since the communities were recomputed (an update passes the new count). */
  mergesSinceCommunities?: number;
}

export interface IndexOutcome {
  commit: string;
  files: number;
  nodes: number;
  edges: number;
  modules: number;
  parseErrors: number;
  /** Files the parser threw on (a broken runtime or grammar shows here: every file). Runner-local diagnostics. */
  parseFailures: number;
  firstParseFailure?: string;
  written: number;
  unchanged: number;
  deleted: number;
  cacheHits: number;
  cacheMisses: number;
  symbolsInVault: boolean;
  durationMs: number;
}

/** Files of these kinds become nodes: source, markdown and the manifests the modules are built from. */
const wanted = (path: string) => langOf(path) !== null || isManifest(path);

/**
 * One full index of a repository at a commit: discover (`git ls-tree`), parse what the cache does not know, build, render,
 * and write only the shards whose bytes changed. Writes are limited to `graphDir` and `cacheDir`. A parse error in one
 * file never fails the run (the file keeps its node, its facts are what the parser could read).
 */
export async function indexRepository(opts: IndexOptions): Promise<IndexOutcome> {
  const t0 = Date.now();
  const now = opts.now ?? (() => new Date());
  const commit = opts.commit ?? (await resolveCommit(opts.repoPath, opts.ref));
  if (!commit) throw new GraphIndexError('no_commit');
  const entries = await listTree(opts.repoPath, commit);
  const { files: selected, skipped } = selectFiles(entries);
  const fingerprint = parserFingerprint();
  const cache = new FactsCache(opts.cacheDir, opts.repoKey, fingerprint);
  const reader = new BlobReader(opts.repoPath);
  const buildFiles: BuildFile[] = [];
  const pkgManifests: PkgManifest[] = [];
  let parseErrors = 0;
  let parseFailures = 0;
  let firstParseFailure: string | undefined;
  let seen = 0;
  try {
    for (const e of selected) {
      if (!wanted(e.path)) continue;
      const lang = langOf(e.path);
      if (isManifest(e.path)) {
        const blob = await reader.read(e.blob);
        if (blob && !looksBinary(blob)) {
          const m = parseManifest(e.path, blob.toString('utf8'));
          if (m) pkgManifests.push(m);
        }
        if (!lang) continue;
      }
      if (!lang) continue;
      // parsing is synchronous WASM: give the event loop (heartbeats, shifts) a turn now and then
      if (++seen % 25 === 0) await new Promise<void>((r) => setImmediate(r));
      let facts = cache.get(e.blob);
      if (!facts) {
        const blob = await reader.read(e.blob);
        const none = (skip: 'generated' | 'binary'): FileFacts => ({ lang, symbols: [], imports: [], calls: [], skip });
        if (!blob || looksBinary(blob)) {
          cache.set(e.blob, none('binary'));
          skipped.binary = (skipped.binary ?? 0) + 1;
          continue;
        }
        const text = blob.toString('utf8');
        if (lang !== 'markdown' && GENERATED_MARKER.test(text.slice(0, 600))) {
          cache.set(e.blob, none('generated'));
          skipped.generated = (skipped.generated ?? 0) + 1;
          continue;
        }
        try {
          facts = await parseFile(lang, text);
        } catch (err) {
          parseFailures++;
          firstParseFailure ??= err instanceof Error ? err.message : String(err);
          facts = { lang, symbols: [], imports: [], calls: [], parseErrors: true } satisfies FileFacts;
        }
        cache.set(e.blob, facts);
      }
      if (facts.skip) {
        skipped[facts.skip] = (skipped[facts.skip] ?? 0) + 1;
        continue;
      }
      if (facts.parseErrors) parseErrors++;
      buildFiles.push({ path: e.path, lang, facts });
    }
  } finally {
    reader.close();
  }
  cache.save();

  const built = buildGraph({ repoKey: opts.repoKey, repoName: opts.repoName, files: buildFiles, manifests: pkgManifests });
  const rendered = renderRepo(built, {
    repoKey: opts.repoKey,
    repoName: opts.repoName,
    commit,
    indexerVersion: opts.indexerVersion,
  });

  // Too big for the vault: modules, communities and the summary go there; the shards stay in the runner's own cache.
  const cap = opts.maxExportNodes ?? DEFAULT_MAX_EXPORT_NODES;
  const symbolsInVault = built.nodes.length <= cap;
  const prefix = `repos/${opts.repoKey}/`;
  const vaultFiles = new Map<string, string>();
  const localFiles = new Map<string, string>();
  for (const [rel, content] of rendered.files) {
    const keep = symbolsInVault || /\/(_repo\.jsonl|communities\.json|modules\.md)$/.test(rel);
    (keep ? vaultFiles : localFiles).set(rel, content);
  }
  const contentHash = sha256Hex([...rendered.files].map(([k, v]) => `${k}\n${sha256Hex(v)}`).join('\n')).slice(0, 16);

  const prev = readManifest(opts.graphDir);
  const prevRepo = prev?.repos.find((r) => r.repoKey === opts.repoKey);
  const unchangedRepo =
    prevRepo?.contentHash === contentHash && prevRepo.commit === commit && prev?.indexerVersion === opts.indexerVersion;
  const entry: ManifestRepo = {
    repoKey: opts.repoKey,
    name: opts.repoName,
    commit,
    files: buildFiles.length,
    nodes: rendered.nodeCount,
    edges: rendered.edgeCount,
    modules: rendered.moduleCount,
    skipped,
    parseErrors,
    contentHash,
    indexedAt: unchangedRepo && prevRepo ? prevRepo.indexedAt : now().toISOString(),
    indexedBy: unchangedRepo && prevRepo ? prevRepo.indexedBy : (opts.indexedBy ?? 'runner'),
    symbolsInVault,
    mergesSinceCommunities: opts.mergesSinceCommunities ?? 0,
  };
  const manifest: Manifest = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    indexerVersion: opts.indexerVersion,
    parser: PARSER_PACKAGE,
    repos: [...(prev?.repos.filter((r) => r.repoKey !== opts.repoKey) ?? []), entry],
    docsPass: { mode: 'off' },
  };
  vaultFiles.set('manifest.json', renderManifest(manifest));
  const wr = writeFiles(opts.graphDir, vaultFiles, prefix.replace(/\/$/, ''));
  writeCombinedSummary(opts.graphDir, manifest);
  const local = writeFiles(opts.cacheDir, new Map([...localFiles].map(([k, v]) => [`${opts.repoKey}/shards/${k}`, v])), `${opts.repoKey}/shards`);
  return {
    commit,
    files: buildFiles.length,
    nodes: rendered.nodeCount,
    edges: rendered.edgeCount,
    modules: rendered.moduleCount,
    parseErrors,
    parseFailures,
    ...(firstParseFailure ? { firstParseFailure } : {}),
    written: wr.written + local.written,
    unchanged: wr.unchanged + local.unchanged,
    deleted: wr.deleted + local.deleted,
    cacheHits: cache.hits,
    cacheMisses: cache.misses,
    symbolsInVault,
    durationMs: Date.now() - t0,
  };
}

/** `graph/modules.md` for a project with several repositories: each repository's own summary, in repo-key order. */
function writeCombinedSummary(graphDir: string, manifest: Manifest): void {
  const parts: string[] = [];
  for (const r of [...manifest.repos].sort((a, b) => (a.repoKey < b.repoKey ? -1 : 1))) {
    const f = join(graphDir, 'repos', r.repoKey, 'modules.md');
    if (existsSync(f)) parts.push(readFileSync(f, 'utf8'));
  }
  writeFiles(graphDir, new Map([['modules.md', parts.join('\n---\n\n')]]));
}

export class GraphIndexError extends Error {
  constructor(readonly code: 'no_commit' | 'no_clone' | 'no_vault' | 'vault_unavailable') {
    super(code);
  }
}

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What `graph/manifest.json` says about one repository's graph. */
export interface ManifestRepo {
  repoKey: string;
  name: string;
  commit: string;
  files: number;
  nodes: number;
  edges: number;
  modules: number;
  /** What the discovery left out, by reason (counts only, never names). */
  skipped: Record<string, number>;
  /** Files whose parse tree had errors (still indexed). */
  parseErrors: number;
  /** Hash of the rendered files: the same commit and indexer give the same hash. */
  contentHash: string;
  indexedAt: string;
  indexedBy: string;
  /** False when the repository was too big for the vault: only modules are there, the shards are runner-local. */
  symbolsInVault: boolean;
  /** Merges applied since the communities were last recomputed. */
  mergesSinceCommunities: number;
}

export interface Manifest {
  schemaVersion: number;
  indexerVersion: string;
  parser: string;
  repos: ManifestRepo[];
  docsPass: { mode: 'off' };
}

export const manifestPath = (graphDir: string) => join(graphDir, 'manifest.json');

export function readManifest(graphDir: string): Manifest | null {
  try {
    const p = manifestPath(graphDir);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8')) as Manifest;
    return j && Array.isArray(j.repos) ? j : null;
  } catch {
    return null;
  }
}

export function renderManifest(m: Manifest): string {
  const repos = [...m.repos]
    .sort((a, b) => (a.repoKey < b.repoKey ? -1 : 1))
    .map((r) => ({
      repoKey: r.repoKey,
      name: r.name,
      commit: r.commit,
      files: r.files,
      nodes: r.nodes,
      edges: r.edges,
      modules: r.modules,
      skipped: Object.fromEntries(Object.entries(r.skipped).sort(([a], [b]) => (a < b ? -1 : 1))),
      parseErrors: r.parseErrors,
      contentHash: r.contentHash,
      indexedAt: r.indexedAt,
      indexedBy: r.indexedBy,
      symbolsInVault: r.symbolsInVault,
      mergesSinceCommunities: r.mergesSinceCommunities,
    }));
  return `${JSON.stringify(
    { schemaVersion: m.schemaVersion, indexerVersion: m.indexerVersion, parser: m.parser, repos, docsPass: m.docsPass },
    null,
    1,
  )}\n`;
}

export interface WriteResult {
  written: number;
  unchanged: number;
  deleted: number;
}

function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, content);
  renameSync(`${file}.tmp`, file);
}

function listFiles(dir: string, rel = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(join(dir, e.name), r));
    else out.push(r);
  }
  return out;
}

/**
 * Writes `files` (relative to `root`) and removes the files under `prune` (a folder relative to `root`) that are no longer
 * produced. A file whose bytes are unchanged is not touched, so an unchanged commit changes nothing in the vault and the
 * vault's sync makes no commit.
 */
export function writeFiles(root: string, files: Map<string, string>, prune?: string): WriteResult {
  const r: WriteResult = { written: 0, unchanged: 0, deleted: 0 };
  for (const [rel, content] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const file = join(root, ...rel.split('/'));
    if (existsSync(file) && readFileSync(file, 'utf8') === content) {
      r.unchanged++;
      continue;
    }
    atomicWrite(file, content);
    r.written++;
  }
  if (prune) {
    for (const rel of listFiles(join(root, ...prune.split('/')), prune)) {
      if (files.has(rel)) continue;
      rmSync(join(root, ...rel.split('/')), { force: true });
      r.deleted++;
    }
  }
  return r;
}

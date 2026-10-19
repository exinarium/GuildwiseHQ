import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Manifest, readManifest } from './store.ts';
import type { Confidence, EdgeKind, EdgeSource, GEdge, GNode, NodeKind } from './types.ts';

/** A graph loaded from the vault's shards (docs/design/project-graphs.md section 4), ready for queries. */
export interface LoadedGraph {
  manifest: Manifest;
  nodes: Map<string, GNode>;
  edges: GEdge[];
  out: Map<string, GEdge[]>;
  inn: Map<string, GEdge[]>;
  /** Communities by module id. */
  communityOf: Map<string, { id: number; label: string }>;
  /** The `contains` parent of a node (derived). */
  parentOf: Map<string, string>;
  /** Byte size of the shard files that were read. */
  bytes: number;
}

const CONF: Confidence[] = ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'];

interface Raw {
  t: string;
  [k: string]: unknown;
}

function readLines(file: string): Raw[] {
  const out: Raw[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as Raw;
      if (o && typeof o.t === 'string') out.push(o);
    } catch {
      // a damaged line is skipped: the graph is derived and is rebuilt by the next index
    }
  }
  return out;
}

const full = (rk: string, id: unknown): string =>
  typeof id === 'string' ? (id.startsWith(`${rk}:`) ? id : `${rk}:${id}`) : '';

/**
 * Loads every repository of a project's graph. A repository too big for the vault has its module shards in the runner's
 * cache (`cacheDir/<repoKey>/shards`): they are read from there. Returns null when there is no manifest (nothing indexed).
 */
export function loadGraph(graphDir: string, cacheDir?: string): LoadedGraph | null {
  const manifest = readManifest(graphDir);
  if (!manifest || manifest.repos.length === 0) return null;
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const communityOf = new Map<string, { id: number; label: string }>();
  const parentOf = new Map<string, string>();
  let bytes = 0;
  for (const repo of manifest.repos) {
    const rk = repo.repoKey;
    const dirs = [join(graphDir, 'repos', rk)];
    if (!repo.symbolsInVault && cacheDir) dirs.push(join(cacheDir, rk, 'shards', 'repos', rk));
    const seenFiles = new Set<string>();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith('.jsonl') || seenFiles.has(name)) continue;
        seenFiles.add(name);
        const file = join(dir, name);
        const text = readFileSync(file, 'utf8');
        bytes += text.length;
        let shardModule: string | undefined;
        for (const line of text.split('\n')) {
          if (!line) continue;
          let o: Raw;
          try {
            o = JSON.parse(line) as Raw;
          } catch {
            continue;
          }
          if (o.t === 'h') shardModule = full(rk, o.module);
          else if (o.t === 'n') {
            const id = full(rk, o.id);
            const m = o.m ? full(rk, o.m) : shardModule;
            const n: GNode = {
              id,
              kind: o.k as NodeKind,
              name: String(o.n ?? ''),
              ...(o.s ? { sub: String(o.s) } : {}),
              ...(o.p ? { path: String(o.p) } : {}),
              ...(typeof o.l === 'number' ? { line: o.l } : {}),
              ...(typeof o.e === 'number' ? { endLine: o.e } : {}),
              ...(m ? { module: m } : {}),
              ...(o.x ? { exported: true } : {}),
              ...(o.g ? { lang: String(o.g) } : {}),
              ...(o.pk ? { pkg: String(o.pk) } : {}),
            };
            nodes.set(id, n);
          } else if (o.t === 'w') {
            // the work layer: a card that landed, and the modules its merge touched (`touches`, from git)
            const ref = String(o.ref ?? '');
            if (!ref) continue;
            const id = `${rk}:work#card:${ref}~${String(o.commit ?? '').slice(0, 7)}`;
            nodes.set(id, { id, kind: 'card', name: `${ref} ${String(o.title ?? '')}`.trim() });
            for (const dir of Array.isArray(o.mods) ? (o.mods as unknown[]) : [])
              edges.push({
                from: id,
                to: `${rk}:${String(dir)}#module:${String(dir)}`,
                kind: 'touches',
                conf: 'EXTRACTED',
                src: 'git',
              });
          } else if (o.t === 'e') {
            const c = CONF.includes(o.c as Confidence) ? (o.c as Confidence) : 'INFERRED';
            edges.push({
              from: full(rk, o.f),
              to: full(rk, o.to),
              kind: o.k as EdgeKind,
              conf: c,
              src: ((o.s as EdgeSource | undefined) ?? 'ast') as EdgeSource,
              ...(Array.isArray(o.ts) ? { targets: (o.ts as unknown[]).map((t) => full(rk, t)) } : {}),
            });
          }
        }
      }
    }
    // communities of this repository
    try {
      const f = join(graphDir, 'repos', rk, 'communities.json');
      if (existsSync(f)) {
        const j = JSON.parse(readFileSync(f, 'utf8')) as {
          communities?: Array<{ id: number; label: string; modules: string[] }>;
        };
        for (const c of j.communities ?? [])
          for (const m of c.modules) communityOf.set(m, { id: c.id, label: c.label });
      }
    } catch {
      // communities are optional
    }
  }
  // `contains` is not stored: modules hold their nodes, files hold their symbols and headings, classes their members
  const byPathFile = new Map<string, string>();
  for (const n of nodes.values())
    if ((n.kind === 'file' || n.kind === 'test' || (n.kind === 'doc' && n.sub === 'file')) && n.path)
      byPathFile.set(n.path, n.id);
  const symbolByPathName = new Map<string, string>();
  for (const n of nodes.values())
    if (n.kind === 'symbol' && n.path) symbolByPathName.set(`${n.path}\u0000${n.name}`, n.id);
  for (const n of nodes.values()) {
    if (n.kind === 'repo' || n.kind === 'module') continue;
    let parent: string | undefined;
    if (n.kind === 'symbol' && n.path) {
      const dot = n.name.lastIndexOf('.');
      if (dot > 0) parent = symbolByPathName.get(`${n.path}\u0000${n.name.slice(0, dot)}`);
      parent ??= byPathFile.get(n.path);
    } else if (n.kind === 'doc' && n.sub !== 'file' && n.path) parent = byPathFile.get(n.path);
    else if (n.module) parent = n.module;
    if (parent) parentOf.set(n.id, parent);
  }
  const repoByKey = new Map<string, string>();
  for (const n of nodes.values())
    if (n.kind === 'repo') repoByKey.set(n.id.slice(0, n.id.indexOf(':')), n.id);
  for (const n of nodes.values()) {
    if (n.kind !== 'module') continue;
    const repo = repoByKey.get(n.id.slice(0, n.id.indexOf(':')));
    if (repo) parentOf.set(n.id, repo);
  }
  const out = new Map<string, GEdge[]>();
  const inn = new Map<string, GEdge[]>();
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from))?.push(e);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to))?.push(e);
  }
  return { manifest, nodes, edges, out, inn, communityOf, parentOf, bytes };
}

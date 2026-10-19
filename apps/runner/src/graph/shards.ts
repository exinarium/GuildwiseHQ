import { sha256Hex } from '@aom/shared';
import { type BuiltGraph, moduleNodeId } from './build.ts';
import { type Community, type Link, labelCommunities, louvain } from './communities.ts';
import { moduleFileName } from './modules.ts';
import { sanitizeLabel } from './sanitize.ts';
import type { GEdge, GNode } from './types.ts';

/**
 * The files of one repository's graph in the project vault (docs/design/project-graphs.md section 4):
 *
 *   repos/<repoKey>/_repo.jsonl        the repo node and its module nodes
 *   repos/<repoKey>/<module>.jsonl     the nodes of one module and the edges that stay inside it
 *   repos/<repoKey>/_edges.jsonl       the edges between modules
 *   repos/<repoKey>/communities.json   module clusters with labels
 *   repos/<repoKey>/modules.md         a short, budgeted navigation summary (human readable)
 *
 * One JSON object per line, sorted, fixed key order, LF line endings: a one-file change touches one shard. `contains`
 * edges are not stored (the repo holds modules, a module holds the nodes whose `m` names it, a file holds the symbols
 * of its path, a class holds `Class.method`): the loader derives them.
 *
 * Ids are written without their `<repoKey>:` prefix (the folder name is the repo key); a module shard starts with a header
 * line `{"t":"h","module":"<module id>"}` and its nodes do not repeat `m`.
 *
 * Header line:     t=h module=<id without repo key>
 * Node line keys:  t=n id k=kind s=sub n=name p=path l=line e=endLine m=module x=exported(1) g=lang pk=own package name
 * Edge line keys:  t=e f=from to k=kind c=confidence s=source (omitted: ast) ts=targets (ambiguous)
 */
const strip = (rk: string, id: string): string => (id.startsWith(`${rk}:`) ? id.slice(rk.length + 1) : id);

export function nodeLine(n: GNode, rk: string, inModuleShard: boolean): string {
  const o: Record<string, unknown> = { t: 'n', id: strip(rk, n.id), k: n.kind };
  if (n.sub) o.s = n.sub;
  o.n = n.name;
  if (n.path) o.p = n.path;
  if (n.line !== undefined) o.l = n.line;
  if (n.endLine !== undefined) o.e = n.endLine;
  if (n.module && !inModuleShard) o.m = strip(rk, n.module);
  if (n.exported) o.x = 1;
  if (n.lang) o.g = n.lang;
  if (n.pkg) o.pk = n.pkg;
  return JSON.stringify(o);
}

export function edgeLine(e: GEdge, rk: string): string {
  const o: Record<string, unknown> = {
    t: 'e',
    f: strip(rk, e.from),
    to: strip(rk, e.to),
    k: e.kind,
    c: e.conf,
  };
  if (e.src !== 'ast') o.s = e.src;
  if (e.targets) o.ts = e.targets.map((t) => strip(rk, t));
  return JSON.stringify(o);
}

const lines = (rows: string[]): string => (rows.length ? `${rows.join('\n')}\n` : '');

export interface RenderedRepo {
  /** Path relative to the vault's `graph/` folder -> file content. */
  files: Map<string, string>;
  communities: Community[];
  nodeCount: number;
  edgeCount: number;
  moduleCount: number;
  communitiesReused: boolean;
}

export interface RenderMeta {
  repoKey: string;
  repoName: string;
  commit: string;
  indexerVersion: string;
}

/** Edges that are derived on load and not stored. */
const derived = (e: GEdge) => e.kind === 'contains';

/** Groups the graph into shards and renders every file of the repository's folder. Deterministic. */
export function renderRepo(g: BuiltGraph, meta: RenderMeta, reuse?: ReusedCommunities): RenderedRepo {
  const rk = meta.repoKey;
  const base = `repos/${rk}`;
  const files = new Map<string, string>();
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const shardOf = (id: string): string => {
    const n = nodeById.get(id);
    if (!n || n.kind === 'repo' || n.kind === 'module') return '_repo';
    return n.module ?? '_repo';
  };
  const fileFor = (modId: string): string => {
    if (modId === '_repo') return `${base}/_repo.jsonl`;
    const mod = nodeById.get(modId);
    return `${base}/${moduleFileName(mod?.path ?? '.', sha256Hex)}.jsonl`;
  };
  const nodeRows = new Map<string, string[]>();
  for (const n of g.nodes) {
    const shard = shardOf(n.id);
    const f = fileFor(shard);
    const l = nodeRows.get(f) ?? [];
    l.push(nodeLine(n, rk, shard !== '_repo'));
    nodeRows.set(f, l);
  }
  const cross: string[] = [];
  let edgeCount = 0;
  for (const e of g.edges) {
    if (derived(e)) continue;
    edgeCount++;
    const a = shardOf(e.from);
    const b = shardOf(e.to);
    if (a === b) {
      const f = fileFor(a);
      const l = nodeRows.get(f) ?? [];
      l.push(edgeLine(e, rk));
      nodeRows.set(f, l);
    } else cross.push(edgeLine(e, rk));
  }
  // nodes first, then edges, inside each shard: nodes were pushed first per shard only if sorted that way; enforce it
  const moduleOfFile = new Map<string, string>();
  for (const m of g.modules) moduleOfFile.set(fileFor(m.id), m.id);
  for (const [f, rows] of nodeRows) {
    const n = rows.filter((r) => r.startsWith('{"t":"n"'));
    const e = rows.filter((r) => r.startsWith('{"t":"e"'));
    const mod = moduleOfFile.get(f);
    const header = mod ? [JSON.stringify({ t: 'h', module: strip(rk, mod) })] : [];
    files.set(f, lines([...header, ...n, ...e]));
  }
  files.set(`${base}/_edges.jsonl`, lines(cross));

  // communities over the module graph: module-level weights from the edges that cross modules
  const modIds = g.modules.map((m) => m.id);
  const weights = new Map<string, number>();
  for (const e of g.edges) {
    if (derived(e) || e.kind === 'depends_on') continue;
    const a = nodeById.get(e.from)?.module;
    const b = nodeById.get(e.to)?.module;
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    weights.set(key, (weights.get(key) ?? 0) + (e.kind === 'imports' || e.kind === 'tests' ? 1 : 0.5));
  }
  for (const e of g.edges) {
    if (e.kind !== 'depends_on') continue;
    const a = e.from;
    const b = e.to;
    if (nodeById.get(a)?.kind !== 'module' || nodeById.get(b)?.kind !== 'module') continue;
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    weights.set(key, (weights.get(key) ?? 0) + 2);
  }
  const links: Link[] = [...weights.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : 1))
    .map(([k, w]) => {
      const [a, b] = k.split('\u0000') as [string, string];
      return { a, b, w };
    });
  // Clustering is global, so an update keeps the last result for a few merges (design section 6) and records its commit.
  let groups: string[][];
  let computedAt = meta.commit;
  if (reuse) {
    const known = new Set(modIds);
    const placed = new Set<string>();
    groups = reuse.groups.map((grp) => grp.filter((m) => known.has(m))).filter((grp) => grp.length > 0);
    for (const grp of groups) for (const m of grp) placed.add(m);
    const fresh = modIds.filter((m) => !placed.has(m));
    if (fresh.length) groups.push(fresh);
    computedAt = reuse.commit;
  } else groups = louvain(modIds, links, 1);
  const communities = labelCommunities(groups, links, (id) =>
    sanitizeLabel(nodeById.get(id)?.name ?? id, 60),
  );
  files.set(
    `${base}/communities.json`,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        algorithm: 'louvain',
        seed: 1,
        repoKey: rk,
        commit: computedAt,
        communities: communities.map((c) => ({ id: c.id, label: c.label, modules: c.members })),
      },
      null,
      1,
    )}\n`,
  );
  files.set(`${base}/modules.md`, renderModulesMd(g, meta, communities, nodeById));
  return {
    files,
    communities,
    nodeCount: g.nodes.length,
    edgeCount,
    moduleCount: g.modules.length,
    communitiesReused: !!reuse,
  };
}

/** The communities of the last full computation, kept by an update that does not recompute them. */
export interface ReusedCommunities {
  /** Commit the communities were computed at. */
  commit: string;
  /** Module ids (with their repo key) by group, in group order. */
  groups: string[][];
}

/** The budgeted navigation summary: modules by size, their entry points, the busiest symbols, the surprising edges. */
export function renderModulesMd(
  g: BuiltGraph,
  meta: RenderMeta,
  communities: Community[],
  nodeById: Map<string, GNode>,
): string {
  const commOf = new Map<string, number>();
  for (const c of communities) for (const m of c.members) commOf.set(m, c.id);
  const perModule = new Map<
    string,
    { files: number; symbols: number; entry: string[]; docs: number; tests: number }
  >();
  for (const m of g.modules) perModule.set(m.id, { files: 0, symbols: 0, entry: [], docs: 0, tests: 0 });
  for (const n of g.nodes) {
    const pm = n.module ? perModule.get(n.module) : undefined;
    if (!pm) continue;
    if (n.kind === 'file') {
      pm.files++;
      if (/^(index|main|program|app|server|cli|__main__|mod)\.[a-z]+$/i.test(n.name) && pm.entry.length < 3)
        pm.entry.push(n.path ?? n.name);
    } else if (n.kind === 'symbol') pm.symbols++;
    else if (n.kind === 'test') pm.tests++;
    else if (n.kind === 'doc' && n.sub === 'file') pm.docs++;
  }
  const degree = new Map<string, number>();
  for (const e of g.edges) {
    if (e.kind === 'contains') continue;
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
  }
  const mods = g.modules
    .map((m) => ({ m, pm: perModule.get(m.id) as NonNullable<ReturnType<typeof perModule.get>> }))
    .sort(
      (a, b) =>
        b.pm.files + b.pm.symbols / 10 - (a.pm.files + a.pm.symbols / 10) || (a.m.dir < b.m.dir ? -1 : 1),
    );
  const out: string[] = [];
  out.push(`# Code map: ${sanitizeLabel(meta.repoName, 80)}`);
  out.push('');
  out.push(
    `Generated by the Guildwise indexer ${meta.indexerVersion} at commit \`${meta.commit.slice(0, 12)}\` (repo key \`${meta.repoKey}\`). ` +
      `${g.nodes.length} nodes, ${g.modules.length} modules. This file is derived: it is rebuilt from the code, do not edit it.`,
  );
  out.push('');
  out.push('## Modules');
  out.push('');
  out.push('| Module | Files | Symbols | Group | Entry points |');
  out.push('|---|---:|---:|---:|---|');
  for (const { m, pm } of mods.slice(0, 40))
    out.push(
      `| \`${m.dir === '.' ? '(root)' : m.dir}\` | ${pm.files} | ${pm.symbols} | ${commOf.get(m.id) ?? '-'} | ${pm.entry.map((e) => `\`${e}\``).join(', ')} |`,
    );
  if (mods.length > 40) out.push('', `(${mods.length - 40} smaller modules not listed)`);
  if (communities.length > 1) {
    out.push('', '## Groups of modules', '');
    for (const c of communities.slice(0, 12))
      out.push(`- **${c.id}. ${c.label}**: ${c.members.length} modules`);
  }
  const gods = [...nodeById.values()]
    .filter((n) => n.kind === 'symbol' && (degree.get(n.id) ?? 0) > 0)
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1))
    .slice(0, 12);
  if (gods.length) {
    out.push('', '## Most connected symbols', '');
    for (const n of gods)
      out.push(`- \`${n.name}\` (${n.sub}) in \`${n.path}:${n.line}\`, ${degree.get(n.id)} links`);
  }
  const surprising: string[] = [];
  for (const e of g.edges) {
    if (e.kind !== 'imports' && e.kind !== 'calls') continue;
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    if (!a?.module || !b?.module || a.module === b.module) continue;
    if (commOf.get(a.module) === commOf.get(b.module)) continue;
    if (surprising.length < 8)
      surprising.push(`- \`${a.path ?? a.name}\` -> \`${b.path ?? b.name}\` (${e.kind}, ${e.conf})`);
  }
  if (surprising.length) out.push('', '## Links between groups', '', ...surprising);
  out.push('');
  return `${out.join('\n')}`;
}

export const moduleIdFor = moduleNodeId;

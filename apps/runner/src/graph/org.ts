import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRAPH_SCHEMA_VERSION, type OrgLinkAssertion, sha256Hex } from '@aom/shared';
import type { LoadedGraph } from './load.ts';
import { terms } from './query.ts';
import { sanitizeLabel } from './sanitize.ts';
import { writeFiles } from './store.ts';

/**
 * The organization graph (docs/design/project-graphs.md section 8): which projects exist, what areas and packages each has,
 * and how they relate. It is built on the workstation that holds the organization vault, from the project graphs it can
 * read, and written to `org/graph/` of that vault. **Links derived from code stay here** (they are code-derived): the server
 * only knows the links the Owner asserted (project ids and names they typed). Derived links are drafts: shown to the Owner
 * by the CEO in chat, and used for routing only once the Owner has accepted them (as an assertion between the two projects).
 */

export interface OrgProject {
  projectId: string;
  key: string;
  name: string;
  /** Archived or deleted: never routed to. */
  retired: boolean;
  /** The project's own graph, when this workstation can read it. */
  graph: LoadedGraph | null;
}

export interface OrgModule {
  projectId: string;
  repoKey: string;
  /** The module directory (`apps/web`). */
  dir: string;
  /** The module's own package name (`@acme/web`), when its manifest names one. */
  pkg?: string;
  /** The group the project graph put it in. */
  group?: string;
}

export interface DerivedLink {
  from: string;
  to: string;
  kind: 'depends_on' | 'touches';
  conf: 'EXTRACTED' | 'INFERRED';
  /** What the code says, in words (module names and package names only), at most three. */
  evidence: string[];
  /** `accepted`: the Owner asserted a link between these two projects, so the draft counts. */
  status: 'draft' | 'accepted';
}

export interface OrgGraph {
  projects: OrgProject[];
  modules: OrgModule[];
  derived: DerivedLink[];
  assertions: OrgLinkAssertion[];
}

/** Area names too common to say anything about two projects being related. */
const GENERIC_AREAS = new Set(
  'src lib app apps packages package test tests spec specs docs doc scripts script tools tool common shared utils util core base api web server client config configs build dist assets static public types models model services service internal cmd pkg main root e2e examples example demo mocks fixtures'.split(
    ' ',
  ),
);

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function modulesOf(p: OrgProject): OrgModule[] {
  const g = p.graph;
  if (!g) return [];
  const out: OrgModule[] = [];
  for (const n of g.nodes.values()) {
    if (n.kind !== 'module') continue;
    const repoKey = n.id.slice(0, n.id.indexOf(':'));
    const group = g.communityOf.get(n.id)?.label;
    out.push({
      projectId: p.projectId,
      repoKey,
      dir: n.path ?? n.name,
      ...(n.pkg ? { pkg: n.pkg } : {}),
      ...(group ? { group } : {}),
    });
  }
  return out.sort((a, b) => cmp(a.repoKey + a.dir, b.repoKey + b.dir));
}

/** Pairs of projects the Owner linked (in either direction, any kind): their drafts count. */
function assertedPairs(assertions: OrgLinkAssertion[]): Set<string> {
  const out = new Set<string>();
  for (const a of assertions)
    if ('projectId' in a.from && 'projectId' in a.to) out.add(pairKey(a.from.projectId, a.to.projectId));
  return out;
}

/**
 * Derives the links between projects from their graphs. `depends_on` (EXTRACTED): a module of project A declares a package
 * that a module of project B is. `touches` (INFERRED): both projects have a module with the same specific name. Retired
 * projects are left out. Deterministic.
 */
export function deriveLinks(
  projects: OrgProject[],
  modules: OrgModule[],
  assertions: OrgLinkAssertion[],
): DerivedLink[] {
  const live = new Set(projects.filter((p) => !p.retired).map((p) => p.projectId));
  const accepted = assertedPairs(assertions);
  const byPkg = new Map<string, OrgModule[]>();
  for (const m of modules)
    if (m.pkg && live.has(m.projectId)) (byPkg.get(m.pkg) ?? byPkg.set(m.pkg, []).get(m.pkg))?.push(m);
  const links = new Map<string, DerivedLink>();
  const add = (
    from: string,
    to: string,
    kind: DerivedLink['kind'],
    conf: DerivedLink['conf'],
    evidence: string,
  ) => {
    const key = kind === 'touches' ? `${kind}|${pairKey(from, to)}` : `${kind}|${from}|${to}`;
    const have = links.get(key);
    if (have) {
      if (have.evidence.length < 3 && !have.evidence.includes(evidence)) have.evidence.push(evidence);
      return;
    }
    links.set(key, {
      from: kind === 'touches' && from > to ? to : from,
      to: kind === 'touches' && from > to ? from : to,
      kind,
      conf,
      evidence: [evidence],
      status: accepted.has(pairKey(from, to)) ? 'accepted' : 'draft',
    });
  };
  for (const p of projects) {
    if (!live.has(p.projectId) || !p.graph) continue;
    for (const e of p.graph.edges) {
      if (e.kind !== 'depends_on') continue;
      const target = p.graph.nodes.get(e.to);
      const source = p.graph.nodes.get(e.from);
      if (target?.kind !== 'package' || source?.kind !== 'module') continue;
      for (const other of byPkg.get(target.name) ?? []) {
        if (other.projectId === p.projectId) continue;
        add(
          p.projectId,
          other.projectId,
          'depends_on',
          'EXTRACTED',
          `${source.path ?? source.name} declares ${target.name}, which is ${other.dir}`,
        );
      }
    }
  }
  // areas of the same specific name in two projects
  const byArea = new Map<string, OrgModule[]>();
  for (const m of modules) {
    if (!live.has(m.projectId)) continue;
    const last = (m.dir.split('/').pop() ?? '').toLowerCase();
    if (last.length < 5 || GENERIC_AREAS.has(last) || !/^[a-z][a-z0-9_-]+$/.test(last)) continue;
    (byArea.get(last) ?? byArea.set(last, []).get(last))?.push(m);
  }
  for (const [area, ms] of [...byArea].sort(([a], [b]) => cmp(a, b))) {
    const projectsWith = [...new Set(ms.map((m) => m.projectId))].sort();
    if (projectsWith.length < 2 || projectsWith.length > 4) continue; // an area in many projects is a convention
    for (let i = 0; i < projectsWith.length; i++)
      for (let j = i + 1; j < projectsWith.length; j++)
        add(
          projectsWith[i] as string,
          projectsWith[j] as string,
          'touches',
          'INFERRED',
          `both have an area named ${area}`,
        );
  }
  return [...links.values()]
    .sort((a, b) => cmp(`${a.kind}${a.from}${a.to}`, `${b.kind}${b.from}${b.to}`))
    .slice(0, 400);
}

export function assembleOrgGraph(projects: OrgProject[], assertions: OrgLinkAssertion[]): OrgGraph {
  const sorted = [...projects].sort((a, b) => cmp(a.key + a.projectId, b.key + b.projectId));
  const modules = sorted.flatMap(modulesOf);
  return { projects: sorted, modules, derived: deriveLinks(sorted, modules, assertions), assertions };
}

// ------------------------------------------------------------------------------------------------------ files

const label = (s: string) => sanitizeLabel(s, 120);

/** The files of `org/graph/`: the nodes, every link (derived ones with their status), the drafts for the CEO to show. */
export function renderOrgGraph(g: OrgGraph, indexerVersion: string): Map<string, string> {
  const nameOf = new Map(g.projects.map((p) => [p.projectId, `${p.key} ${p.name}`]));
  const rows: string[] = [];
  for (const p of g.projects)
    rows.push(
      JSON.stringify({
        t: 'p',
        id: p.projectId,
        key: label(p.key),
        name: label(p.name),
        retired: p.retired,
        graph: !!p.graph,
      }),
    );
  for (const m of g.modules)
    rows.push(
      JSON.stringify({
        t: 'm',
        p: m.projectId,
        repo: m.repoKey,
        dir: label(m.dir),
        ...(m.pkg ? { pkg: label(m.pkg) } : {}),
        ...(m.group ? { group: label(m.group) } : {}),
      }),
    );
  const links: string[] = [];
  for (const d of g.derived)
    links.push(
      JSON.stringify({
        t: 'l',
        src: 'derived',
        from: d.from,
        to: d.to,
        kind: d.kind,
        conf: d.conf,
        status: d.status,
        evidence: d.evidence.map(label),
      }),
    );
  for (const a of g.assertions)
    links.push(
      JSON.stringify({
        t: 'l',
        src: 'owner',
        id: a.linkId,
        from: 'projectId' in a.from ? { project: a.from.projectId } : { name: label(a.from.name) },
        to: 'projectId' in a.to ? { project: a.to.projectId } : { name: label(a.to.name) },
        kind: a.kind,
        ...(a.note ? { note: label(a.note) } : {}),
      }),
    );
  const drafts = g.derived.filter((d) => d.status === 'draft');
  const md: string[] = [
    '# Links the code suggests',
    '',
    'Derived from the code of the projects, so they are drafts: they do not count for routing until the Owner has accepted them (a link between the two projects). Rebuilt with the organization graph, do not edit.',
    '',
  ];
  if (drafts.length === 0) md.push('No drafts.');
  for (const d of drafts)
    md.push(
      `- ${label(nameOf.get(d.from) ?? d.from)} ${d.kind === 'depends_on' ? 'depends on' : 'shares an area with'} ${label(nameOf.get(d.to) ?? d.to)} [${d.conf === 'EXTRACTED' ? 'E' : 'I'}]: ${d.evidence.map(label).join('; ')}`,
    );
  md.push('');
  const files = new Map<string, string>([
    ['org/graph/projects.jsonl', rows.length ? `${rows.join('\n')}\n` : ''],
    ['org/graph/links.jsonl', links.length ? `${links.join('\n')}\n` : ''],
    ['org/graph/drafts.md', md.join('\n')],
  ]);
  const contentHash = sha256Hex([...files].map(([k, v]) => `${k}\n${v}`).join('\n')).slice(0, 16);
  files.set(
    'org/graph/manifest.json',
    `${JSON.stringify(
      {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        indexerVersion,
        projects: g.projects.length,
        withGraph: g.projects.filter((p) => !!p.graph).length,
        modules: g.modules.length,
        derivedLinks: g.derived.length,
        drafts: drafts.length,
        assertedLinks: g.assertions.length,
        contentHash,
      },
      null,
      1,
    )}\n`,
  );
  return files;
}

/** Writes `org/graph/` into the organization vault folder; unchanged files are not touched. */
export function writeOrgGraph(vaultDir: string, g: OrgGraph, indexerVersion: string) {
  return writeFiles(vaultDir, renderOrgGraph(g, indexerVersion), 'org/graph');
}

// ---------------------------------------------------------------------------------------------------- reading

/** What routing needs, read back from `org/graph/`. */
export interface OrgRouteData {
  projects: Array<{ id: string; key: string; name: string; retired: boolean }>;
  modules: OrgModule[];
  derived: Array<DerivedLink>;
  assertions: Array<{
    from: { project?: string; name?: string };
    to: { project?: string; name?: string };
    kind: string;
    note?: string;
  }>;
}

export function readOrgGraph(vaultDir: string): OrgRouteData | null {
  const dir = join(vaultDir, 'org', 'graph');
  if (!existsSync(join(dir, 'manifest.json'))) return null;
  const out: OrgRouteData = { projects: [], modules: [], derived: [], assertions: [] };
  const lines = (f: string): Array<Record<string, unknown>> => {
    const p = join(dir, f);
    if (!existsSync(p)) return [];
    const rows: Array<Record<string, unknown>> = [];
    for (const l of readFileSync(p, 'utf8').split('\n')) {
      if (!l) continue;
      try {
        rows.push(JSON.parse(l) as Record<string, unknown>);
      } catch {
        // a damaged line is skipped; the next build rewrites the file
      }
    }
    return rows;
  };
  for (const r of lines('projects.jsonl')) {
    if (r.t === 'p')
      out.projects.push({
        id: String(r.id),
        key: String(r.key),
        name: String(r.name),
        retired: r.retired === true,
      });
    else if (r.t === 'm')
      out.modules.push({
        projectId: String(r.p),
        repoKey: String(r.repo),
        dir: String(r.dir),
        ...(r.pkg ? { pkg: String(r.pkg) } : {}),
        ...(r.group ? { group: String(r.group) } : {}),
      });
  }
  for (const r of lines('links.jsonl')) {
    if (r.src === 'derived')
      out.derived.push({
        from: String(r.from),
        to: String(r.to),
        kind: r.kind as DerivedLink['kind'],
        conf: r.conf as DerivedLink['conf'],
        status: r.status === 'accepted' ? 'accepted' : 'draft',
        evidence: Array.isArray(r.evidence) ? (r.evidence as unknown[]).map(String) : [],
      });
    else if (r.src === 'owner')
      out.assertions.push({
        from: r.from as { project?: string; name?: string },
        to: r.to as { project?: string; name?: string },
        kind: String(r.kind),
        ...(r.note ? { note: String(r.note) } : {}),
      });
  }
  return out;
}

export const ROUTE_MAX_BYTES = 800;
export const DRAFTS_MAX_BYTES = 1800;

/** The links the code suggests (drafts only), for the CEO to show the owner in chat: ends are projects, evidence is names. */
export function describeDrafts(data: OrgRouteData): string {
  const live = new Set(data.projects.filter((p) => !p.retired).map((p) => p.id));
  const name = (id: string) => {
    const p = data.projects.find((x) => x.id === id);
    return p ? `${p.key} ${p.name}` : id;
  };
  const drafts = data.derived.filter((d) => d.status === 'draft' && live.has(d.from) && live.has(d.to));
  if (drafts.length === 0) return 'The code suggests no links between projects that are not decided yet.';
  const lines = drafts.map(
    (d) =>
      `- ${name(d.from)} ${d.kind === 'depends_on' ? 'depends on' : 'shares an area with'} ${name(d.to)} [${d.conf === 'EXTRACTED' ? 'E' : 'I'}]: ${d.evidence.join('; ')}`,
  );
  const head =
    'Links the code suggests (drafts: not decided, not used for routing). [E] stated by a manifest, [I] inferred by name.';
  let out = `${head}\n${lines.join('\n')}`;
  while (Buffer.byteLength(out) > DRAFTS_MAX_BYTES && lines.length > 1) {
    lines.pop();
    out = `${head}\n${lines.join('\n')}\n(more drafts not shown)`;
  }
  return out;
}

interface Candidate {
  id: string;
  score: number;
  reasons: string[];
}

/**
 * `aom ceo route "<request>"`: the projects (and areas) a request most likely belongs to, with the reason for each, at most
 * 800 bytes. Deterministic. A retired project never appears; a draft link never counts until the Owner accepted it. The
 * CEO judges: the graph only ranks.
 */
export function routeRequest(data: OrgRouteData, request: string): string {
  const qs = [...new Set(terms(request))];
  if (qs.length === 0)
    return 'Say what the request is about (a few words), and the graph can name the projects and areas it touches.';
  const live = data.projects.filter((p) => !p.retired);
  const liveIds = new Set(live.map((p) => p.id));
  const cands = new Map<string, Candidate>(live.map((p) => [p.id, { id: p.id, score: 0, reasons: [] }]));
  const bump = (id: string, score: number, reason: string) => {
    const c = cands.get(id);
    if (!c) return;
    c.score += score;
    if (!c.reasons.includes(reason) && c.reasons.length < 4) c.reasons.push(reason);
  };
  for (const p of live) {
    const head = new Set(terms(`${p.key} ${p.name}`));
    const hit = qs.filter((t) => head.has(t));
    if (hit.length) bump(p.id, 4 * hit.length, `its name matches "${hit.join(' ')}"`);
  }
  const perProject = new Map<string, Map<string, { score: number; why: string }>>();
  for (const m of data.modules) {
    if (!liveIds.has(m.projectId)) continue;
    const mt = new Set([...terms(m.dir), ...terms(m.pkg ?? '')]);
    const hit = qs.filter((t) => mt.has(t));
    if (!hit.length) continue;
    const m2 = perProject.get(m.projectId) ?? new Map();
    m2.set(m.dir, { score: 2 * hit.length, why: `area ${m.dir} matches "${hit.join(' ')}"` });
    perProject.set(m.projectId, m2);
  }
  for (const [pid, mods] of perProject) {
    const top = [...mods.values()].sort((a, b) => b.score - a.score || (a.why < b.why ? -1 : 1)).slice(0, 2);
    for (const t of top) bump(pid, t.score, t.why);
  }
  // links the Owner asserted: a project the request names pulls in what it is linked to; a name the Owner typed that the
  // request mentions points at the projects linked to it
  const strong = new Set([...cands.values()].filter((c) => c.score >= 2).map((c) => c.id));
  for (const a of data.assertions) {
    const fromP = a.from.project;
    const toP = a.to.project;
    const names = [a.from.name, a.to.name].filter((x): x is string => !!x);
    for (const nm of names) {
      const nt = new Set(terms(nm));
      if (qs.some((t) => nt.has(t)))
        for (const pid of [fromP, toP]) if (pid) bump(pid, 3, `linked to "${nm}" (as the owner said)`);
    }
    if (fromP && toP) {
      if (strong.has(fromP)) bump(toP, 1.5, `linked to ${keyOf(data, fromP)} (as the owner said)`);
      if (strong.has(toP)) bump(fromP, 1.5, `linked to ${keyOf(data, toP)} (as the owner said)`);
    }
  }
  // links the code suggests count once the owner accepted them
  for (const d of data.derived) {
    if (d.status !== 'accepted') continue;
    if (strong.has(d.from))
      bump(
        d.to,
        1,
        `${d.kind === 'depends_on' ? `${keyOf(data, d.from)} depends on it` : 'shares an area'} (accepted)`,
      );
    if (strong.has(d.to))
      bump(
        d.from,
        1,
        `${d.kind === 'depends_on' ? 'it depends on ' + keyOf(data, d.to) : 'shares an area'} (accepted)`,
      );
  }
  const ranked = [...cands.values()]
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || (nameOf(data, a.id) < nameOf(data, b.id) ? -1 : 1))
    .slice(0, 5);
  if (ranked.length === 0)
    return 'No project or area of the organization graph matches that request. Decide from the project list, or ask the owner.';
  const lines = ranked.map((c, i) => `${i + 1}. ${nameOf(data, c.id)}: ${c.reasons.join('; ')}`);
  let out = `${lines.join('\n')}\n(a ranking, not a decision)`;
  while (Buffer.byteLength(out) > ROUTE_MAX_BYTES && lines.length > 1) {
    lines.pop();
    out = `${lines.join('\n')}\n(a ranking, not a decision; cut to fit)`;
  }
  if (Buffer.byteLength(out) > ROUTE_MAX_BYTES) out = `${out.slice(0, ROUTE_MAX_BYTES - 20)}...`;
  return out;
}

const keyOf = (d: OrgRouteData, id: string) => d.projects.find((p) => p.id === id)?.key ?? id;
const nameOf = (d: OrgRouteData, id: string) => {
  const p = d.projects.find((x) => x.id === id);
  return p ? `${p.key} ${p.name}` : id;
};

import type { LoadedGraph } from './load.ts';
import { sanitizeLabel } from './sanitize.ts';
import type { Confidence, EdgeKind, GEdge, GNode } from './types.ts';

/**
 * Queries over a loaded project graph (docs/design/project-graphs.md section 7). Everything is answered on the workstation,
 * from memory, and every answer is capped. Edge tags are part of every answer: an INFERRED or AMBIGUOUS edge is a lead, not
 * a fact, and the legend says so.
 */

export const TAG: Record<Confidence, string> = { EXTRACTED: 'E', INFERRED: 'I', AMBIGUOUS: 'A' };
export const LEGEND =
  'Tags: [E] stated by the code, [I] inferred by name (a lead: read the file before you act on it), [A] ambiguous, several targets (a lead).';

const STOP = new Set(
  'a an and are as at be by can do does for from has have how in is it its of on or our should that the their then this to was we what when where which will with without not all any new add fix make use used using card cards task tasks feature'.split(
    ' ',
  ),
);

/** Lower-case words of a name or sentence, camelCase and snake_case split, stop words and bare numbers dropped. */
export function terms(text: string): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const out: string[] = [];
  for (const w of spaced.toLowerCase().split(/[^a-z0-9]+/))
    if (w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w)) out.push(w);
  return out;
}

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

const KIND_WEIGHT: Record<string, number> = {
  symbol: 1.0,
  module: 1.1,
  file: 0.9,
  doc: 0.8,
  test: 0.6,
  package: 0.5,
};
const EDGE_PRIORITY: EdgeKind[] = [
  'calls',
  'imports',
  'extends',
  'implements',
  'tests',
  'references',
  'documents',
  'depends_on',
  'touches',
  'decided',
  'links',
];
const CONF_RANK: Record<Confidence, number> = { EXTRACTED: 0, INFERRED: 1, AMBIGUOUS: 2 };
/** A node with more links than this is shown but not expanded (a hub tells nothing about one question). */
const HUB = 40;

export interface QueryOptions {
  /** Token budget of the answer (default 1,500). */
  budget?: number;
  /** How many start nodes to take (default 8). */
  starts?: number;
  /** BFS depth from the start nodes (default 2). */
  depth?: number;
}

export class GraphIndex {
  private readonly byName = new Map<string, string[]>();
  private readonly byPathTerm = new Map<string, string[]>();
  private readonly nodeTerms = new Map<string, Set<string>>();
  private readonly children = new Map<string, string[]>();
  private readonly nbrs = new Map<string, GEdge[]>();

  constructor(readonly g: LoadedGraph) {
    for (const n of g.nodes.values()) {
      if (
        n.kind === 'repo' ||
        n.kind === 'project' ||
        n.kind === 'card' ||
        n.kind === 'decision' ||
        n.kind === 'order' ||
        n.kind === 'merge'
      )
        continue;
      const nt = new Set(terms(n.name));
      this.nodeTerms.set(n.id, nt);
      for (const t of nt) (this.byName.get(t) ?? this.byName.set(t, []).get(t))?.push(n.id);
      if (n.path)
        for (const t of new Set(terms(n.path)))
          (this.byPathTerm.get(t) ?? this.byPathTerm.set(t, []).get(t))?.push(n.id);
    }
    for (const [child, parent] of g.parentOf)
      (this.children.get(parent) ?? this.children.set(parent, []).get(parent))?.push(child);
    for (const e of g.edges) {
      (this.nbrs.get(e.from) ?? this.nbrs.set(e.from, []).get(e.from))?.push(e);
      (this.nbrs.get(e.to) ?? this.nbrs.set(e.to, []).get(e.to))?.push(e);
    }
  }

  get nodeCount(): number {
    return this.g.nodes.size;
  }

  // ------------------------------------------------------------------------------------------------ rendering

  label(n: GNode): string {
    const loc = n.path ? `${n.path}${n.line ? `:${n.line}` : ''}` : '';
    switch (n.kind) {
      case 'symbol':
        return `${n.sub ?? 'symbol'} ${n.name}${loc ? ` (${loc})` : ''}`;
      case 'file':
      case 'test':
        return `${n.kind} ${n.path ?? n.name}`;
      case 'module':
        return `module ${n.path ?? n.name}`;
      case 'doc':
        return n.sub === 'file' ? `doc ${n.path ?? n.name}` : `doc "${n.name}" (${loc})`;
      case 'package':
        return `package ${n.name}`;
      default:
        return `${n.kind} ${n.name}`;
    }
  }

  private short(n: GNode): string {
    if (n.kind === 'symbol') return n.name;
    if (n.kind === 'module') return n.path ?? n.name;
    if (n.kind === 'file' || n.kind === 'test' || (n.kind === 'doc' && n.sub === 'file'))
      return n.path ?? n.name;
    return n.name;
  }

  private edgeText(e: GEdge, from: GNode, to: GNode): string {
    const tag = TAG[e.conf];
    const extra =
      e.targets && e.targets.length > 1
        ? ` (${e.targets.length} candidates: ${e.targets
            .slice(0, 5)
            .map((t) => this.g.nodes.get(t)?.name ?? t)
            .join(', ')})`
        : '';
    return `${this.short(from)} --${e.kind}[${tag}]--> ${this.short(to)}${extra}`;
  }

  private moduleOf(n: GNode): string {
    return n.module ? (this.g.nodes.get(n.module)?.path ?? '') : '';
  }

  private group(n: GNode): string {
    const m = n.kind === 'module' ? n.id : n.module;
    const c = m ? this.g.communityOf.get(m) : undefined;
    return c ? `group ${c.id}` : '';
  }

  private edgesOf(id: string): GEdge[] {
    return (this.nbrs.get(id) ?? [])
      .filter((e) => e.kind !== 'contains')
      .sort(
        (a, b) =>
          CONF_RANK[a.conf] - CONF_RANK[b.conf] ||
          EDGE_PRIORITY.indexOf(a.kind) - EDGE_PRIORITY.indexOf(b.kind) ||
          (a.from + a.to < b.from + b.to ? -1 : 1),
      );
  }

  // --------------------------------------------------------------------------------------------------- query

  /** Start nodes for a question: term-scored over names and paths. */
  search(text: string, limit = 8): Array<{ node: GNode; score: number }> {
    const qs = [...new Set(terms(text))];
    if (qs.length === 0) return [];
    const score = new Map<string, number>();
    const hits = new Map<string, Set<string>>();
    const bump = (id: string, term: string, w: number) => {
      score.set(id, (score.get(id) ?? 0) + w);
      (hits.get(id) ?? hits.set(id, new Set()).get(id))?.add(term);
    };
    for (const t of qs) {
      for (const id of this.byName.get(t) ?? []) bump(id, t, 3);
      for (const id of this.byPathTerm.get(t) ?? []) bump(id, t, 1);
      if (t.length >= 4) {
        // a prefix of a name word ("invoic" finds "invoice"), at a lower weight
        for (const [w, ids] of this.byName)
          if (w !== t && w.startsWith(t) && ids.length < 400) for (const id of ids) bump(id, t, 1.2);
      }
    }
    const out: Array<{ node: GNode; score: number }> = [];
    for (const [id, s] of score) {
      const n = this.g.nodes.get(id) as GNode;
      const nameTerms = this.nodeTerms.get(id)?.size ?? 1;
      const covered = hits.get(id)?.size ?? 1;
      // more of the question covered beats a long name that matches one word; shorter names beat longer
      const total =
        (s * (KIND_WEIGHT[n.kind] ?? 0.7) * (1 + 0.6 * (covered - 1))) / Math.sqrt(Math.max(1, nameTerms));
      out.push({ node: n, score: total });
    }
    return out.sort((a, b) => b.score - a.score || (a.node.id < b.node.id ? -1 : 1)).slice(0, limit);
  }

  /** `aom graph query`: the start nodes for the question and a bounded breadth-first neighbourhood, under a token budget. */
  query(text: string, opts: QueryOptions = {}): { text: string; starts: number; truncated: boolean } {
    const budget = opts.budget ?? 1500;
    const starts = this.search(text, opts.starts ?? 8);
    if (starts.length === 0)
      return {
        text: 'No node of the code graph matches that question. Try other words (names of things), or read the code.',
        starts: 0,
        truncated: false,
      };
    const head = `Code graph for "${sanitizeLabel(text, 100)}". ${LEGEND}`;
    const lines: string[] = [head, 'Start nodes:'];
    let used = estimateTokens(lines.join('\n'));
    let truncated = false;
    // the start nodes come first and are the first thing the budget pays for (at least one is always shown)
    const shown: GNode[] = [];
    for (const s of starts) {
      const line = `- ${this.label(s.node)}${this.moduleOf(s.node) ? `, module ${this.moduleOf(s.node)}` : ''}`;
      const cost = estimateTokens(line) + 1;
      if (shown.length > 0 && used + cost > budget * 0.45) {
        truncated = true;
        break;
      }
      lines.push(line);
      used += cost;
      shown.push(s.node);
    }
    lines.push('Connections:');
    used += 3;
    const seenEdge = new Set<string>();
    const seen = new Set(shown.map((n) => n.id));
    const maxDepth = opts.depth ?? 2;
    let frontier = shown.map((n) => n.id);
    const body: string[] = [];
    outer: for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      // every candidate link of this ring, the strongest first, so a small budget keeps the links that are facts
      const cands: Array<{ e: GEdge; from: string }> = [];
      for (const id of frontier) {
        const edges = this.edgesOf(id);
        if (edges.length > HUB && depth > 1) continue;
        let n = 0;
        for (const e of edges) {
          if (depth > 1 && e.conf === 'AMBIGUOUS') continue;
          if (seenEdge.has(`${e.from}|${e.kind}|${e.to}`)) continue;
          cands.push({ e, from: id });
          if (++n >= 12) break;
        }
      }
      cands.sort(
        (x, y) =>
          CONF_RANK[x.e.conf] - CONF_RANK[y.e.conf] ||
          EDGE_PRIORITY.indexOf(x.e.kind) - EDGE_PRIORITY.indexOf(y.e.kind) ||
          (`${x.e.from}${x.e.to}` < `${y.e.from}${y.e.to}` ? -1 : 1),
      );
      const next: string[] = [];
      for (const { e, from } of cands) {
        const key = `${e.from}|${e.kind}|${e.to}`;
        if (seenEdge.has(key)) continue;
        const a = this.g.nodes.get(e.from);
        const b = this.g.nodes.get(e.to);
        if (!a || !b) continue;
        const line = `- ${this.edgeText(e, a, b)}${depth > 1 ? '  (2nd ring)' : ''}`;
        const cost = estimateTokens(line) + 1;
        if (used + cost > budget) {
          truncated = true;
          break outer;
        }
        seenEdge.add(key);
        body.push(line);
        used += cost;
        const other = e.from === from ? e.to : e.from;
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
      frontier = next;
    }
    if (body.length === 0) body.push('- (the start nodes have no recorded links)');
    lines.push(...body);
    if (truncated)
      lines.push(
        '(cut at the token budget: narrow the question, or use `aom graph explain <node>` on one of the nodes)',
      );
    return { text: lines.join('\n'), starts: starts.length, truncated };
  }

  // ------------------------------------------------------------------------------------------ node references

  /** A node by id, file path, `path:Name`, qualified name or plain name. Returns candidates when it is not unique. */
  resolve(ref: string): { node?: GNode; candidates: GNode[] } {
    const r = ref.trim();
    if (!r) return { candidates: [] };
    const byId = this.g.nodes.get(r);
    if (byId) return { node: byId, candidates: [byId] };
    const all = [...this.g.nodes.values()];
    const paths = all.filter(
      (n) =>
        (n.kind === 'file' || n.kind === 'test' || (n.kind === 'doc' && n.sub === 'file')) && n.path === r,
    );
    if (paths.length === 1) return { node: paths[0] as GNode, candidates: paths };
    const colon = r.lastIndexOf(':');
    if (colon > 0 && !/^\d+$/.test(r.slice(colon + 1))) {
      const p = r.slice(0, colon);
      const name = r.slice(colon + 1);
      const m = all.filter(
        (n) => n.kind === 'symbol' && n.path === p && (n.name === name || n.name.endsWith(`.${name}`)),
      );
      if (m.length === 1) return { node: m[0] as GNode, candidates: m };
      if (m.length > 1) return { candidates: m.slice(0, 8) };
    }
    const exact = all.filter(
      (n) => (n.kind === 'symbol' || n.kind === 'module') && (n.name === r || n.path === r),
    );
    if (exact.length === 1) return { node: exact[0] as GNode, candidates: exact };
    if (exact.length > 1) return { candidates: exact.slice(0, 8) };
    const lower = r.toLowerCase();
    const ci = all.filter(
      (n) =>
        n.kind === 'symbol' && (n.name.toLowerCase() === lower || n.name.toLowerCase().endsWith(`.${lower}`)),
    );
    if (ci.length === 1) return { node: ci[0] as GNode, candidates: ci };
    if (ci.length > 1) return { candidates: ci.slice(0, 8) };
    const files = all.filter((n) => (n.kind === 'file' || n.kind === 'test') && n.path?.endsWith(r));
    if (files.length === 1) return { node: files[0] as GNode, candidates: files };
    return { candidates: files.slice(0, 8) };
  }

  private pick(ref: string): { node: GNode } | { error: string } {
    const r = this.resolve(ref);
    if (r.node) return { node: r.node };
    if (r.candidates.length === 0)
      return {
        error: `No node matches "${sanitizeLabel(ref, 80)}". Use a file path, a symbol name, or \`path:Symbol\`; \`aom graph query "<words>"\` finds names.`,
      };
    return {
      error: `"${sanitizeLabel(ref, 80)}" is not unique. Say which one (use \`path:Symbol\`):\n${r.candidates.map((c) => `- ${this.label(c)}`).join('\n')}`,
    };
  }

  // -------------------------------------------------------------------------------------------------- explain

  /** `aom graph explain <node>`: the node with its place, its members and at most 40 links with tags. */
  explain(ref: string): string {
    const p = this.pick(ref);
    if ('error' in p) return p.error;
    const n = p.node;
    const lines: string[] = [
      LEGEND,
      `${this.label(n)}${n.endLine && n.endLine !== n.line ? `, lines ${n.line}-${n.endLine}` : ''}`,
    ];
    const mod = this.moduleOf(n);
    const grp = this.group(n);
    lines.push(
      `In ${mod ? `module ${mod}` : 'the repository root'}${grp ? `, ${grp}` : ''}${n.exported ? ', exported' : ''}.`,
    );
    const kids = (this.children.get(n.id) ?? [])
      .map((id) => this.g.nodes.get(id))
      .filter((x): x is GNode => !!x);
    if (kids.length) {
      const sorted = kids.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.id < b.id ? -1 : 1));
      lines.push(
        `Contains ${kids.length}: ${sorted
          .slice(0, 12)
          .map((k) => (k.kind === 'symbol' ? k.name.split('.').pop() : this.short(k)))
          .join(', ')}${kids.length > 12 ? ', ...' : ''}`,
      );
    }
    const parent = this.g.parentOf.get(n.id);
    if (parent && n.kind === 'symbol') {
      const pn = this.g.nodes.get(parent);
      if (pn) lines.push(`Part of ${this.label(pn)}.`);
    }
    const edges = this.edgesOf(n.id);
    const outE = edges.filter((e) => e.from === n.id);
    const inE = edges.filter((e) => e.to === n.id);
    const show = (title: string, list: GEdge[], cap: number) => {
      if (!list.length) return;
      lines.push(`${title} (${list.length}):`);
      for (const e of list.slice(0, cap)) {
        const a = this.g.nodes.get(e.from);
        const b = this.g.nodes.get(e.to);
        if (a && b)
          lines.push(
            `- ${this.edgeText(e, a, b)}${b.path && e.from === n.id ? `  [${b.path}${b.line ? `:${b.line}` : ''}]` : a.path && e.to === n.id ? `  [${a.path}${a.line ? `:${a.line}` : ''}]` : ''}`,
          );
      }
      if (list.length > cap) lines.push(`- ... ${list.length - cap} more`);
    };
    show('Uses', outE, 20);
    show('Used by', inE, 20);
    if (!outE.length && !inE.length)
      lines.push('No recorded links (the graph only holds what it could resolve; read the file).');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------------------------------- impact

  /** `aom graph impact <file or symbol>`: callers and callees within a depth: the blast radius, at most 60 nodes. */
  impact(ref: string, depth = 2): string {
    const p = this.pick(ref);
    if ('error' in p) return p.error;
    const root = p.node;
    const d = Math.max(1, Math.min(4, depth));
    // a file stands for its symbols, a module for its files
    const roots = new Set<string>([root.id]);
    if (root.kind === 'file' || root.kind === 'test' || root.kind === 'module')
      for (const k of this.children.get(root.id) ?? []) roots.add(k);
    if (root.kind === 'file' || root.kind === 'test')
      for (const k of [...roots]) for (const kk of this.children.get(k) ?? []) roots.add(kk);
    const INCOMING = new Set<EdgeKind>(['calls', 'imports', 'extends', 'implements', 'tests', 'references']);
    const lines: string[] = [LEGEND, `Impact of ${this.label(root)} (depth ${d}, at most 60 nodes).`];
    const walk = (dir: 'in' | 'out') => {
      const found = new Map<string, { depth: number; edge: GEdge }>();
      let frontier = [...roots];
      const visited = new Set(roots);
      for (let level = 1; level <= d; level++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const e of this.edgesOf(id)) {
            if (dir === 'in' ? e.to !== id : e.from !== id) continue;
            if (dir === 'in' && !INCOMING.has(e.kind)) continue;
            if (
              dir === 'out' &&
              e.kind !== 'calls' &&
              e.kind !== 'imports' &&
              e.kind !== 'extends' &&
              e.kind !== 'implements'
            )
              continue;
            const other = dir === 'in' ? e.from : e.to;
            if (visited.has(other)) continue;
            visited.add(other);
            found.set(other, { depth: level, edge: e });
            next.push(other);
            if (found.size >= 60) return found;
          }
        }
        frontier = next;
      }
      return found;
    };
    const section = (title: string, found: Map<string, { depth: number; edge: GEdge }>) => {
      if (found.size === 0) {
        lines.push(`${title}: none recorded.`);
        return;
      }
      lines.push(`${title} (${found.size}${found.size >= 60 ? '+' : ''}):`);
      for (const [id, f] of [...found].sort(
        (a, b) =>
          a[1].depth - b[1].depth ||
          CONF_RANK[a[1].edge.conf] - CONF_RANK[b[1].edge.conf] ||
          (a[0] < b[0] ? -1 : 1),
      )) {
        const n = this.g.nodes.get(id);
        if (n) lines.push(`- d${f.depth} ${this.label(n)} via ${f.edge.kind}[${TAG[f.edge.conf]}]`);
      }
    };
    section('Callers and importers (what a change can break)', walk('in'));
    section('Callees and imports (what it depends on)', walk('out'));
    const tests = [...walk('in')].filter(([id]) => this.g.nodes.get(id)?.kind === 'test').length;
    lines.push(tests ? `${tests} test file(s) reach it.` : 'No test file is recorded as reaching it.');
    return lines.join('\n');
  }

  // ------------------------------------------------------------------------------------------------------ path

  /** `aom graph path <a> <b>`: the shortest chain of links between two nodes, at most 20 hops, with tags. */
  path(aRef: string, bRef: string): string {
    const a = this.pick(aRef);
    if ('error' in a) return a.error;
    const b = this.pick(bRef);
    if ('error' in b) return b.error;
    if (a.node.id === b.node.id) return `${this.label(a.node)} is the same node.`;
    const prev = new Map<string, { from: string; e: GEdge | null }>();
    prev.set(a.node.id, { from: '', e: null });
    let frontier = [a.node.id];
    let found = false;
    for (let hop = 1; hop <= 20 && frontier.length && !found; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        const links: Array<{ other: string; e: GEdge | null }> = this.edgesOf(id).map((e) => ({
          other: e.from === id ? e.to : e.from,
          e,
        }));
        const parent = this.g.parentOf.get(id);
        if (parent) links.push({ other: parent, e: null });
        for (const c of this.children.get(id) ?? []) links.push({ other: c, e: null });
        if (links.length > 400) continue;
        for (const l of links) {
          if (prev.has(l.other)) continue;
          prev.set(l.other, { from: id, e: l.e });
          if (l.other === b.node.id) {
            found = true;
            break;
          }
          next.push(l.other);
        }
        if (found) break;
      }
      frontier = next;
    }
    if (!found) return `No path of up to 20 links between ${this.label(a.node)} and ${this.label(b.node)}.`;
    const chain: string[] = [];
    let cur = b.node.id;
    while (cur && cur !== a.node.id) {
      const p = prev.get(cur) as { from: string; e: GEdge | null };
      chain.push(cur);
      cur = p.from;
    }
    chain.push(a.node.id);
    chain.reverse();
    const lines = [LEGEND, `Path of ${chain.length - 1} link(s):`, `- ${this.label(a.node)}`];
    for (let i = 1; i < chain.length; i++) {
      const to = this.g.nodes.get(chain[i] as string) as GNode;
      const p = prev.get(chain[i] as string) as { from: string; e: GEdge | null };
      const arrow = !p.e
        ? '--contains--'
        : p.e.from === p.from
          ? `--${p.e.kind}[${TAG[p.e.conf]}]-->`
          : `<--${p.e.kind}[${TAG[p.e.conf]}]--`;
      lines.push(`  ${arrow}  ${this.label(to)}`);
    }
    return lines.join('\n');
  }
}

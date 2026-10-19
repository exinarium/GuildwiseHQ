import { dirname, join, normalize } from 'node:path/posix';
import { sha256Hex } from '@aom/shared';
import { isTestPath, type Lang } from './discover.ts';
import { slug } from './docs.ts';
import { type Manifest, manifestDir, moduleDirOf } from './modules.ts';
import { sanitizeLabel } from './sanitize.ts';
import type { Confidence, FileFacts, GEdge, GNode, ImportFact, SymbolFact } from './types.ts';

/** More candidates than this for one reference: no edge ("prefer no edge to a wrong edge"). */
const MAX_AMBIGUOUS = 5;
/** Targets of one import (a C# namespace or a Go package can span many files). */
const MAX_IMPORT_TARGETS = 25;
/** Call sites resolved per file: bounds the work of a pathological file (docs/design/project-graphs.md section 12). */
const MAX_CALLS_PER_FILE = 4000;

export interface BuildFile {
  path: string;
  lang: Lang;
  facts: FileFacts;
}

export interface BuildInput {
  repoKey: string;
  repoName: string;
  files: BuildFile[];
  manifests: Manifest[];
}

export interface BuiltGraph {
  nodes: GNode[];
  edges: GEdge[];
  /** Module ids with their directory. */
  modules: Array<{ id: string; dir: string; files: number }>;
  stats: { files: number; symbols: number; imports: number; calls: number; unresolvedImports: number };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const repoNodeId = (rk: string, name: string) => `${rk}:#repo:${name}`;
export const moduleNodeId = (rk: string, dir: string) => `${rk}:${dir}#module:${dir}`;
export const fileNodeId = (rk: string, path: string, test = false) =>
  `${rk}:${path}#${test ? 'test' : 'file'}:${path}`;
export const symbolNodeId = (rk: string, path: string, sub: string, qname: string) =>
  `${rk}:${path}#${sub}:${qname}`;

interface SymEntry {
  fact: SymbolFact;
  file: BuildFile;
  id: string;
}

/**
 * Builds the graph of one repository at one commit from the facts of its files. Pure and deterministic: no clock, no
 * randomness, no I/O; every collection is sorted before it is returned. Resolution rules (section 5 of the design):
 * imports resolve exactly (`EXTRACTED`), calls and inheritance resolve by name within the import set (`INFERRED`, or
 * `AMBIGUOUS` with the candidates listed); more than five candidates, or none, give no edge.
 */
export function buildGraph(input: BuildInput): BuiltGraph {
  const rk = input.repoKey;
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const manifests = [...input.manifests].sort((a, b) => cmp(a.path, b.path));
  const manifestDirs = new Set(manifests.map(manifestDir).filter((d) => d !== '.'));
  const nodes = new Map<string, GNode>();
  const edges = new Map<string, GEdge>();
  const stats = { files: files.length, symbols: 0, imports: 0, calls: 0, unresolvedImports: 0 };

  const addNode = (n: GNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };
  const addEdge = (e: GEdge) => {
    if (e.from === e.to) return;
    const key = `${e.from}\u0000${e.kind}\u0000${e.to}`;
    const have = edges.get(key);
    if (!have) edges.set(key, e);
  };

  // ------------------------------------------------------------------------------------------ repo and modules
  const repoId = repoNodeId(rk, input.repoName);
  addNode({ id: repoId, kind: 'repo', name: sanitizeLabel(input.repoName, 128) });
  const moduleOfFile = new Map<string, string>();
  const moduleFiles = new Map<string, number>();
  for (const f of files) {
    const dir = moduleDirOf(f.path, manifestDirs);
    moduleOfFile.set(f.path, dir);
    moduleFiles.set(dir, (moduleFiles.get(dir) ?? 0) + 1);
  }
  for (const m of manifests) {
    const dir = manifestDir(m);
    if (dir !== '.' && !moduleFiles.has(dir)) moduleFiles.set(dir, 0);
  }
  for (const dir of [...moduleFiles.keys()].sort(cmp)) {
    const id = moduleNodeId(rk, dir);
    const own = manifests.find((m) => manifestDir(m) === dir && m.name);
    addNode({
      id,
      kind: 'module',
      name: dir === '.' ? '(root)' : sanitizeLabel(dir, 200),
      path: dir,
      ...(own?.name ? { pkg: own.name } : {}),
    });
    addEdge({ from: repoId, to: id, kind: 'contains', conf: 'EXTRACTED', src: 'ast' });
  }

  // ------------------------------------------------------------------------------------- files, symbols, headings
  const symsByName = new Map<string, SymEntry[]>();
  const symsByFile = new Map<string, SymEntry[]>();
  const symByQname = new Map<string, SymEntry>(); // `${path}\0${qname}`
  const fileIds = new Map<string, string>();
  const namespaceFiles = new Map<string, string[]>(); // C# namespace -> file paths
  const dirFiles = new Map<string, string[]>(); // directory -> file paths
  for (const f of files) {
    const test = isTestPath(f.path) && f.lang !== 'markdown';
    const fid = fileNodeId(rk, f.path, test);
    fileIds.set(f.path, fid);
    const modDir = moduleOfFile.get(f.path) as string;
    const modId = moduleNodeId(rk, modDir);
    addNode({
      id: fid,
      kind: test ? 'test' : f.lang === 'markdown' ? 'doc' : 'file',
      ...(f.lang === 'markdown' ? { sub: 'file' } : {}),
      name: sanitizeLabel(f.path.split('/').pop() ?? f.path, 200),
      path: f.path,
      module: modId,
      lang: f.lang,
    });
    addEdge({ from: modId, to: fid, kind: 'contains', conf: 'EXTRACTED', src: 'ast' });
    const dl = dirFiles.get(dirname(f.path)) ?? [];
    dl.push(f.path);
    dirFiles.set(dirname(f.path), dl);
    for (const ns of f.facts.namespaces ?? []) {
      const l = namespaceFiles.get(ns) ?? [];
      l.push(f.path);
      namespaceFiles.set(ns, l);
    }
    if (f.lang === 'markdown') {
      // headings: a path of slugs makes the id stable; duplicates are told apart by line
      const trail: Array<{ level: number; slug: string }> = [];
      const used = new Set<string>();
      for (const h of f.facts.headings ?? []) {
        while (trail.length && (trail[trail.length - 1] as { level: number }).level >= h.level) trail.pop();
        trail.push({ level: h.level, slug: slug(h.text) });
        let q = trail.map((t) => t.slug).join('/');
        if (used.has(q)) q = `${q}~${h.line}`;
        used.add(q);
        const hid = `${rk}:${f.path}#doc:${q}`;
        addNode({
          id: hid,
          kind: 'doc',
          sub: `h${h.level}`,
          name: h.text,
          path: f.path,
          line: h.line,
          module: modId,
        });
        addEdge({ from: fid, to: hid, kind: 'contains', conf: 'EXTRACTED', src: 'doc' });
      }
      continue;
    }
    if (test) continue; // a test file is one node; its symbols and calls would only add noise
    const entries: SymEntry[] = [];
    for (const s of f.facts.symbols) {
      const id = symbolNodeId(rk, f.path, s.sub, s.qname);
      const entry: SymEntry = { fact: s, file: f, id };
      entries.push(entry);
      symByQname.set(`${f.path}\u0000${s.qname}`, entry);
      const l = symsByName.get(s.name) ?? [];
      l.push(entry);
      symsByName.set(s.name, l);
      addNode({
        id,
        kind: 'symbol',
        sub: s.sub,
        name: s.qname,
        path: f.path,
        line: s.line,
        endLine: s.endLine,
        module: modId,
        exported: s.exported,
        lang: f.lang,
      });
      stats.symbols++;
    }
    symsByFile.set(f.path, entries);
    for (const s of entries) {
      const parent = s.fact.parent ? symByQname.get(`${f.path}\u0000${s.fact.parent}`) : undefined;
      addEdge({
        from: parent ? parent.id : fid,
        to: s.id,
        kind: 'contains',
        conf: 'EXTRACTED',
        src: 'ast',
      });
    }
  }

  // ------------------------------------------------------------------------------------------------ packages
  const workspace = new Map<string, { dir: string; manifest: Manifest; entry?: string }>();
  for (const m of manifests) {
    const dir = manifestDir(m);
    const modId = moduleNodeId(rk, dir);
    if (m.kind === 'npm' && m.name) {
      const entry = npmEntry(m, byPath);
      workspace.set(m.name, { dir, manifest: m, ...(entry ? { entry } : {}) });
    }
    if (!nodes.has(modId)) continue;
    for (const d of m.deps) {
      const pid = `${rk}:${m.path}#package:${d}`;
      addNode({ id: pid, kind: 'package', name: sanitizeLabel(d, 200), path: m.path, module: modId });
      addEdge({ from: modId, to: pid, kind: 'depends_on', conf: 'EXTRACTED', src: 'ast' });
    }
  }
  // module -> module through a workspace package
  for (const m of manifests) {
    const dir = manifestDir(m);
    if (!nodes.has(moduleNodeId(rk, dir))) continue;
    for (const d of m.deps) {
      const w = workspace.get(d);
      if (w && w.dir !== dir)
        addEdge({
          from: moduleNodeId(rk, dir),
          to: moduleNodeId(rk, w.dir),
          kind: 'depends_on',
          conf: 'EXTRACTED',
          src: 'ast',
        });
    }
  }
  const goModules = manifests.filter((m) => m.kind === 'go' && m.name);

  // ---------------------------------------------------------------------------------------- import resolution
  const resolveImport = (f: BuildFile, imp: ImportFact): string[] => {
    switch (f.lang) {
      case 'typescript':
      case 'tsx':
      case 'javascript':
        return resolveJs(f.path, imp.spec, byPath, workspace, moduleOfFile);
      case 'python':
        return resolvePython(f.path, imp, byPath);
      case 'csharp':
        return (namespaceFiles.get(imp.spec) ?? [])
          .filter((p) => p !== f.path)
          .sort(cmp)
          .slice(0, MAX_IMPORT_TARGETS);
      case 'go': {
        for (const gm of goModules) {
          const mod = gm.name as string;
          if (imp.spec === mod || imp.spec.startsWith(`${mod}/`)) {
            const rel = imp.spec.slice(mod.length + 1);
            const dir = normalize(join(manifestDir(gm), rel));
            const d = dir === '.' || dir === '' ? '.' : dir.replace(/\/$/, '');
            return (dirFiles.get(d) ?? [])
              .filter((p) => p.endsWith('.go') && !p.endsWith('_test.go') && p !== f.path)
              .sort(cmp)
              .slice(0, MAX_IMPORT_TARGETS);
          }
        }
        return [];
      }
      default:
        return [];
    }
  };

  interface Visible {
    paths: Set<string>;
    alias: Map<string, string[]>; // local namespace/package/module name -> target files
    named: Map<string, { name: string; targets: string[] }>; // local binding -> imported name
  }
  const visible = new Map<string, Visible>();
  // Imports resolved once per file; a barrel file (declares nothing, only re-exports) lets a call reach what it re-exports.
  const resolved = new Map<string, Array<{ imp: ImportFact; targets: string[] }>>();
  for (const f of files) {
    if (f.lang === 'markdown') continue;
    resolved.set(
      f.path,
      f.facts.imports.map((imp) => ({ imp, targets: resolveImport(f, imp).filter((p) => byPath.has(p)) })),
    );
  }
  const throughBarrels = (targets: string[]): string[] => {
    const out = new Set(targets);
    let frontier = targets;
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next: string[] = [];
      for (const t of frontier) {
        const bf = byPath.get(t);
        if (!bf || bf.facts.symbols.length > 0) continue;
        for (const r of resolved.get(t) ?? [])
          for (const x of r.targets) if (!out.has(x)) out.add(x), next.push(x);
      }
      frontier = next;
    }
    return [...out];
  };
  for (const f of files) {
    if (f.lang === 'markdown') continue;
    const test = isTestPath(f.path);
    const v: Visible = { paths: new Set([f.path]), alias: new Map(), named: new Map() };
    const fid = fileIds.get(f.path) as string;
    const modDir = moduleOfFile.get(f.path) as string;
    const manifest = manifests.find((m) => manifestDir(m) === modDir);
    const seenTargets = new Set<string>();
    for (const { imp, targets: direct } of resolved.get(f.path) ?? []) {
      stats.imports++;
      const targets = direct;
      if (targets.length === 0) {
        // an external package the module declares: an exact edge to its package node
        const pkg = externalPackage(f.lang, imp.spec);
        if (pkg && manifest?.deps.includes(pkg)) {
          addEdge({
            from: fid,
            to: `${rk}:${manifest.path}#package:${pkg}`,
            kind: 'imports',
            conf: 'EXTRACTED',
            src: 'ast',
          });
        } else if (f.lang !== 'csharp' && f.lang !== 'go') stats.unresolvedImports++;
        continue;
      }
      for (const t of throughBarrels(targets)) v.paths.add(t);
      for (const t of targets) {
        if (seenTargets.has(t)) continue;
        seenTargets.add(t);
        const tid = fileIds.get(t) as string;
        const tTest = tid.includes('#test:');
        if (test && !tTest) addEdge({ from: fid, to: tid, kind: 'tests', conf: 'EXTRACTED', src: 'ast' });
        else addEdge({ from: fid, to: tid, kind: 'imports', conf: 'EXTRACTED', src: 'ast' });
      }
      for (const n of imp.names) {
        if (n.name === '*') {
          const local = n.alias || defaultAlias(f.lang, imp.spec);
          if (local) v.alias.set(local, throughBarrels(targets));
        } else {
          v.named.set(n.alias || n.name, { name: n.name, targets: throughBarrels(targets) });
        }
      }
    }
    if (f.lang === 'csharp')
      for (const ns of f.facts.namespaces ?? []) for (const p of namespaceFiles.get(ns) ?? []) v.paths.add(p);
    if (f.lang === 'go')
      for (const p of dirFiles.get(dirname(f.path)) ?? []) if (p.endsWith('.go')) v.paths.add(p);
    visible.set(f.path, v);
  }

  // ------------------------------------------------------------------------------------ markdown references
  for (const f of files) {
    if (f.lang !== 'markdown') continue;
    const fid = fileIds.get(f.path) as string;
    for (const l of f.facts.links ?? []) {
      const target = normalize(join(dirname(f.path), decodeURIComponent(l.target).replace(/\/$/, '')));
      const hit = byPath.get(target) ? target : undefined;
      if (hit)
        addEdge({
          from: fid,
          to: fileIds.get(hit) as string,
          kind: 'references',
          conf: 'EXTRACTED',
          src: 'doc',
        });
    }
    const dir = moduleOfFile.get(f.path) as string;
    // a README documents its own module
    if (/^readme(\.\w+)?\.md$/i.test(f.path.split('/').pop() ?? '') && dirname(f.path) === dir)
      addEdge({ from: fid, to: moduleNodeId(rk, dir), kind: 'documents', conf: 'EXTRACTED', src: 'doc' });
  }

  // --------------------------------------------------------------------------- inheritance and calls (by name)
  const classLike = new Set(['class', 'interface', 'struct', 'type']);
  const pickEdges = (from: string, cands: SymEntry[], kind: GEdge['kind']) => {
    const uniq = [...new Map(cands.map((c) => [c.id, c])).values()].sort((a, b) => cmp(a.id, b.id));
    if (uniq.length === 0 || uniq.length > MAX_AMBIGUOUS) return;
    const first = uniq[0] as SymEntry;
    if (uniq.length === 1) addEdge({ from, to: first.id, kind, conf: 'INFERRED', src: 'ast' });
    else
      addEdge({
        from,
        to: first.id,
        kind,
        conf: 'AMBIGUOUS',
        src: 'ast',
        targets: uniq.map((u) => u.id),
      });
  };
  const inV = (v: Visible, e: SymEntry) => v.paths.has(e.file.path);

  for (const f of files) {
    if (f.lang === 'markdown' || isTestPath(f.path)) continue;
    const v = visible.get(f.path) as Visible;
    const fid = fileIds.get(f.path) as string;
    const mine = symsByFile.get(f.path) ?? [];
    // inheritance
    for (const s of mine) {
      for (const [list, forced] of [
        [s.fact.extends ?? [], undefined],
        [s.fact.implements ?? [], 'implements' as const],
      ] as const) {
        for (const nm of list) {
          const bound = v.named.get(nm);
          const name = bound && bound.name !== 'default' ? bound.name : nm;
          const scope = bound ? new Set(bound.targets) : null;
          const cands = (symsByName.get(name) ?? []).filter(
            (c) => classLike.has(c.fact.sub) && c.id !== s.id && (scope ? scope.has(c.file.path) : inV(v, c)),
          );
          if (cands.length === 0) continue;
          const sample = cands[0] as SymEntry;
          const kind: GEdge['kind'] =
            forced ??
            (sample.fact.sub === 'interface' && s.fact.sub !== 'interface' ? 'implements' : 'extends');
          pickEdges(s.id, cands, kind);
        }
      }
    }
    // calls
    let n = 0;
    for (const c of f.facts.calls) {
      if (++n > MAX_CALLS_PER_FILE) break;
      stats.calls++;
      const callerSym = c.from ? symByQname.get(`${f.path}\u0000${c.from}`) : undefined;
      const from = callerSym ? callerSym.id : fid;
      let callee = c.callee;
      let scope: Set<string> | null = null;
      if (c.recv && v.alias.has(c.recv)) scope = new Set(v.alias.get(c.recv));
      else if (!c.recv) {
        const bound = v.named.get(callee);
        if (bound) {
          if (bound.name !== 'default') callee = bound.name;
          scope = new Set(bound.targets);
        }
      }
      let cands = (symsByName.get(callee) ?? []).filter((e) => (scope ? scope.has(e.file.path) : inV(v, e)));
      const callerClass =
        callerSym?.fact.parent ??
        (callerSym && classLike.has(callerSym.fact.sub) ? callerSym.fact.qname : undefined);
      const isSelf = c.recv === 'this' || c.recv === 'self' || c.recv === 'base';
      if (c.isNew)
        cands = cands.filter(
          (e) => e.fact.sub === 'class' || e.fact.sub === 'struct' || e.fact.sub === 'function',
        );
      else if (c.recv && !scope) {
        if (isSelf && callerClass) {
          const own = cands.filter((e) => e.file.path === f.path && e.fact.parent === callerClass);
          cands = own.length ? own : cands.filter((e) => e.fact.sub === 'method');
        } else {
          const typed = cands.filter((e) => e.fact.sub === 'method' && e.fact.parent === c.recv);
          cands = typed.length ? typed : cands.filter((e) => e.fact.sub === 'method');
        }
      } else if (!c.recv) {
        // a bare call: a function, or (in a class) a method of the same class first
        const own = callerClass
          ? cands.filter((e) => e.fact.sub === 'method' && e.fact.parent === callerClass)
          : [];
        cands = own.length
          ? own
          : cands.filter(
              (e) =>
                e.fact.sub === 'function' ||
                e.fact.sub === 'class' ||
                e.fact.sub === 'struct' ||
                (f.lang === 'csharp' && e.fact.sub === 'method'),
            );
      } else
        cands = cands.filter(
          (e) => e.fact.sub === 'function' || e.fact.sub === 'method' || e.fact.sub === 'class',
        );
      if (cands.length) pickEdges(from, cands, 'calls');
    }
  }

  const nodeList = [...nodes.values()].sort((a, b) => cmp(a.id, b.id));
  const edgeList = [...edges.values()].sort(
    (a, b) => cmp(a.from, b.from) || cmp(a.kind, b.kind) || cmp(a.to, b.to),
  );
  const modules = [...moduleFiles.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([dir, n]) => ({ id: moduleNodeId(rk, dir), dir, files: n }));
  return { nodes: nodeList, edges: edgeList, modules, stats };
}

// ------------------------------------------------------------------------------------------------- resolvers

const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function tryJsFile(base: string, byPath: Map<string, unknown>): string | undefined {
  const p = base.replace(/^\.\//, '');
  if (byPath.has(p)) return p;
  const stripped = p.replace(/\.(m|c)?jsx?$/, '');
  if (stripped !== p)
    for (const e of ['.ts', '.tsx', '.mts', '.cts']) if (byPath.has(stripped + e)) return stripped + e;
  for (const e of JS_EXT) if (byPath.has(p + e)) return p + e;
  for (const e of JS_EXT) if (byPath.has(`${p}/index${e}`)) return `${p}/index${e}`;
  return undefined;
}

function npmEntry(m: Manifest, byPath: Map<string, unknown>): string | undefined {
  const dir = manifestDir(m);
  const at = (rel: string) => (dir === '.' ? normalize(rel) : normalize(join(dir, rel)));
  for (const e of m.entries) {
    if (!e.startsWith('.') && !/\//.test(e) && !/\.\w+$/.test(e)) continue;
    const hit = tryJsFile(at(e), byPath);
    if (hit) return hit;
    // `dist/index.js` built from `src/index.ts`
    const src = at(e.replace(/^\.?\/?(dist|lib|build|out)\//, 'src/'));
    const sh = tryJsFile(src, byPath);
    if (sh) return sh;
  }
  for (const c of ['src/index', 'index', 'src/main', 'main']) {
    const hit = tryJsFile(at(c), byPath);
    if (hit) return hit;
  }
  return undefined;
}

function resolveJs(
  from: string,
  spec: string,
  byPath: Map<string, unknown>,
  workspace: Map<string, { dir: string; manifest: Manifest; entry?: string }>,
  moduleOfFile: Map<string, string>,
): string[] {
  if (spec.startsWith('.')) {
    const hit = tryJsFile(normalize(join(dirname(from), spec)), byPath);
    return hit ? [hit] : [];
  }
  if (/^[@~#]\//.test(spec)) {
    // the common path alias: `@/x` is `<module>/src/x`
    const mod = moduleOfFile.get(from) ?? '.';
    const rest = spec.slice(2);
    for (const base of [join(mod, 'src', rest), join(mod, rest), join('src', rest)]) {
      const hit = tryJsFile(normalize(base), byPath);
      if (hit) return [hit];
    }
    return [];
  }
  const parts = spec.split('/');
  const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
  const ws = workspace.get(pkg);
  if (!ws) return [];
  const rest = parts.slice(spec.startsWith('@') ? 2 : 1).join('/');
  if (!rest) return ws.entry ? [ws.entry] : [];
  const at = (r: string) => normalize(ws.dir === '.' ? r : join(ws.dir, r));
  for (const c of [at(join('src', rest)), at(rest)]) {
    const hit = tryJsFile(c, byPath);
    if (hit) return [hit];
  }
  return [];
}

function resolvePython(from: string, imp: ImportFact, byPath: Map<string, unknown>): string[] {
  const out: string[] = [];
  const modPath = imp.spec ? imp.spec.replace(/\./g, '/') : '';
  const roots: string[] = [];
  if (imp.dots) {
    let d = dirname(from);
    for (let i = 1; i < imp.dots; i++) d = dirname(d);
    roots.push(d === '.' ? '' : d);
  } else {
    let d = dirname(from);
    for (;;) {
      roots.push(d === '.' ? '' : d);
      if (d === '.' || d === '') break;
      d = dirname(d);
    }
    roots.push('src');
  }
  const at = (root: string, rel: string) => normalize(root ? join(root, rel) : rel);
  const module = (root: string, p: string): string | undefined => {
    if (!p) return byPath.has(at(root, '__init__.py')) ? at(root, '__init__.py') : undefined;
    for (const c of [`${p}.py`, `${p}/__init__.py`]) if (byPath.has(at(root, c))) return at(root, c);
    return undefined;
  };
  for (const root of roots) {
    const hit = module(root, modPath);
    if (hit || imp.dots) {
      if (hit) out.push(hit);
      // `from pkg import sub`: a name may be a submodule
      for (const n of imp.names) {
        if (n.name === '*') continue;
        const sub = module(root, modPath ? `${modPath}/${n.name}` : n.name);
        if (sub) out.push(sub);
      }
      if (hit || out.length) break;
    }
  }
  return [...new Set(out)].slice(0, MAX_IMPORT_TARGETS);
}

function externalPackage(lang: Lang, spec: string): string | undefined {
  if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
    if (spec.startsWith('.') || spec.startsWith('node:')) return undefined;
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  }
  if (lang === 'python') return spec.split('.')[0]?.toLowerCase();
  if (lang === 'go') return spec;
  if (lang === 'csharp') return spec;
  return undefined;
}

function defaultAlias(lang: Lang, spec: string): string {
  if (lang === 'python') return spec.split('.')[0] ?? '';
  if (lang === 'go') return spec.split('/').pop() ?? '';
  return '';
}

export const confidences: Confidence[] = ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'];
export const buildKey = (s: string): string => sha256Hex(s);

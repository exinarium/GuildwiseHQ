import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexRepository } from '../src/graph/indexer.ts';
import { type LoadedGraph, loadGraph } from '../src/graph/load.ts';
import { parseFile } from '../src/graph/parse.ts';
import type { GEdge, GNode } from '../src/graph/types.ts';
import { makeGraphRepo } from './graph-fixtures.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

async function indexed() {
  const fx = makeGraphRepo();
  const out = tmp('aom-graph-out-');
  const graphDir = join(out, 'graph');
  const r = await indexRepository({
    repoPath: fx.repo,
    repoKey: fx.repoKey,
    repoName: 'fixture',
    graphDir,
    cacheDir: join(out, 'cache'),
    indexerVersion: 'test',
    now: () => new Date('2026-10-19T10:00:00Z'),
  });
  const g = loadGraph(graphDir) as LoadedGraph;
  return { fx, r, g, graphDir };
}

const node = (g: LoadedGraph, pred: (n: GNode) => boolean): GNode => {
  const n = [...g.nodes.values()].find(pred);
  if (!n) throw new Error('node not found');
  return n;
};
const sym = (g: LoadedGraph, name: string, path?: string) =>
  node(g, (n) => n.kind === 'symbol' && n.name === name && (!path || n.path === path));
const file = (g: LoadedGraph, path: string) =>
  node(g, (n) => (n.kind === 'file' || n.kind === 'test') && n.path === path);
const edgesFrom = (g: LoadedGraph, from: GNode, kind: GEdge['kind']) =>
  (g.out.get(from.id) ?? []).filter((e) => e.kind === kind);

describe('parse: facts per language (tree-sitter WASM)', () => {
  it('TypeScript: classes, methods, heritage, imports, calls, re-exports', async () => {
    const f = await parseFile(
      'typescript',
      "import def, { a as b } from './x.js';\nimport * as ns from '../y';\nexport { z } from './z';\nconst fs = require('node:fs');\nexport abstract class Foo extends Bar implements Baz {\n  run() { this.helper(); other(); ns.thing(); new Widget(); }\n}\nexport interface Shape extends Base {}\nexport const arrow = () => bar();\nexport function top() {}\n",
    );
    expect(f.symbols.map((s) => `${s.sub}:${s.qname}:${s.exported}`).sort()).toEqual(
      [
        'class:Foo:true',
        'function:arrow:true',
        'function:top:true',
        'interface:Shape:true',
        'method:Foo.run:false',
      ].sort(),
    );
    const foo = f.symbols.find((s) => s.name === 'Foo');
    expect(foo?.extends).toEqual(['Bar']);
    expect(foo?.implements).toEqual(['Baz']);
    expect(f.imports.map((i) => i.spec)).toEqual(['./x.js', '../y', './z', 'node:fs']);
    expect(f.imports[0]?.names).toEqual([
      { name: 'default', alias: 'def' },
      { name: 'a', alias: 'b' },
    ]);
    expect(f.calls.map((c) => `${c.recv ?? ''}.${c.callee}${c.isNew ? '!' : ''}@${c.from ?? ''}`)).toEqual(
      expect.arrayContaining([
        'this.helper@Foo.run',
        '.other@Foo.run',
        'ns.thing@Foo.run',
        '.Widget!@Foo.run',
        '.bar@arrow',
      ]),
    );
  });

  it('Python: classes, methods, dotted and relative imports', async () => {
    const f = await parseFile(
      'python',
      'import os, sys as s\nimport a.b.c\nfrom . import sibling\nfrom ..pkg.mod import thing as t, other\n\nclass Foo(Base, mixins.M):\n    def method(self):\n        self.helper()\n        other()\n\ndef top():\n    return Foo()\n',
    );
    expect(f.symbols.map((s) => `${s.sub}:${s.qname}`)).toEqual([
      'class:Foo',
      'method:Foo.method',
      'function:top',
    ]);
    expect(f.symbols[0]?.extends).toEqual(['Base', 'M']);
    expect(f.imports.map((i) => `${'.'.repeat(i.dots ?? 0)}${i.spec}`)).toEqual([
      'os',
      'sys',
      'a.b.c',
      '.',
      '..pkg.mod',
    ]);
    expect(f.imports.at(-1)?.names).toEqual([{ name: 'thing', alias: 't' }, { name: 'other' }]);
  });

  it('Go: types, methods with receivers, imports with aliases', async () => {
    const f = await parseFile(
      'go',
      'package billing\n\nimport (\n\t"fmt"\n\tstr "strings"\n)\n\ntype Invoice struct{}\ntype Payer interface{ Pay() }\nfunc (i *Invoice) Total() int { return Sum() }\nfunc Make() *Invoice { fmt.Println(); return &Invoice{} }\n',
    );
    expect(f.namespaces).toEqual(['billing']);
    expect(f.symbols.map((s) => `${s.sub}:${s.qname}:${s.exported}`)).toEqual([
      'struct:Invoice:true',
      'interface:Payer:true',
      'method:Invoice.Total:true',
      'function:Make:true',
    ]);
    expect(f.imports.map((i) => `${i.spec}=${i.names[0]?.alias}`)).toEqual(['fmt=fmt', 'strings=str']);
  });

  it('C#: namespaces, types, methods, using directives', async () => {
    const f = await parseFile(
      'csharp',
      'using System;\nusing Acme.Shop.Util;\nnamespace Acme.Shop.Billing\n{\n  public interface IPayer { void Pay(); }\n  public class Invoice : BaseInvoice, IPayer\n  {\n    public void Pay() { Helper(); Util.Sum(1); var x = new Widget(); }\n    private static int Helper() => 1;\n  }\n}\n',
    );
    expect(f.namespaces).toEqual(['Acme.Shop.Billing']);
    expect(f.symbols.map((s) => `${s.sub}:${s.qname}`)).toEqual([
      'interface:IPayer',
      'method:IPayer.Pay',
      'class:Invoice',
      'method:Invoice.Pay',
      'method:Invoice.Helper',
    ]);
    expect(f.symbols.find((s) => s.name === 'Invoice')?.extends).toEqual(['BaseInvoice', 'IPayer']);
    expect(f.imports.map((i) => i.spec)).toEqual(['System', 'Acme.Shop.Util']);
    expect(f.calls.map((c) => `${c.recv ?? ''}.${c.callee}${c.isNew ? '!' : ''}`)).toEqual(
      expect.arrayContaining(['.Helper', 'Util.Sum', '.Widget!']),
    );
  });
});

describe('resolve: EXTRACTED, INFERRED and AMBIGUOUS (design section 5, step 3)', () => {
  it('an import that resolves exactly is EXTRACTED: relative with .js for .ts, a workspace package through its entry, a test through `tests`', async () => {
    const { g } = await indexed();
    const ledger = file(g, 'packages/core/src/ledger.ts');
    const toMoney = edgesFrom(g, ledger, 'imports').find(
      (e) => e.to === file(g, 'packages/core/src/money.ts').id,
    );
    expect(toMoney).toMatchObject({ conf: 'EXTRACTED', src: 'ast' });
    const main = file(g, 'apps/web/src/main.ts');
    const toCore = edgesFrom(g, main, 'imports').find(
      (e) => e.to === file(g, 'packages/core/src/index.ts').id,
    );
    expect(toCore?.conf).toBe('EXTRACTED');
    // react is declared in the module's package.json: an exact edge to its package node
    expect(
      edgesFrom(g, main, 'imports').some(
        (e) => g.nodes.get(e.to)?.kind === 'package' && g.nodes.get(e.to)?.name === 'react',
      ),
    ).toBe(true);
    const test = file(g, 'apps/web/src/main.test.ts');
    expect(edgesFrom(g, test, 'tests')[0]).toMatchObject({ to: main.id, conf: 'EXTRACTED' });
    // workspace dependency between modules
    const web = node(g, (n) => n.kind === 'module' && n.path === 'apps/web');
    const core = node(g, (n) => n.kind === 'module' && n.path === 'packages/core');
    expect(edgesFrom(g, web, 'depends_on').some((e) => e.to === core.id && e.conf === 'EXTRACTED')).toBe(
      true,
    );
  });

  it('a call resolved by name within the import set is INFERRED (a named import, this.method, a re-export through a barrel)', async () => {
    const { g } = await indexed();
    const total = sym(g, 'Ledger.total');
    const add = sym(g, 'Ledger.add');
    expect(edgesFrom(g, total, 'calls').find((e) => e.to === add.id)).toMatchObject({ conf: 'INFERRED' });
    const run = sym(g, 'run');
    // `new Ledger()` and `format()` live behind the `@fx/core` barrel (index.ts re-exports them)
    const targets = edgesFrom(g, run, 'calls').map((e) => g.nodes.get(e.to)?.name);
    expect(targets).toEqual(expect.arrayContaining(['Ledger', 'format']));
    expect(edgesFrom(g, run, 'calls').every((e) => e.conf === 'INFERRED')).toBe(true);
    // `l.total()`: a method named total reachable through the barrel
    expect(targets).toContain('Ledger.total');
  });

  it('several candidates are one AMBIGUOUS edge that lists them all; no candidate gives no edge', async () => {
    const { g } = await indexed();
    const use = sym(g, 'use');
    const calls = edgesFrom(g, use, 'calls');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.conf).toBe('AMBIGUOUS');
    expect(calls[0]?.targets?.map((t) => g.nodes.get(t)?.path).sort()).toEqual([
      'apps/web/src/dup1.ts',
      'apps/web/src/dup2.ts',
    ]);
    // `String(n)` and `fmt.Println` name nothing in the repository: no edge
    expect(edgesFrom(g, sym(g, 'format'), 'calls')).toEqual([]);
  });

  it('inheritance resolves by name: extends a class, implements an interface', async () => {
    const { g } = await indexed();
    const child = sym(g, 'Child');
    expect(edgesFrom(g, child, 'extends')[0]?.to).toBe(sym(g, 'Base').id);
    expect(edgesFrom(g, child, 'implements')[0]?.to).toBe(sym(g, 'Shape').id);
  });

  it('Python, Go and C# resolve imports and calls the same way', async () => {
    const { g } = await indexed();
    const make = sym(g, 'make');
    expect(edgesFrom(g, make, 'calls').map((e) => g.nodes.get(e.to)?.name)).toEqual(['User']);
    expect(edgesFrom(g, file(g, 'py/app/service.py'), 'imports')[0]).toMatchObject({
      to: file(g, 'py/app/models.py').id,
      conf: 'EXTRACTED',
    });
    // Go: `billing.Total()` through the import alias of a package inside the module
    const goMain = sym(g, 'main');
    expect(edgesFrom(g, goMain, 'calls').map((e) => g.nodes.get(e.to)?.name)).toEqual(['Total']);
    expect(edgesFrom(g, file(g, 'go/main.go'), 'imports')[0]?.to).toBe(file(g, 'go/billing/invoice.go').id);
    // C#: `using Acme.Util;` reaches the file that declares the namespace; `MathUtil.Sum` resolves to the static method
    expect(
      edgesFrom(g, file(g, 'cs/Shop/Billing/Invoice.cs'), 'imports').map((e) => g.nodes.get(e.to)?.path),
    ).toEqual(['cs/Shop/Util/MathUtil.cs']);
    expect(edgesFrom(g, sym(g, 'Invoice.Pay'), 'calls').map((e) => g.nodes.get(e.to)?.name)).toEqual([
      'MathUtil.Sum',
    ]);
    expect(edgesFrom(g, sym(g, 'Invoice'), 'extends')[0]?.to).toBe(sym(g, 'BaseInvoice').id);
  });

  it('markdown: headings, a link to a file of the repository, a README documents its module', async () => {
    const { g } = await indexed();
    const readme = node(g, (n) => n.kind === 'doc' && n.sub === 'file' && n.path === 'docs/README.md');
    expect(edgesFrom(g, readme, 'references')[0]).toMatchObject({
      to: file(g, 'packages/core/src/money.ts').id,
      conf: 'EXTRACTED',
      src: 'doc',
    });
    const headings = [...g.nodes.values()]
      .filter((n) => n.kind === 'doc' && n.path === 'docs/README.md' && n.sub !== 'file')
      .map((n) => n.name);
    expect(headings).toEqual(['Fixture', 'Usage']); // `# not a heading` sits in a code fence
  });

  it('nothing from vendor folders, generated files or binaries is indexed', async () => {
    const { g } = await indexed();
    const names = [...g.nodes.values()].map((n) => n.name);
    expect(names).not.toContain('vendored');
    expect(names).not.toContain('built');
    expect(names).not.toContain('generatedFn');
    expect([...g.nodes.values()].some((n) => n.path?.endsWith('.png'))).toBe(false);
  });
});

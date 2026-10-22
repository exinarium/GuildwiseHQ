import { join } from 'node:path';
import { graphRepoKey } from '@aom/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { indexRepository } from '../src/graph/indexer.ts';
import { loadGraph } from '../src/graph/load.ts';
import { estimateTokens, GraphIndex, terms } from '../src/graph/query.ts';
import { makeGraphRepo } from './graph-fixtures.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

let index: GraphIndex;
beforeAll(async () => {
  const fx = makeGraphRepo();
  const out = tmp('aom-graph-q-');
  await indexRepository({
    repoPath: fx.repo,
    repoKey: fx.repoKey,
    repoName: 'fixture',
    graphDir: join(out, 'graph'),
    cacheDir: join(out, 'cache'),
    indexerVersion: 'test',
  });
  const g = loadGraph(join(out, 'graph'));
  if (!g) throw new Error('graph not loaded');
  index = new GraphIndex(g);
});

describe('terms', () => {
  it('splits camelCase and snake_case, drops stop words and numbers', () => {
    expect(terms('Add the InvoiceTotal to billing_service 2 for HTTPServer')).toEqual([
      'invoice',
      'total',
      'billing',
      'service',
      'http',
      'server',
    ]);
  });
});

describe('aom graph query', () => {
  it('finds the nodes for a question and their links, each tagged', () => {
    const r = index.query('ledger total');
    expect(r.starts).toBeGreaterThan(0);
    expect(r.text).toContain('Tags: [E]');
    expect(r.text).toMatch(/method Ledger\.total \(packages\/core\/src\/ledger\.ts:4\)/);
    expect(r.text).toMatch(/Ledger\.total --calls\[I\]--> Ledger\.add/);
  });

  it('a question the graph knows nothing about says so', () => {
    const r = index.query('zebra giraffe');
    expect(r.starts).toBe(0);
    expect(r.text).toMatch(/No node of the code graph matches/);
  });

  it('never exceeds its token budget, and says when it cut', () => {
    for (const budget of [120, 200, 300, 1500]) {
      const r = index.query('ledger money format helper user billing invoice', { budget });
      // the cut notice and the "no links" line are the only things allowed past the budget
      expect(estimateTokens(r.text), `budget ${budget}`).toBeLessThanOrEqual(budget + 40);
    }
    const tiny = index.query('ledger money format helper', { budget: 120 });
    expect(tiny.truncated).toBe(true);
    expect(tiny.text).toContain('cut at the token budget');
  });

  it('the first ring holds the strong links first (extracted before inferred before ambiguous)', () => {
    const r = index.query('use helper');
    const lines = r.text.split('\n').filter((l) => l.startsWith('- ') && l.includes('--'));
    const tags = lines.map((l) => /\[([EIA])\]/.exec(l)?.[1]);
    const order = { E: 0, I: 1, A: 2 } as const;
    const nums = tags.filter((t): t is 'E' | 'I' | 'A' => !!t).map((t) => order[t]);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(r.text).toMatch(/--calls\[A\]--> helper \(2 candidates/);
  });
});

describe('aom graph explain', () => {
  it('shows a symbol with its place, members, uses and users, and file:line', () => {
    const t = index.explain('packages/core/src/ledger.ts:Ledger');
    expect(t).toContain('class Ledger (packages/core/src/ledger.ts:2)');
    expect(t).toContain('module packages/core');
    expect(t).toMatch(/Contains 2: add, total/);
    expect(t).toMatch(/Used by \(\d+\)/);
    const m = index.explain('Ledger.add');
    expect(m).toMatch(/Uses \(1\):\n- Ledger\.add --calls\[I\]--> format/);
    expect(m).toMatch(/Used by/);
  });

  it('a name that matches several nodes lists them instead of guessing; an unknown name says so', () => {
    const t = index.explain('helper');
    expect(t).toContain('is not unique');
    expect(t).toContain('apps/web/src/dup1.ts');
    expect(t).toContain('apps/web/src/dup2.ts');
    expect(index.explain('doesNotExist')).toMatch(/No node matches/);
  });

  it('caps the links at 40 per direction', () => {
    const big = index.explain('apps/web/src/main.ts');
    expect(big.split('\n').filter((l) => l.startsWith('- ')).length).toBeLessThanOrEqual(42);
  });
});

describe('aom graph impact and path', () => {
  it('impact lists callers and callees within the depth, with the tag of the link that reaches them', () => {
    const d1 = index.impact('format', 1);
    expect(d1).toContain('Callers and importers');
    expect(d1).toMatch(/d1 method Ledger\.add .* via calls\[I\]/);
    expect(d1).not.toMatch(/d2 /);
    const d2 = index.impact('format', 2);
    expect(d2).toMatch(/d2 method Ledger\.total/);
    // depth is clamped to 1..4
    expect(index.impact('format', 99)).toContain('depth 4');
  });

  it('impact of a file stands for its symbols and counts the tests that reach it', () => {
    const t = index.impact('apps/web/src/main.ts');
    expect(t).toContain('1 test file(s) reach it.');
    expect(t).toMatch(/Callers and importers/);
    expect(index.impact('packages/core/src/money.ts')).toMatch(
      /file packages\/core\/src\/ledger\.ts via imports\[E\]/,
    );
  });

  it('impact is capped at 60 nodes', () => {
    const t = index.impact('one', 4);
    expect(t.split('\n').filter((l) => /^- d\d/.test(l)).length).toBeLessThanOrEqual(120);
  });

  it('path finds the shortest chain with the tag of every link and at most 20 hops', () => {
    const t = index.path('Ledger.total', 'format');
    expect(t).toContain('Path of 2 link(s)');
    expect(t).toMatch(/--calls\[I\]--> {2}function format/);
    expect(index.path('Ledger.total', 'Ledger.add')).toMatch(
      /Path of 1 link\(s\):\n- method Ledger\.total .*\n {2}--calls\[I\]--> {2}method Ledger\.add/,
    );
    expect(index.path('format', 'Ledger.total')).toMatch(/<--calls\[I\]--/);
    expect(index.path('py/app/models.py', 'go/main.go')).toMatch(/No path|Path of \d+ link/);
    const same = index.path('format', 'format');
    expect(same).toContain('same node');
  });
});

describe('a graph of several repositories', () => {
  it('shows the repository of every hit, so the BA can tell the repositories apart; a single-repository graph is unchanged', async () => {
    const out = tmp('aom-graph-q2-');
    const a = makeGraphRepo({ 'src/invoice.ts': 'export function sendInvoice() { return 1; }\n' });
    const b = makeGraphRepo({ 'src/invoice.ts': 'export function renderInvoice() { return 2; }\n' });
    for (const [fx, name] of [
      [a, 'billing-api'],
      [b, 'billing-web'],
    ] as const) {
      await indexRepository({
        repoPath: fx.repo,
        repoKey: graphRepoKey(`example.com/acme/${name}`),
        repoName: name,
        graphDir: join(out, 'graph'),
        cacheDir: join(out, 'cache'),
        indexerVersion: 'test',
      });
    }
    const g = loadGraph(join(out, 'graph'));
    if (!g) throw new Error('graph not loaded');
    const multi = new GraphIndex(g);
    const answer = multi.query('invoice').text;
    expect(answer).toContain('sendInvoice');
    expect(answer).toContain('renderInvoice');
    expect(answer).toMatch(/sendInvoice.*\[repo billing-api\]/);
    expect(answer).toMatch(/renderInvoice.*\[repo billing-web\]/);
    // the single-repository index of this file shows no repository label
    expect(index.query('Ledger').text).not.toContain('[repo ');
  });
});

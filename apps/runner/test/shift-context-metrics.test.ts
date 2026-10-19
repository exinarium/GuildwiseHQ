import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeStreamParser, toolResultBytes } from '../src/adapters/claude-stream-parser.ts';
import { indexRepository } from '../src/graph/indexer.ts';
import { ContextCounter, isDiscovery } from '../src/graph/measure.ts';
import { FIXTURE_FILES, makeGraphRepo } from './graph-fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';
import { type Ctl, ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('tool results are counted by size, never kept', () => {
  it('the stream parser pairs a tool call with the bytes of its result', () => {
    const p = new ClaudeStreamParser();
    const ev1 = p.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: 'x' } }],
        },
      }),
    );
    expect(ev1).toEqual([{ kind: 'tool', name: 'Grep', summary: '{"pattern":"x"}', id: 'toolu_1' }]);
    const ev2 = p.parseLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'héllo\nworld' }] },
      }),
    );
    expect(ev2).toEqual([{ kind: 'toolresult', id: 'toolu_1', bytes: Buffer.byteLength('héllo\nworld') }]);
    // a list of text blocks, and something that is not text
    expect(
      toolResultBytes([
        { type: 'text', text: 'abc' },
        { type: 'image', source: {} },
        { type: 'text', text: 'de' },
      ]),
    ).toBe(5);
    expect(toolResultBytes(undefined)).toBe(0);
  });
});

describe('ContextCounter (design section 11)', () => {
  it('classifies the search tools and the search-like shell commands', () => {
    for (const [name, summary] of [
      ['Read', '/x/a.ts'],
      ['Grep', '{"pattern":"x"}'],
      ['Glob', '**/*.ts'],
      ['Bash', 'grep -rn "total" src'],
      ['Bash', 'rg Invoice'],
      ['Bash', 'ls -la src'],
      ['Bash', 'cat package.json'],
      ['Bash', 'git ls-files'],
      ['Bash', 'cd apps/web && find . -name "*.ts"'],
    ] as const)
      expect(isDiscovery(name, summary), `${name} ${summary}`).toBe(true);
    for (const [name, summary] of [
      ['Bash', 'npm test'],
      ['Bash', 'aom graph query "x"'],
      ['Bash', 'git commit -m x'],
      ['Write', '/x/a.ts'],
      ['Edit', '/x/a.ts'],
      ['WebFetch', 'https://x'],
    ] as const)
      expect(isDiscovery(name, summary), `${name} ${summary}`).toBe(false);
  });

  it('counts bytes and calls of discovery until the first edit, graph verbs apart, and the brief size', () => {
    const c = new ContextCounter('on');
    c.briefBytes = 1200;
    c.onTool('1', 'Read', 'a.ts');
    c.onResult('1', 5000);
    c.onTool('2', 'Bash', 'aom graph query "x"');
    c.onResult('2', 900); // its output is the graph's, not a search of the code
    c.onGraphVerb(900);
    c.onTool('3', 'Grep', 'x');
    c.onResult('3', 300);
    c.onTool('4', 'Bash', 'npm test');
    c.onResult('4', 70_000); // not a lookup
    c.onTool('5', 'Edit', 'a.ts');
    c.onTool('6', 'Read', 'b.ts');
    c.onResult('6', 9999); // after the first edit: not discovery any more
    c.onResult('unknown', 1); // a result without a call is ignored
    expect(c.snapshot()).toEqual({
      graphArm: 'on',
      discoveryBytes: 5300,
      discoveryCalls: 2,
      graphBytes: 900,
      graphCalls: 1,
      briefBytes: 1200,
    });
  });

  it('a result of a call that has no id cannot be matched and counts nothing', () => {
    const c = new ContextCounter('none');
    c.onTool(undefined, 'Read', 'a.ts');
    c.onResult('x', 100);
    expect(c.snapshot().discoveryBytes).toBe(0);
  });
});

const VAULT_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789d1';

async function shiftWith(arm: 'on' | 'off' | undefined, script: (ctl: Ctl) => Promise<void>) {
  const adapter = new ScriptedAdapter(async (_i, ctl) => {
    await script(ctl);
    await ctl.post('/v1/report', { report: { kind: 'outcome', outcomeId: 'handoff', note: 'n', data: {} } });
  });
  h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
  h.runner.vaults.configure({
    vaults: [
      {
        vaultId: VAULT_ID,
        kind: 'project',
        name: 'P',
        remoteUrl: '',
        syncIntervalSec: 300,
        storage: 'local',
      },
    ],
    identity: { name: 'A', email: 'a@agents.aom.invalid' },
    workstationName: 'Desk',
    resume: [],
  });
  const fx = makeGraphRepo(FIXTURE_FILES);
  await indexRepository({
    repoPath: fx.repo,
    repoKey: fx.repoKey,
    repoName: 'fixture',
    graphDir: h.runner.graph.graphDir(h.runner.vaults.dir(VAULT_ID), 'projects/toy'),
    cacheDir: h.runner.graph.cacheDir,
    indexerVersion: 't',
  });
  return h.runShift({
    stage: 'build',
    title: 'Ledger total',
    fields: { affectedAreas: 'packages/core ledger' },
    startExtra: arm ? { graph: { vaultId: VAULT_ID, folder: 'projects/toy', arm } } : {},
  });
}

describe('shift.ended carries the context counters of a card shift', () => {
  it('with the graph: the arm, the discovery before the first edit, the graph verbs and the brief size', async () => {
    const { ended } = await shiftWith('on', async (ctl) => {
      ctl.emit({ kind: 'tool', name: 'Grep', summary: 'ledger', id: 't1' });
      ctl.emit({ kind: 'toolresult', id: 't1', bytes: 4000 });
      await ctl.post('/v1/rpc', { method: 'graph.query', params: { text: 'ledger total' } });
      ctl.emit({ kind: 'tool', name: 'Edit', summary: 'a.ts', id: 't2' });
      ctl.emit({ kind: 'tool', name: 'Read', summary: 'b.ts', id: 't3' });
      ctl.emit({ kind: 'toolresult', id: 't3', bytes: 777 });
    });
    const c = ended.context;
    expect(c).toMatchObject({ graphArm: 'on', discoveryBytes: 4000, discoveryCalls: 1, graphCalls: 1 });
    expect(c?.graphBytes).toBeGreaterThan(100);
    expect(c?.briefBytes).toBeGreaterThan(300);
    expect(c?.briefBytes).toBeLessThanOrEqual(1500);
  });

  it('the holdout arm is reported as off, with no graph bytes and no brief', async () => {
    const { ended } = await shiftWith('off', async (ctl) => {
      ctl.emit({ kind: 'tool', name: 'Glob', summary: '**/*.ts', id: 't1' });
      ctl.emit({ kind: 'toolresult', id: 't1', bytes: 2500 });
      const r = await ctl.post('/v1/rpc', { method: 'graph.query', params: { text: 'ledger total' } });
      expect(r.json).toMatchObject({ ok: false });
    });
    expect(ended.context).toEqual({
      graphArm: 'off',
      discoveryBytes: 2500,
      discoveryCalls: 1,
      graphBytes: 0,
      graphCalls: 0,
      briefBytes: 0,
    });
  });

  it('a project without a graph is reported as none (and not measured by the server)', async () => {
    const { ended } = await shiftWith(undefined, async () => undefined);
    expect(ended.context).toMatchObject({ graphArm: 'none', graphCalls: 0, briefBytes: 0 });
  });
});

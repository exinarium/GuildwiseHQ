import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractFallbackReport } from '../src/shifts/supervisor.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, sh, waitUntil } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const outcome = (outcomeId: string, note = 'n', data: Record<string, unknown> = {}) => ({
  report: { kind: 'outcome', outcomeId, note, data },
});

async function start(
  script: ConstructorParameters<typeof ScriptedAdapter>[0],
  serverOpts: Parameters<typeof startHarness>[0] = {},
  runnerOpts: Parameters<typeof startHarness>[1] = {},
) {
  const adapter = new ScriptedAdapter(script);
  h = await startHarness(serverOpts, { adapters: new Map([['mock', adapter]]), ...runnerOpts });
  return { adapter, h };
}

describe('supervisor', () => {
  it('rejects unknown outcomes in-shift, then accepts the right one; a second terminal report is 409', async () => {
    const seen: Record<string, unknown> = {};
    await start(async (_i, ctl) => {
      seen.bad = await ctl.post('/v1/report', outcome('nope'));
      seen.good = await ctl.post('/v1/report', outcome('handoff', 'built it'));
      seen.again = await ctl.post('/v1/report', outcome('handoff', 'again'));
    });
    const { shiftId, ended } = await h!.runShift({ stage: 'build' });
    expect((seen.bad as any).status).toBe(422);
    expect((seen.bad as any).json.error).toMatch(/Unknown outcome "nope".*handoff/);
    expect((seen.good as any).status).toBe(200);
    expect((seen.good as any).json.message).toBe('Recorded. Finish now; do not make further changes.');
    expect((seen.again as any).status).toBe(409);
    expect(ended.outcome).toBe('reported');
    expect(h!.server.of('shift.report').filter((r) => r.shiftId === shiftId)).toHaveLength(1);
  });

  it('validates outcome data (review needs a score)', async () => {
    const seen: any = {};
    await start(async (_i, ctl) => {
      seen.r = await ctl.post('/v1/report', outcome('approve', 'ok', {}));
      await ctl.post('/v1/report', outcome('approve', 'ok', { score: 5 }));
    });
    await h!.runShift({ stage: 'build' }); // create the worktree first
    // run a review shift (reuse)
    const r = await h!.runShift({ stage: 'review' });
    expect(seen.r.status).toBe(422);
    expect(r.ended.outcome).toBe('reported');
  });

  it('the token stops working after the shift ends', async () => {
    let token = '';
    let url = '';
    await start(async (i) => {
      token = i.env.AOM_SHIFT_TOKEN as string;
      url = i.env.AOM_IPC_URL as string;
    });
    const { ended } = await h!.runShift({ stage: 'build' });
    expect(ended.outcome).toBe('no_report');
    const res = await fetch(`${url}/v1/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'card.get' }),
    });
    expect(res.status).toBe(401);
  });

  it('card.get is served from the brief; other rpcs go to the server', async () => {
    const seen: any = {};
    await start(
      async (_i, ctl) => {
        seen.card = await ctl.post('/v1/rpc', { method: 'card.get' });
        seen.ledger = await ctl.post('/v1/rpc', { method: 'ledger.search', params: { query: 'cookies' } });
      },
      { rpc: (m) => ({ ok: true, result: { echoed: m.params } }) },
    );
    await h!.runShift({ stage: 'build' });
    expect(seen.card.json.result.card.ref).toBe('TOY-1');
    expect(seen.ledger.json.result).toEqual({ echoed: { query: 'cookies' } });
  });

  it('build handoff carries diffStats and risk tier; leftovers are auto-committed, before and after the report', async () => {
    let wt = '';
    await start(async (i, ctl) => {
      wt = i.cwd;
      writeFileSync(join(wt, 'uncommitted.ts'), 'a\nb\n');
      await ctl.post('/v1/report', outcome('handoff', 'done'));
      writeFileSync(join(wt, 'after-report.ts'), 'late\n'); // written after the report, before exit
    });
    const { shiftId } = await h!.runShift({ stage: 'build', architecturalGlobs: ['uncommitted.ts'] });
    const rep = h!.server.of('shift.report').find((r) => r.shiftId === shiftId);
    expect(rep?.diffStats).toEqual({
      files: 1,
      added: 2,
      removed: 0,
      architecturalPaths: ['uncommitted.ts'],
    });
    expect(rep?.riskTier).toBe('large');
    expect(sh(wt, 'git', ['status', '--porcelain'])).toBe('');
    const log = sh(wt, 'git', ['log', '--format=%s']).split('\n');
    expect(log[0]).toMatch(/^aom: TOY-1 build leftovers \(shift [0-9a-f]{8}\)$/);
    expect(log[1]).toMatch(/^aom: TOY-1 build leftovers/);
  });

  it('guard rejects a reviewer who changed code and records the violation on shift.ended', async () => {
    const seen: any = {};
    await start(async (i, ctl) => {
      if (i.agent.roleKey === 'builder') return;
      writeFileSync(join(i.cwd, 'sneaky.txt'), 'x');
      seen.r = await ctl.post('/v1/report', outcome('approve', 'ok', { score: 4 }));
    });
    await h!.runShift({ stage: 'build' });
    const { shiftId, ended } = await h!.runShift({ stage: 'review' });
    expect(seen.r.status).toBe(422);
    expect(seen.r.json.guardViolations[0].rule).toBe('reviewer_modified_code');
    expect(ended.outcome).toBe('no_report');
    expect(ended.guardViolations.map((v) => v.rule)).toEqual(['reviewer_modified_code']);
    expect(h!.server.of('shift.report').filter((r) => r.shiftId === shiftId)).toHaveLength(0);
  });

  it('a server-side rejection reaches the agent, who can report again', async () => {
    let calls = 0;
    const seen: any[] = [];
    await start(
      async (_i, ctl) => {
        seen.push(await ctl.post('/v1/report', outcome('handoff', 'first')));
        seen.push(await ctl.post('/v1/report', outcome('handoff', 'second')));
      },
      {
        reportResult: () =>
          ++calls === 1 ? { accepted: false, error: 'missing required fields' } : { accepted: true },
      },
    );
    const { ended } = await h!.runShift({ stage: 'build' });
    expect(seen[0].status).toBe(422);
    expect(seen[0].json.error).toBe('missing required fields');
    expect(seen[1].status).toBe(200);
    expect(ended.outcome).toBe('reported');
  });

  it('falls back to a fenced aom-report block in the final message', async () => {
    await start(async () => ({
      finalText:
        'All done.\n```aom-report\n{"kind":"outcome","outcomeId":"handoff","note":"via fallback","data":{}}\n```',
    }));
    const { shiftId, ended } = await h!.runShift({ stage: 'build' });
    expect(ended.outcome).toBe('reported');
    expect(h!.server.of('shift.report').find((r) => r.shiftId === shiftId)?.report).toMatchObject({
      note: 'via fallback',
    });
    expect(extractFallbackReport('```aom-report\n{"kind":"comment","note":"x"}\n```')).toBeNull(); // not terminal
    expect(extractFallbackReport('no block')).toBeNull();
  });

  it('rejects: busy, repo_missing, worktree_failed, runtime_unavailable', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await start(
      async () => {
        await gate;
      },
      {},
      {},
    );
    // busy: first shift holds the only slot (config maxConcurrentShifts via welcome limit)
    const first = makeShiftStart({ remoteNormalized: h!.repo.remoteNormalized, ref: 'TOY-1', title: 'one' });
    (h!.runner as any).maxConcurrent = 1;
    h!.server.send('shift.start', first);
    await h!.server.waitFor('shift.started');
    const second = makeShiftStart({ remoteNormalized: h!.repo.remoteNormalized, ref: 'TOY-2', title: 'two' });
    h!.server.send('shift.start', second);
    const busy = await h!.server.waitFor('shift.rejected', (m) => m.shiftId === second.shiftId);
    expect(busy.reason).toBe('busy');
    release();
    await h!.server.waitFor('shift.ended', (m) => m.shiftId === first.shiftId);

    const missing = makeShiftStart({
      remoteNormalized: 'example.test/other/repo',
      ref: 'TOY-3',
      title: 'three',
    });
    h!.server.send('shift.start', missing);
    expect((await h!.server.waitFor('shift.rejected', (m) => m.shiftId === missing.shiftId)).reason).toBe(
      'repo_missing',
    );

    const noTree = makeShiftStart({
      remoteNormalized: h!.repo.remoteNormalized,
      ref: 'TOY-4',
      title: 'four',
      mode: 'reuse',
      stage: 'review',
    });
    h!.server.send('shift.start', noTree);
    const wf = await h!.server.waitFor('shift.rejected', (m) => m.shiftId === noTree.shiftId);
    expect(wf.reason).toBe('worktree_failed');

    const badRuntime = makeShiftStart({
      remoteNormalized: h!.repo.remoteNormalized,
      ref: 'TOY-5',
      title: 'five',
    }) as any;
    badRuntime.agent.runtime = 'does-not-exist';
    h!.server.send('shift.start', badRuntime);
    expect((await h!.server.waitFor('shift.rejected', (m) => m.shiftId === badRuntime.shiftId)).reason).toBe(
      'runtime_unavailable',
    );
    expect(h!.server.invalid).toEqual([]);
  });

  it('shift.stop ends the shift as stopped and acks the stop', async () => {
    await start(async (_i, ctl) => {
      await new Promise<void>((resolve) => ctl.signal.addEventListener('abort', () => resolve()));
    });
    const msg = makeShiftStart({ remoteNormalized: h!.repo.remoteNormalized });
    h!.server.send('shift.start', msg);
    await h!.server.waitFor('shift.started');
    expect(h!.runner.supervisor.activeShifts()).toHaveLength(1);
    h!.server.send('shift.stop', { shiftId: msg.shiftId, reason: 'manager' });
    const ended = await h!.server.waitFor('shift.ended');
    expect(ended.outcome).toBe('stopped');
    await waitUntil(() => h!.server.of('ack').length > 0, 5000, 'ack of shift.stop');
    expect(h!.runner.supervisor.activeShifts()).toHaveLength(0);
  });

  it('claim_lost discards the unsent terminal report but keeps the worktree', async () => {
    await start(
      async (_i, ctl) => {
        await ctl.post('/v1/report', outcome('handoff', 'queued'));
      },
      { autoAck: false, reportResult: () => 'ignore' },
      { reportWaitMs: 60_000 },
    );
    const msg = makeShiftStart({ remoteNormalized: h!.repo.remoteNormalized });
    h!.server.send('shift.start', msg);
    await h!.server.waitFor('shift.report');
    expect(h!.runner.outbox.list().some((e) => e.type === 'shift.report')).toBe(true);
    h!.server.send('shift.stop', { shiftId: msg.shiftId, reason: 'claim_lost' });
    const ended = await h!.server.waitFor('shift.ended');
    expect(ended.outcome).toBe('stopped');
    expect(h!.runner.outbox.list().some((e) => e.type === 'shift.report')).toBe(false);
    expect(existsSync(join(h!.dataDir, 'worktrees', 'TOY', 'TOY-1'))).toBe(true);
  });

  it('resumes a persisted shift after a runner restart without re-sending shift.accepted/started', async () => {
    await start(async (_i, ctl) => {
      await ctl.post('/v1/report', outcome('handoff', 'resumed and done'));
    });
    const msg = makeShiftStart({ remoteNormalized: h!.repo.remoteNormalized });
    const dir = join(h!.dataDir, 'active-shifts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${msg.shiftId}.json`), JSON.stringify({ msg, startedSent: true }));
    h!.runner.supervisor.resumePersisted();
    expect(h!.runner.supervisor.activeShifts().map((s) => s.shiftId)).toContain(msg.shiftId as string);
    const ended = await h!.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 30_000);
    expect(ended.outcome).toBe('reported');
    expect(h!.server.of('shift.accepted').filter((m) => m.shiftId === msg.shiftId)).toHaveLength(0);
    expect(h!.server.of('shift.started').filter((m) => m.shiftId === msg.shiftId)).toHaveLength(0);
    expect(existsSync(join(dir, `${msg.shiftId}.json`))).toBe(false); // forgotten once the shift is over
  });

  it('commands: agent.wipe and worktree.remove are idempotent', async () => {
    await start(async () => undefined);
    await h!.runShift({ stage: 'build' });
    const spec = makeShiftStart({ remoteNormalized: h!.repo.remoteNormalized }) as any;
    const wtPath = join(h!.dataDir, 'worktrees', 'TOY', 'TOY-1');
    h!.server.send('command', {
      commandId: 'c1',
      command: 'worktree.remove',
      payload: { path: wtPath, branchName: spec.worktree.branchName, deleteBranch: true },
    });
    const r1 = await h!.server.waitFor('command.result', (m) => m.commandId === 'c1');
    expect(r1.ok).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
    h!.server.send('command', { commandId: 'c2', command: 'worktree.remove', payload: { path: wtPath } });
    expect((await h!.server.waitFor('command.result', (m) => m.commandId === 'c2')).ok).toBe(true);

    const agentDir = h!.runner.paths.agentDir('019e3f6a-7b1c-7a2d-8c3e-0123456789a1');
    h!.server.send('command', {
      commandId: 'c3',
      command: 'agent.wipe',
      payload: { agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1' },
    });
    expect((await h!.server.waitFor('command.result', (m) => m.commandId === 'c3')).ok).toBe(true);
    expect(existsSync(agentDir)).toBe(false);

    h!.server.send('command', { commandId: 'c4', command: 'vault.write', payload: {} });
    const unsupported = await h!.server.waitFor('command.result', (m) => m.commandId === 'c4');
    expect(unsupported.ok).toBe(false);
  });
});

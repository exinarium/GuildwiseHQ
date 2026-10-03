import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { syncVault } from '../src/vaults/sync.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, sh, tmp, waitUntil } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';
import { IDENTITY, makeDevopsStart, makeVault, originFile } from './vault-fixtures.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

/** Sends a shift.start and waits for the matching shift.ended. */
async function run(start: Record<string, unknown>) {
  const shiftId = start.shiftId as string;
  h!.server.send('shift.start', start);
  const ended = await h!.server.waitFor('shift.ended', (m) => m.shiftId === shiftId, 60_000);
  return { shiftId, ended };
}
const reportOf = (shiftId: string) => h!.server.of('shift.report').filter((r) => r.shiftId === shiftId);
const instructionsOf = (agentId: string) =>
  readFileSync(join(h!.dataDir, 'agents', agentId, 'claude', 'CLAUDE.md'), 'utf8');

describe('DevOps shifts (mock agent, real aom CLI)', () => {
  it('works one request without a card or worktree and ends with devops-done', async () => {
    h = await startHarness();
    const start = makeDevopsStart({ summary: 'start the app' });
    const { shiftId, ended } = await run(start);
    expect(ended.outcome).toBe('reported');
    const [rep] = reportOf(shiftId);
    expect(rep?.report).toMatchObject({
      kind: 'outcome',
      outcomeId: 'devops_done',
      data: { summary: 'mock: start the app', commands: ['mock: echo done'] },
    });
    expect(rep?.diffStats).toBeUndefined();
    const started = h.server.of('shift.started').find((m) => m.shiftId === shiftId);
    expect(started?.worktree).toBeUndefined();
    expect(existsSync(join(h.dataDir, 'worktrees'))).toBe(false);
    // not counted as a card shift in heartbeats/hello
    expect(h.runner.supervisor.activeShifts()).toEqual([]);
  });

  it('writes DevOps instructions with the granted access, not the card instructions', async () => {
    h = await startHarness();
    const agentId = uuidv7();
    await run(
      makeDevopsStart({
        agentId,
        summary: 'start the app',
        access: { allowInstall: true, allowedPaths: ['/srv/apps'] },
      }),
    );
    const md = instructionsOf(agentId);
    expect(md).toContain('You are Atlas, the DevOps engineer for the workstation "Desk"');
    expect(md).toContain('Install packages and tools: allowed');
    expect(md).toContain('Docker (install, run, manage containers): NOT allowed');
    expect(md).toContain('/srv/apps');
    expect(md).toContain('aom devops-approval --action');
    expect(md).not.toContain('Environment help');
  });

  it('a request outside the granted access asks for approval and does not run it', async () => {
    h = await startHarness();
    const { shiftId, ended } = await run(makeDevopsStart({ summary: 'install docker' }));
    expect(ended.outcome).toBe('reported');
    const [rep] = reportOf(shiftId);
    expect(rep?.report).toMatchObject({
      kind: 'outcome',
      outcomeId: 'devops_approval',
      data: { action: 'install docker', commands: ['mock: install docker'] },
    });
  });

  it('with the access granted, or the approval attached, the same request completes', async () => {
    h = await startHarness();
    const granted = await run(
      makeDevopsStart({ summary: 'install docker', access: { allowInstall: true, allowDocker: true } }),
    );
    expect(reportOf(granted.shiftId)[0]?.report).toMatchObject({ outcomeId: 'devops_done' });
    const approved = await run(
      makeDevopsStart({
        summary: 'install docker',
        approval: {
          action: 'install docker',
          reason: 'needed',
          commands: ['apt install docker.io'],
          note: 'ok',
        },
      }),
    );
    expect(reportOf(approved.shiftId)[0]?.report).toMatchObject({ outcomeId: 'devops_done' });
  });

  it('a crash is reported as such and the request text carries the failure mode', async () => {
    h = await startHarness();
    const { ended } = await run(makeDevopsStart({ summary: 'fix the build [crash]' }));
    expect(ended.outcome).toBe('crashed');
    const none = await run(makeDevopsStart({ summary: 'tidy up [no_report]' }));
    expect(none.ended.outcome).toBe('no_report');
  });

  it('rejects a card outcome in a DevOps shift locally, before it reaches the server', async () => {
    const seen: any = {};
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      seen.bad = await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'n', data: {} },
      });
      seen.noData = await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'devops_done', note: 'n', data: {} },
      });
      seen.card = await ctl.post('/v1/rpc', { method: 'card.get' });
      seen.ok = await ctl.post('/v1/report', {
        report: {
          kind: 'outcome',
          outcomeId: 'devops_done',
          note: 'n',
          data: { summary: 'did it', commands: ['a'] },
        },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    await run(makeDevopsStart({ summary: 'check disk space' }));
    expect(seen.bad.status).toBe(422);
    expect(seen.bad.json.error).toMatch(/Unknown outcome "handoff".*devops_done, devops_approval/);
    expect(seen.noData.status).toBe(422);
    expect(seen.card.json.result.devops.summary).toBe('check disk space');
    expect(seen.ok.status).toBe(200);
    expect(adapter.inputs[0]?.cwd).toContain('scratch'); // no worktree: the agent's scratch dir
    expect(adapter.inputs[0]?.addDirs).toEqual([]);
  });
});

describe('`aom devops` from a card shift', () => {
  it('forwards the request to the server and does not end the shift', async () => {
    const seen: any = {};
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      seen.first = await ctl.post('/v1/rpc', { method: 'devops.request', params: { text: 'start the app' } });
      await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'built', data: {} },
      });
    });
    h = await startHarness(
      {
        rpc: (m) =>
          m.method === 'devops.request'
            ? { ok: true, result: { requestId: 'r-1', message: 'sent' } }
            : { ok: false },
      },
      { adapters: new Map([['mock', adapter]]) },
    );
    const msg = makeShiftStart({ stage: 'build', remoteNormalized: h.repo.remoteNormalized });
    const { ended } = await run(msg);
    expect(seen.first.json).toEqual({ ok: true, result: { requestId: 'r-1', message: 'sent' } });
    const rpc = h.server.of('rpc.request').find((r) => r.method === 'devops.request');
    expect(rpc?.params).toEqual({ text: 'start the app' });
    expect(ended.outcome).toBe('reported');
    expect(adapter.inputs[0]?.instructionsMarkdown).toContain('aom devops "<request>"');
  });
});

describe('a card shift sees only the vault of its domain', () => {
  async function twoVaults() {
    const work = makeVault({
      'standing-orders.md': 'WORK-GLOBAL-ORDER keep it short\n',
      'projects/toy/PROJECT.md': 'WORK-PROJECT-DOC use pnpm\n',
      'projects/toy/standing-orders.md': 'WORK-PROJECT-ORDER no force push\n',
    });
    const personal = makeVault({
      'standing-orders.md': 'PERSONAL-GLOBAL-ORDER be playful\n',
      'projects/toy/PROJECT.md': 'PERSONAL-PROJECT-DOC secret hobby\n',
    });
    h = undefined;
    const adapter = new ScriptedAdapter(async () => {});
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const clone = async (id: string, v: { origin: string }) => {
      const dir = join(h!.dataDir, 'vaults', id);
      await syncVault({ dir, remoteUrl: v.origin, identity: IDENTITY, workstationName: 'Desk' });
      return dir;
    };
    const workId = uuidv7();
    const personalId = uuidv7();
    const workDir = await clone(workId, work);
    const personalDir = await clone(personalId, personal);
    return { adapter, workId, personalId, workDir, personalDir };
  }
  const withVault = (vault: unknown, over: Record<string, unknown> = {}) => ({
    ...makeShiftStart({ stage: 'build', remoteNormalized: h!.repo.remoteNormalized, ...over }),
    vault,
  });

  it('a work card: only the work vault is passed as --add-dir and read into the instructions', async () => {
    const v = await twoVaults();
    const agentId = uuidv7();
    await run(
      withVault({ vaultId: v.workId, kind: 'work', folder: 'projects/toy' }, { agentId, ref: 'TOY-1' }),
    );
    expect(v.adapter.inputs[0]?.addDirs).toEqual([v.workDir]);
    const md = v.adapter.inputs[0]?.instructionsMarkdown ?? '';
    expect(md).toContain('WORK-PROJECT-DOC use pnpm');
    expect(md).toContain('WORK-GLOBAL-ORDER keep it short');
    expect(md).toContain('WORK-PROJECT-ORDER no force push');
    expect(md).toContain('## PROJECT.md (from the knowledge vault)');
    expect(md).not.toContain('PERSONAL-');
    expect(v.adapter.inputs[0]?.instructionsMarkdown).not.toContain(v.personalDir);
    expect(JSON.stringify(v.adapter.inputs[0])).not.toContain(v.personalId);
  });

  it('a personal card: only the personal vault', async () => {
    const v = await twoVaults();
    const agentId = uuidv7();
    await run(
      withVault(
        { vaultId: v.personalId, kind: 'personal', folder: 'projects/toy' },
        { agentId, ref: 'TOY-2', shiftId: uuidv7() },
      ),
    );
    expect(v.adapter.inputs[0]?.addDirs).toEqual([v.personalDir]);
    const md = v.adapter.inputs[0]?.instructionsMarkdown ?? '';
    expect(md).toContain('PERSONAL-PROJECT-DOC secret hobby');
    expect(md).toContain('PERSONAL-GLOBAL-ORDER be playful');
    expect(md).not.toContain('WORK-');
  });

  it('no vault named, or no clone yet: no add-dir and no vault text', async () => {
    const v = await twoVaults();
    const a = uuidv7();
    await run(withVault(null, { agentId: a, ref: 'TOY-3' }));
    expect(v.adapter.inputs[0]?.addDirs).toEqual([]);
    expect(v.adapter.inputs[0]?.instructionsMarkdown).not.toContain('WORK-');
    const b = uuidv7();
    await run(
      withVault({ vaultId: uuidv7(), kind: 'work', folder: 'projects/toy' }, { agentId: b, ref: 'TOY-4' }),
    );
    expect(v.adapter.inputs[1]?.addDirs).toEqual([]);
    expect(v.adapter.inputs[1]?.instructionsMarkdown).not.toContain('PROJECT.md (from');
  });
});

describe('vault commands from the server', () => {
  const send = (cmd: string, payload: Record<string, unknown>) => {
    const commandId = uuidv7();
    h!.server.send('command', { commandId, command: cmd, payload });
    return h!.server.waitFor('command.result', (m) => m.commandId === commandId, 20_000);
  };
  const configure = (v: { origin: string }, id = 'vault-1', resume: string[] = []) =>
    send('vault.configure', {
      vaults: [{ vaultId: id, kind: 'work', name: 'Work', remoteUrl: v.origin, syncIntervalSec: 3600 }],
      identity: IDENTITY,
      workstationName: 'Desk',
      resume,
    });

  it('vault.configure clones the vault; vault.write commits and pushes; both are idempotent', async () => {
    h = await startHarness();
    const v = makeVault();
    expect(await configure(v)).toMatchObject({ ok: true, result: { vaults: ['vault-1'] } });
    await waitUntil(() => existsSync(join(h!.dataDir, 'vaults', 'vault-1', 'README.md')), 10_000, 'clone');
    const write = {
      vaultId: 'vault-1',
      path: 'projects/toy/decisions/2026-10-03-x.md',
      mode: 'create',
      content: '# x\n',
      commitMessage: 'aom: decision x',
    };
    expect(await send('vault.write', write)).toMatchObject({
      ok: true,
      result: { written: true, committed: true, pushed: true },
    });
    expect(originFile(v, write.path)).toBe('# x\n');
    expect(await send('vault.write', write)).toMatchObject({
      ok: true,
      result: { written: false, committed: false },
    });
    // an unsafe path and an unknown vault fail the command (the server retries or escalates)
    const bad = await send('vault.write', { ...write, path: '../x.md' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/unsafe vault path/);
    const unknown = await send('vault.write', { ...write, vaultId: 'other' });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/not configured/);
    // status reports reach the server
    await waitUntil(
      () => h!.server.of('vault.status').some((s) => s.vaultId === 'vault-1' && !s.error),
      5000,
      'vault.status',
    );
    // the configuration survives in the data dir
    expect(JSON.parse(readFileSync(join(h.dataDir, 'vaults.json'), 'utf8')).config.vaults[0].vaultId).toBe(
      'vault-1',
    );
    expect(readdirSync(join(h.dataDir, 'vaults'))).toEqual(['vault-1']);
  });

  it('a sync conflict reaches the server as vault.conflict and stops further pushes', async () => {
    h = await startHarness();
    const v = makeVault({ 'notes.md': 'one\ntwo\n' });
    await configure(v);
    await waitUntil(() => existsSync(join(h!.dataDir, 'vaults', 'vault-1', 'notes.md')), 10_000, 'clone');
    // local edit + conflicting remote edit, then a write forces a sync pass
    sh(join(h.dataDir, 'vaults', 'vault-1'), 'git', ['config', 'user.name', 'x']);
    const w = await send('vault.write', {
      vaultId: 'vault-1',
      path: 'notes.md',
      mode: 'replace',
      content: 'one\nlocal\n',
      commitMessage: 'aom: local edit',
      push: false,
    });
    expect(w.ok).toBe(true);
    sh(v.other, 'git', ['pull', '--rebase', 'origin', 'main']);
    sh(v.other, 'git', ['commit', '--allow-empty', '-m', 'noop']);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(v.other, 'notes.md'), 'one\nremote\n');
    sh(v.other, 'git', ['commit', '-am', 'remote edit']);
    sh(v.other, 'git', ['push', 'origin', 'main']);
    const second = await send('vault.write', {
      vaultId: 'vault-1',
      path: 'other.md',
      mode: 'create',
      content: 'x\n',
      commitMessage: 'aom: other',
    });
    expect(second).toMatchObject({ ok: true, result: { paused: true, pushed: false } });
    const conflict = await h.server.waitFor('vault.conflict', () => true, 10_000);
    expect(conflict).toMatchObject({ vaultId: 'vault-1', files: ['notes.md'] });
    // resume from the server: the runner retries (and conflicts again until the manager really fixed it)
    const res = await configure(v, 'vault-1', ['vault-1']);
    expect(res.ok).toBe(true);
    await waitUntil(() => h!.server.of('vault.conflict').length >= 2, 10_000, 'conflict reported again');
  });

  it('removing a vault from the configuration stops its timer and forgets its pause state', async () => {
    h = await startHarness();
    const v = makeVault();
    await configure(v);
    await send('vault.configure', { vaults: [], identity: IDENTITY, workstationName: 'Desk', resume: [] });
    expect(h.runner.vaults.configured()).toEqual([]);
    expect(tmp).toBeTruthy();
  });
});

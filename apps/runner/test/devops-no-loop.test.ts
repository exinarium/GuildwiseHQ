import { uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FileAuthority } from '../src/policy/authority.ts';
import { HeldStore } from '../src/policy/held.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';
import { makeDevopsStart } from './vault-fixtures.ts';

cleanupTmp();

/**
 * UAT 1.10.0 finding 3 on the runner: a DevOps request looped (a NEW held devops.task about every minute). The held shift
 * was never accepted, so the server released it after 30 s, re-queued the request and sent a new shift, held again. A
 * held DevOps shift is now accepted, a request is held once (a new shift of it updates that item), a request blocked by
 * Install off shows as one item on Approvals on this computer, and the local install choice reaches the server.
 */
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const ORG = '0190a000-0000-7000-8000-000000000001';
function granted(extra: Record<string, unknown> = {}) {
  const dir = tmp('aom-policy-');
  const store = new PolicyStore(dir);
  store.write({ ...store.get(), setupDone: true, ...extra });
  return { dir, store, authority: new FileAuthority(store) };
}
function devopsStart(agentId: string, requestId?: string) {
  const m = makeDevopsStart({ agentId, summary: 'install Node 22' }) as Record<string, any>;
  m.orgId = ORG;
  if (requestId) m.devops = { ...m.devops, requestId, threadId: requestId };
  return m;
}

describe('a DevOps request held for a local yes', () => {
  it('is accepted, and a new shift of the same request does not make a second held task', async () => {
    const agentId = uuidv7();
    const a = granted({ devops: { agents: { [ORG]: agentId } }, devopsRequests: 'ask' });
    h = await startHarness({}, { authority: a.authority, policyDir: a.dir, approvalsPollMs: 50 });
    const first = devopsStart(agentId);
    h.server.send('shift.start', first);
    const held = await h.server.waitFor('approvals.held', (m) =>
      m.items.some((i) => i.kind === 'devops.task'),
    );
    const item = held.items.find((i) => i.kind === 'devops.task');
    // accepted: the server does not release it after 30 s
    await h.server.waitFor('shift.accepted', (m) => m.shiftId === first.shiftId);
    // the server re-sends the request as a new shift (a reconnect, an older server's release): still ONE held task
    for (let i = 0; i < 3; i++) {
      const again = { ...devopsStart(agentId, first.devops.requestId), shiftId: uuidv7() };
      h.server.send('shift.start', again);
      await h.server.waitFor('shift.accepted', (m) => m.shiftId === again.shiftId);
    }
    await new Promise((r) => setTimeout(r, 300));
    const items = new HeldStore(a.dir).list().filter((r) => r.kind === 'devops.task');
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(item?.id);
    expect(
      (h.server.of('approvals.held').at(-1)?.items ?? []).filter((i) => i.kind === 'devops.task'),
    ).toHaveLength(1);
    // the one item runs the newest shift
    expect((items[0]?.replay.body as { shiftId?: string } | undefined)?.shiftId).not.toBe(first.shiftId);
  });
});

describe('a local no (REVIEW S1)', () => {
  it('a held DevOps task denied on the workstation is refused as such, so the server ends the request', async () => {
    const agentId = uuidv7();
    const a = granted({ devops: { agents: { [ORG]: agentId } }, devopsRequests: 'ask' });
    h = await startHarness({}, { authority: a.authority, policyDir: a.dir, approvalsPollMs: 50 });
    const start = devopsStart(agentId);
    h.server.send('shift.start', start);
    const held = await h.server.waitFor('approvals.held', (m) =>
      m.items.some((i) => i.kind === 'devops.task'),
    );
    const item = held.items.find((i) => i.kind === 'devops.task');
    new HeldStore(a.dir).decide(item?.id as string, 'denied', 'local');
    const rejected = await h.server.waitFor('shift.rejected', (m) => m.shiftId === start.shiftId);
    expect(rejected).toMatchObject({ refusedLocally: true, detail: 'denied on the workstation' });
  });

  it('Rework 2: a new shift of a request refused here (the reconnect race) is refused at once, with no new held item', async () => {
    const agentId = uuidv7();
    const a = granted({ devops: { agents: { [ORG]: agentId } }, devopsRequests: 'ask' });
    h = await startHarness({}, { authority: a.authority, policyDir: a.dir, approvalsPollMs: 50 });
    const start = devopsStart(agentId);
    h.server.send('shift.start', start);
    const held = await h.server.waitFor('approvals.held', (m) =>
      m.items.some((i) => i.kind === 'devops.task'),
    );
    new HeldStore(a.dir).decide(
      held.items.find((i) => i.kind === 'devops.task')?.id as string,
      'denied',
      'local',
    );
    await h.server.waitFor('shift.rejected', (m) => m.shiftId === start.shiftId);
    // the server had already ended that shift as lost and sends the request again
    const again = { ...devopsStart(agentId, start.devops.requestId), shiftId: uuidv7() };
    h.server.send('shift.start', again);
    const refused = await h.server.waitFor('shift.rejected', (m) => m.shiftId === again.shiftId);
    expect(refused).toMatchObject({ refusedLocally: true, detail: 'refused on this workstation earlier' });
    expect(h.server.of('shift.accepted').some((m) => m.shiftId === again.shiftId)).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(new HeldStore(a.dir).list().filter((r) => r.kind === 'devops.task')).toEqual([]);
  });
});

describe('a DevOps request blocked by Install off', () => {
  it('shows as one item on Approvals on this computer, with the switch and the local command', async () => {
    // runner-authority-fixes Rework 1 (S2): a switch wait needs the guard's own refusal of the command (the agent's
    // words alone no longer pick a switch), so the agent here is scripted: the guard refused `npm i -g node@22`
    const adapter = new ScriptedAdapter(async (input, ctl) => {
      await ctl.post('/v1/rpc', {
        method: 'devops.audit',
        params: {
          entries: [
            {
              at: new Date().toISOString(),
              sessionRef: input.shiftId,
              kind: 'shift',
              decision: 'refused',
              rule: 'install_off',
              command: 'npm i -g node@22',
            },
          ],
        },
      });
      await ctl.post('/v1/report', {
        report: {
          kind: 'outcome',
          outcomeId: 'devops_approval',
          note: 'Needs approval',
          data: {
            action: 'install Node 22',
            reason: 'needed',
            commands: ['npm i -g node@22'],
            blockedBy: 'allowInstall',
          },
        },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const start = makeDevopsStart({ summary: 'install Node 22' }) as Record<string, any>;
    h.server.send('shift.start', start);
    await h.server.waitFor('shift.ended', (m) => m.shiftId === start.shiftId, 60_000);
    const report = h.server.of('shift.report').find((r) => r.shiftId === start.shiftId);
    expect(report?.report).toMatchObject({ kind: 'outcome', outcomeId: 'devops_approval' });
    const blocked = h.runner.blockedDevops();
    expect(blocked).toEqual([
      expect.objectContaining({
        requestId: start.devops.requestId,
        switch: 'allowInstall',
        switchLabel: 'Install packages and tools',
        agentName: 'Atlas',
      }),
    ]);
  });

  it('the local install choice is sent on welcome and whenever it changes', async () => {
    const a = granted({ devopsInstall: true });
    h = await startHarness({}, { authority: a.authority, policyDir: a.dir, approvalsPollMs: 50 });
    await h.server.waitFor('devops.install.local', (m) => m.on === true);
    a.store.update((p) => ({ ...p, devopsInstall: false }));
    await h.server.waitFor('devops.install.local', (m) => m.on === false);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.server.of('devops.install.local').map((m) => m.on)).toEqual([true, false]);
  });

  it('nothing is sent while the choice was never made here', async () => {
    const a = granted();
    h = await startHarness({}, { authority: a.authority, policyDir: a.dir, approvalsPollMs: 50 });
    await new Promise((r) => setTimeout(r, 400));
    expect(h.server.of('devops.install.local')).toEqual([]);
  });
});

describe('REVIEW S2 and S3', () => {
  it('the de-duplicated item reads as the shift it will run, and server text loses control and bidi characters', async () => {
    const agentId = uuidv7();
    const a = granted({ devops: { agents: { [ORG]: agentId } }, devopsRequests: 'ask' });
    h = await startHarness({}, { authority: a.authority, policyDir: a.dir, approvalsPollMs: 50 });
    const first = devopsStart(agentId);
    h.server.send('shift.start', first);
    await h.server.waitFor('approvals.held', (m) => m.items.some((i) => i.kind === 'devops.task'));
    const again: Record<string, any> = { ...devopsStart(agentId, first.devops.requestId), shiftId: uuidv7() };
    again.devops = { ...again.devops, summary: 'restart the app \u202Eexe.txt\u001b[31m' };
    again.agent = { ...again.agent, name: 'Forge\u2066' };
    h.server.send('shift.start', again);
    await h.server.waitFor('shift.accepted', (m) => m.shiftId === again.shiftId);
    await new Promise((r) => setTimeout(r, 300));
    const items = new HeldStore(a.dir).list().filter((r) => r.kind === 'devops.task');
    expect(items).toHaveLength(1);
    expect(items[0]?.summary).toContain('restart the app exe.txt[31m');
    for (const bad of ['\u202E', '\u2066', '\u001b']) expect(items[0]?.summary).not.toContain(bad);
    expect(items[0]?.detail).toContain('restart the app');
    // Rework 2: the multi-line approval text loses them too (line breaks stay)
    for (const bad of ['\u202E', '\u2066', '\u001b']) expect(items[0]?.detail).not.toContain(bad);
    expect(items[0]?.detail).toContain('\n');
  });
});

import { DESK_SUBKIND, ROUTING_EXEMPT_SUBKINDS } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * easy-runner-setup: every approval that still needs the terminal reaches the app as the exact copy-paste command. The
 * runner sends `steps` (and `command` on held items) with `approvals.held`; the server raises one desk notice each (no
 * mail), points the card that waits at it, replaces and closes them with the list, and shows them on the workstation.
 * `hello.local.windowError` raises "Approvals page could not start"; a clean hello closes it.
 */
let w: World;
let r: FakeRunner;
const CLI = 'sudo -u guildwise-runner -H /home/guildwise-runner/.local/bin/guildwise-runner';
const ORG = '0190a000-0000-7000-8000-000000000001';
const AGENT = '0190a000-0000-7000-8000-000000000002';

beforeAll(async () => {
  w = await createWorld();
  r = await FakeRunner.connect(w.baseUrl, w.runnerToken);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const hello = (local?: Record<string, unknown>) =>
  r.send('hello', {
    runnerVersion: '1.10.0',
    protocol: 1,
    platform: 'linux',
    hostname: 'fake-host',
    runtimes: [{ id: 'mock', version: '1', available: true, capabilities: ['shell', 'edit', 'web'] }],
    repos: [],
    vaults: [],
    activeShifts: [],
    outboxPending: 0,
    setupPending: false,
    ...(local ? { local } : {}),
  });

const notices = (subkind: string) =>
  q(
    `SELECT title, body, status, data, affected_card_ids FROM desk_items WHERE subkind=$1 ORDER BY created_at`,
    [subkind],
  );
const ws = async () =>
  (
    await ok<{ workstations: Array<{ id: string; localAuthority: Record<string, unknown> }> }>(
      w.t.req('GET', '/api/workstations', { cookie: w.owner.cookie }),
    )
  ).workstations.find((x) => x.id === w.workstationId);

describe('local steps', () => {
  it('raises a notice with the command, shows it on the workstation, and closes it when the step is gone', async () => {
    hello({ cli: CLI, windowPort: 47613 });
    await r.waitFor('welcome');
    const command = `${CLI} devops grant ${ORG} --agent ${AGENT}`;
    r.send('approvals.held', {
      items: [],
      steps: [
        {
          key: `devops.grant:${ORG}`,
          kind: 'devops.grant',
          summary: "let Acme Law's helper work here",
          command,
        },
      ],
    });
    await until(async () => (await notices('workstation_local_step')).length === 1, 3000, 'notice');
    const [n] = await notices('workstation_local_step');
    expect(n?.data.command).toBe(command);
    expect(n?.body).toContain(command);
    expect(n?.body).toContain('DevOps helper of this organisation');
    const la = (await ws())?.localAuthority;
    expect(la).toMatchObject({ cli: CLI, windowPort: 47613, windowError: null });
    expect((la?.steps as unknown[] | undefined)?.length).toBe(1);
    r.send('approvals.held', { items: [], steps: [] });
    await until(
      async () => (await notices('workstation_local_step')).every((x) => x.status !== 'open'),
      3000,
      'closed',
    );
  });

  it('a held item with a command becomes a notice for the card of its shift; an invalid command is dropped', async () => {
    const card = await q(`SELECT id FROM cards LIMIT 1`);
    const shiftId = '0190a000-0000-7000-8000-0000000000aa';
    if (card[0]) {
      await q(
        `INSERT INTO shifts (id, card_id, agent_id, workstation_id, kind, status, created_at)
         SELECT $1, $2, a.id, $3, 'card', 'running', now() FROM agents a WHERE a.workstation_id=$3 LIMIT 1`,
        [shiftId, card[0].id, w.workstationId],
      ).catch(() => undefined);
    }
    const now = new Date();
    const base = {
      kind: 'deploy.exec',
      summary: 'Deploy the website',
      commandHash: 'a'.repeat(64),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    };
    r.send('approvals.held', {
      items: [
        { ...base, id: 'abcdef1234', command: `${CLI} approve abcdef1234`, shiftId },
        { ...base, id: 'bbbbbb1234', command: `${CLI} approve bbbbbb1234 && curl evil` },
      ],
      steps: [],
    });
    await until(
      async () => (await notices('workstation_local_step')).filter((x) => x.status === 'open').length === 1,
      3000,
      'held notice',
    );
    const open = (await notices('workstation_local_step')).filter((x) => x.status === 'open');
    expect(open[0]?.data.command).toBe(`${CLI} approve abcdef1234`);
    const held = (await ws())?.localAuthority.held as Array<{ id: string; command?: string }>;
    expect(held.find((h) => h.id === 'bbbbbb1234')?.command).toBeUndefined();
    const shift = await q(`SELECT card_id FROM shifts WHERE id=$1`, [shiftId]);
    if (shift[0]) expect(open[0]?.affected_card_ids).toEqual([shift[0].card_id]);
  });
});

describe('T6: a notice the owner closed stays closed while the same held item waits', () => {
  const now = new Date();
  const heldItem = (id: string) => ({
    id,
    kind: 'deploy.exec',
    summary: `Deploy ${id}`,
    commandHash: 'c'.repeat(64),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    command: `${CLI} approve ${id}`,
  });
  const keyed = async (suffix: string) =>
    (await notices('workstation_local_step')).filter((n) => String(n.data.key).endsWith(suffix));
  const dismiss = async (suffix: string) => {
    const open = (await q(
      `SELECT id FROM desk_items WHERE subkind='workstation_local_step' AND status='open' AND data->>'key' LIKE $1`,
      [`%${suffix}`],
    )) as Array<{ id: string }>;
    expect(open).toHaveLength(1);
    await ok(w.t.req('POST', `/api/desk/${open[0]?.id}/dismiss`, { cookie: w.owner.cookie, body: {} }));
  };

  it('closed held A is not re-created by the next approvals.held; a new held B notifies', async () => {
    r.send('approvals.held', { items: [heldItem('aaaaaa7777')], steps: [] });
    await until(async () => (await keyed('held:aaaaaa7777')).length === 1, 3000, 'A notice');
    await dismiss('held:aaaaaa7777');
    // the same item still waits and a new one arrives: the runner reports both (it does on every change and reconnect).
    // Sent one at a time: two lists in flight could be applied out of order (the older one would close B).
    r.send('approvals.held', { items: [heldItem('aaaaaa7777'), heldItem('bbbbbb7777')], steps: [] });
    await until(async () => (await keyed('held:bbbbbb7777')).length === 1, 3000, 'B notice');
    r.send('approvals.held', { items: [heldItem('aaaaaa7777'), heldItem('bbbbbb7777')], steps: [] });
    await until(async () => (await ws())?.localAuthority.held !== undefined, 3000, 'second report applied');
    await new Promise((res) => setTimeout(res, 300));
    const a = await keyed('held:aaaaaa7777');
    expect(a).toHaveLength(1);
    expect(a[0]?.status).not.toBe('open');
    expect((await keyed('held:bbbbbb7777')).map((n) => n.status)).toEqual(['open']);
  });

  it('an owner-closed step that is not a held item comes back while it is still needed', async () => {
    const step = {
      key: `devops.grant:${AGENT}`,
      kind: 'devops.grant',
      summary: 'let the helper work here',
      command: `${CLI} devops grant ${ORG} --agent ${AGENT}`,
    };
    r.send('approvals.held', { items: [], steps: [step] });
    await until(async () => (await keyed(step.key)).some((n) => n.status === 'open'), 3000, 'step notice');
    await dismiss(step.key);
    r.send('approvals.held', { items: [], steps: [step] });
    await until(
      async () => (await keyed(step.key)).filter((n) => n.status === 'open').length === 1,
      3000,
      'again',
    );
  });
});

describe('never held for CEO triage (only the person at the machine can act)', () => {
  it('both workstation notices are exempt from CEO routing, and are not pending triage', async () => {
    expect(ROUTING_EXEMPT_SUBKINDS).toContain(DESK_SUBKIND.workstationLocalStep);
    expect(ROUTING_EXEMPT_SUBKINDS).toContain(DESK_SUBKIND.workstationWindowError);
    const rows = await q(`SELECT triage FROM desk_items WHERE subkind='workstation_local_step'`);
    for (const r of rows) expect(r.triage).not.toBe('pending');
  });
});

describe('approvals page could not start', () => {
  it('hello.local.windowError raises the Desk notice; a clean hello closes it', async () => {
    r.close();
    r = await FakeRunner.connect(w.baseUrl, w.runnerToken);
    hello({ cli: CLI, windowError: 'another program uses port 47613' });
    await r.waitFor('welcome');
    await until(async () => (await notices('workstation_window_error')).length === 1, 3000, 'window notice');
    const [n] = await notices('workstation_window_error');
    expect(n?.title).toMatch(/^Approvals page could not start on /);
    expect(n?.body).toContain('another program uses port 47613');
    expect(n?.body).toContain(`${CLI} approvals port <new port>`);
    expect((await ws())?.localAuthority).toMatchObject({
      windowPort: null,
      windowError: 'another program uses port 47613',
    });
    r.close();
    r = await FakeRunner.connect(w.baseUrl, w.runnerToken);
    hello({ cli: CLI, windowPort: 47613 });
    await r.waitFor('welcome');
    await until(
      async () => (await notices('workstation_window_error')).every((x) => x.status !== 'open'),
      3000,
      'window notice closed',
    );
  });
});

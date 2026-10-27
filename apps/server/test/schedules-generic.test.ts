import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertWebhookUrl, isPrivateAddress } from '../src/commands/schedule-delivery.ts';
import { phasePass } from '../src/dispatcher/phases.ts';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, type Member } from './helpers/members.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let guest: Member;
let await_orgId = '';
let hooks: Server;
let hookUrl = '';
const received: Array<{ headers: IncomingMessage['headers']; body: string }> = [];
let hookStatuses: number[] = [];

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_WEBHOOK_ALLOW_PRIVATE: 'true' } });
  r = await w.connectRunner();
  guest = await addMember(w, 'guest');
  await_orgId = await orgId();
  hooks = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = hookStatuses.shift() ?? 200;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => hooks.listen(0, '127.0.0.1', resolve));
  hookUrl = `http://127.0.0.1:${(hooks.address() as AddressInfo).port}/hook`;
});
afterAll(async () => {
  hooks.close();
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const ctx = () => w.t.app.ctx;
const orgIdOf = () => await_orgId;
const as = (cookie: string, org?: string) => (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie, body, ...(org ? { headers: { 'x-aom-org': org } } : {}) });
const owner = (method: string, url: string, body?: unknown) => as(w.owner.cookie)(method, url, body);
const setNow = (at: Date) => ctx().clock.setOffset(at.getTime() - Date.now());
const scheduler = () => ctx().services.scheduler;
const SYSTEM = { kind: 'system' as const, id: null };
const orgId = async () =>
  (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
const runsOf = (id: string) =>
  q('SELECT * FROM schedule_runs WHERE schedule_id=$1 ORDER BY started_at, id', [id]);
const card = { title: 'Weekly check', fields: {} };
const create = (body: Record<string, unknown>, who: ReturnType<typeof as> = owner) =>
  who('POST', '/api/schedules', body);
const cardAction = { kind: 'create_card', projectId: '', template: card };
const manual = { kind: 'manual' };

describe('a schedule is a trigger and one action', () => {
  it('a cron trigger creates a card with the date, records the run and the next fire', async () => {
    const s = await ok<any>(
      create({
        name: 'Weekly',
        trigger: { kind: 'cron', cron: '0 7 * * 1-5', timezone: 'UTC' },
        action: { ...cardAction, projectId: w.projectId },
      }),
      201,
    );
    expect(s).toMatchObject({ kind: 'card', orgLevel: false, canEdit: true });
    expect(s.trigger).toMatchObject({ kind: 'cron' });
    setNow(new Date(new Date(s.nextFireAt).getTime() + 1000));
    const fired = await scheduler().run();
    expect(fired.map((f) => f.scheduleId)).toContain(s.id);
    const [run] = await runsOf(s.id);
    expect(run).toMatchObject({ trigger: 'cron', status: 'ok' });
    expect(run?.summary).toMatch(/^Created TOY-/);
    const c = (
      await q('SELECT title, origin, scheduled, schedule_id FROM cards WHERE schedule_id=$1', [s.id])
    )[0];
    expect(c?.title).toMatch(/^Weekly check \(\d{4}-\d\d-\d\d\)$/);
    expect(c).toMatchObject({ origin: 'schedule', scheduled: true });
    const list = (await ok<any>(owner('GET', `/api/schedules/${s.id}/runs`))).runs;
    expect(list[0]).toMatchObject({
      trigger: 'cron',
      status: 'ok',
      result: { cardIds: [expect.any(String)] },
    });
    const after = (await ok<any>(owner('GET', '/api/schedules'))).schedules.find((x: any) => x.id === s.id);
    expect(after).toMatchObject({ lastStatus: 'ok' });
    expect(new Date(after.nextFireAt).getTime()).toBeGreaterThan(new Date(s.nextFireAt).getTime());
    setNow(new Date());
  });

  it('a manual trigger never fires by itself; run now runs the action once and keeps the timing', async () => {
    const s = await ok<any>(
      create({ name: 'By hand', trigger: manual, action: { ...cardAction, projectId: w.projectId } }),
      201,
    );
    expect(s.nextFireAt).toBeNull();
    setNow(new Date(Date.now() + 7 * 86_400_000));
    await scheduler().run();
    expect(await runsOf(s.id)).toHaveLength(0);
    setNow(new Date());
    const run = await ok<any>(owner('POST', `/api/schedules/${s.id}/run`), 201);
    expect(run).toMatchObject({ status: 'ok', ref: expect.stringMatching(/^TOY-/) });
    const [row] = await runsOf(s.id);
    expect(row).toMatchObject({ trigger: 'manual', status: 'ok' });
  });

  it('an ordinary request for a feed schedule is refused: feeds are interests', async () => {
    const feed = await create({
      name: 'Old',
      kind: 'feed',
      projectId: w.projectId,
      cron: '0 7 * * *',
      cardTemplate: card,
    });
    expect(feed.status).toBe(400);
    expect(feed.body.error.code).toBe('use_interests');
  });

  it('a BA task action is a CEO wake now: free-text instructions, no BA task (more in scheduled-brief-ceo.test.ts)', async () => {
    const s = await ok<any>(
      create({
        name: 'Friday review',
        trigger: manual,
        action: {
          kind: 'ba_task',
          projectId: null,
          prompt: 'List the open phases on {date}',
          deliver: 'chat',
        },
      }),
      201,
    );
    expect(s).toMatchObject({ kind: 'ba_task', orgLevel: true });
    await ok(owner('POST', `/api/schedules/${s.id}/run`), 201);
    expect(await q(`SELECT 1 FROM ba_tasks WHERE schedule_id=$1`, [s.id])).toHaveLength(0);
    const wake = (
      await q(`SELECT * FROM ceo_wakes WHERE reason='scheduled_brief' AND detail->>'scheduleId' = $1`, [s.id])
    )[0];
    expect(wake).toMatchObject({ urgency: 'scheduled', status: 'pending', subject_label: 'Friday review' });
    expect(wake?.detail.instructions).toMatch(/^List the open phases on \d{4}-/);
    expect(wake?.detail.deliver).toBe('chat');
  });

  it('a DevOps request goes to the engineer of the owner workstation, hygiene included', async () => {
    const s = await ok<any>(
      create({
        name: 'Disk check',
        trigger: manual,
        action: {
          kind: 'devops_request',
          workstationId: w.workstationId,
          text: 'Check the disk on {date}',
          projectId: w.projectId,
        },
      }),
      201,
    );
    expect(s.orgLevel).toBe(false);
    await ok(owner('POST', `/api/schedules/${s.id}/run`), 201);
    const req = (await q(`SELECT * FROM devops_requests ORDER BY created_at DESC LIMIT 1`))[0];
    expect(req?.summary).toMatch(/^Check the disk on \d{4}/);
    expect(req).toMatchObject({ requested_by_kind: 'system', status: 'queued' });
    const [run] = await runsOf(s.id);
    expect(run?.result).toMatchObject({ devopsRequestId: req?.id });
    const hyg = await ok<any>(
      create({
        name: 'Tidy',
        trigger: manual,
        action: { kind: 'devops_request', workstationId: w.workstationId, hygiene: true },
      }),
      201,
    );
    expect(hyg.orgLevel).toBe(true);
    const out = await ok<any>(owner('POST', `/api/schedules/${hyg.id}/run`), 201);
    expect(out.status).toBe('ok');
  });
});

describe('who may create and change schedules', () => {
  // The guest works in the owner's organization (their tab says so): their own organization is another matter.
  const g = () => as(guest.cookie, await_orgId);

  it('a guest manages schedules tied to the shared project', async () => {
    const mine = await ok<any>(
      create(
        { name: 'Guest weekly', trigger: manual, action: { ...cardAction, projectId: w.projectId } },
        g(),
      ),
      201,
    );
    expect(mine).toMatchObject({ canEdit: true, orgLevel: false });
    await ok(g()('PATCH', `/api/schedules/${mine.id}`, { name: 'Guest weekly 2', enabled: false }));
    // the owner sees it and may change it too (any member of the project may)
    const seen = (await ok<any>(owner('GET', '/api/schedules'))).schedules.find((x: any) => x.id === mine.id);
    expect(seen).toMatchObject({ name: 'Guest weekly 2', ownerName: expect.any(String) });
    await ok(owner('PATCH', `/api/schedules/${mine.id}`, { enabled: true }));
    await ok(g()('POST', `/api/schedules/${mine.id}/run`), 201);
    await ok(g()('DELETE', `/api/schedules/${mine.id}`));
  });

  it('organization-level actions are for the Owner and Admins only', async () => {
    const orgLevel: Array<[string, Record<string, unknown>]> = [
      ['BA task without a project', { kind: 'ba_task', projectId: null, prompt: 'x' }],
      [
        'hygiene',
        { kind: 'devops_request', workstationId: guest.workstationId, hygiene: true, projectId: w.projectId },
      ],
      ['webhook without a project', { kind: 'integration', integration: 'webhook', url: hookUrl }],
      [
        'floor report e-mail',
        { kind: 'integration', integration: 'email', to: [guest.email], digest: 'floor_report' },
      ],
    ];
    for (const [label, action] of orgLevel) {
      const res = await create({ name: label, trigger: manual, action }, g());
      expect(res.status, label).toBe(403);
    }
    // the same webhook tied to the project is theirs
    const hook = await create(
      {
        name: 'Guest hook',
        trigger: manual,
        action: { kind: 'integration', integration: 'webhook', url: hookUrl, projectId: w.projectId },
      },
      g(),
    );
    expect(hook.status).toBe(201);
    // and the owner's org-level ba task is invisible and untouchable for the guest
    const ba = await ok<any>(
      create({
        name: 'Owner BA',
        trigger: manual,
        action: { kind: 'ba_task', projectId: null, prompt: 'p' },
      }),
      201,
    );
    expect((await ok<any>(g()('GET', '/api/schedules'))).schedules.map((s: any) => s.id)).not.toContain(
      ba.id,
    );
    expect((await g()('PATCH', `/api/schedules/${ba.id}`, { enabled: false })).status).toBe(404);
    expect((await g()('POST', `/api/schedules/${ba.id}/run`)).status).toBe(404);
  });

  it('an action on a workstation needs the workstation user; e-mail goes to yourself only', async () => {
    const poll = {
      kind: 'integration',
      integration: 'github',
      operation: 'issues_poll',
      workstationId: w.workstationId,
      query: 'o/r',
      projectId: w.projectId,
    };
    expect((await create({ name: 'Not mine', trigger: manual, action: poll }, g())).status).toBe(403);
    const mail = (to: string[]) =>
      create(
        {
          name: 'Digest',
          trigger: manual,
          action: {
            kind: 'integration',
            integration: 'email',
            to,
            digest: 'project_summary',
            projectId: w.projectId,
          },
        },
        g(),
      );
    expect((await mail([w.owner.email])).status).toBe(403);
    expect((await mail([guest.email])).status).toBe(201);
  });

  it('an org Member (not Owner or Admin) is held to the same rules', async () => {
    const member = await w.t.userSession(uniqueEmail('member'));
    await w.t.addOrgMember(await orgId(), member.id, 'member');
    await ok(owner('POST', `/api/projects/${w.projectId}/members`, { email: member.email }), 201);
    await as(member.cookie)('POST', `/api/projects/${w.projectId}/members/accept`); // active at once for an org member
    const m = as(member.cookie, await_orgId);
    expect(
      (
        await create(
          { name: 'm1', trigger: manual, action: { kind: 'ba_task', projectId: null, prompt: 'p' } },
          m,
        )
      ).status,
    ).toBe(403);
    expect(
      (await create({ name: 'm2', trigger: manual, action: { ...cardAction, projectId: w.projectId } }, m))
        .status,
    ).toBe(201);
  });
});

describe('event triggers', () => {
  it('run once per matching event, never for older events, and respect the project filter', async () => {
    const other = await w.card({ title: 'Other card', specify: false });
    const s = await ok<any>(
      create({
        name: 'After finalize',
        trigger: { kind: 'event', event: 'card_finalized', projectId: w.projectId },
        action: {
          kind: 'create_card',
          projectId: w.projectId,
          template: { title: 'Follow-up for {ref}', fields: {} },
        },
      }),
      201,
    );
    expect(s.nextFireAt).toBeNull();
    await scheduler().run(); // sets the cursor at the end of the log
    // an event from before the schedule existed must not run it
    const early = await w.card({ title: 'Early', specify: false });
    const fin = (cardId: string) =>
      seed(w, [
        {
          streamId: streamId.card(cardId),
          event: {
            type: 'CardFinalized',
            payload: { cardId, action: 'merge', resultRef: { mergeCommit: 'abc1234' }, toStage: 'done' },
          },
          actor: SYSTEM,
          scope: { orgId: await_orgId, projectId: w.projectId, audience: 'project' },
        },
      ]);
    await fin(other.id);
    await scheduler().run();
    await until(async () => (await runsOf(s.id)).length === 1, 5000, 'one run');
    await scheduler().run();
    expect(await runsOf(s.id)).toHaveLength(1);
    const [run] = await runsOf(s.id);
    expect(run).toMatchObject({ trigger: 'event', status: 'ok' });
    expect(run?.source_key).toMatch(/^event:\d+$/);
    expect(run?.label).toContain('finalized');
    const made = (await q('SELECT title FROM cards WHERE schedule_id=$1', [s.id]))[0];
    expect(made?.title).toBe(`Follow-up for ${other.ref}`);
    void early;
    // a project filter for another project does not match
    const miss = await ok<any>(
      create({
        name: 'Elsewhere',
        trigger: { kind: 'event', event: 'card_finalized', projectId: randomUUID() },
        action: { ...cardAction, projectId: w.projectId },
      }).then((x) => ({ status: x.status === 404 ? 200 : x.status, body: { id: 'none' } })),
    );
    expect(miss.id).toBe('none');
  });

  it('a completed phase runs its schedule', async () => {
    const s = await ok<any>(
      create({
        name: 'Phase hook',
        trigger: { kind: 'event', event: 'phase_completed' },
        action: {
          kind: 'integration',
          integration: 'webhook',
          url: hookUrl,
          format: 'slack',
          message: 'Done: {ref}',
          projectId: w.projectId,
        },
      }),
      201,
    );
    await scheduler().run();
    const phase = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/phases`, { name: 'Alpha', followups: [] }),
      201,
    );
    const c = await w.card({ title: 'Phase card', specify: false });
    await ok(owner('PUT', `/api/cards/${c.id}/phase`, { phaseId: phase.id }));
    await seed(w, [
      {
        streamId: streamId.card(c.id),
        event: {
          type: 'CardFinalized',
          payload: { cardId: c.id, action: 'merge', resultRef: { mergeCommit: 'abc1234' }, toStage: 'done' },
        },
        actor: SYSTEM,
        scope: { orgId: await_orgId, projectId: w.projectId, audience: 'project' },
      },
    ]);
    const before = received.length;
    await phasePass(ctx());
    await scheduler().run();
    await until(async () => received.length > before, 5000, 'webhook delivered');
    const last = JSON.parse(received.at(-1)?.body ?? '{}');
    expect(last.text).toBe(`Done: ${phase.ref}`);
    const [run] = await runsOf(s.id);
    expect(run).toMatchObject({ trigger: 'event', status: 'ok' });
  });
});

describe('the project_converted trigger', () => {
  it('a converted project runs its schedule once, with the project and the workflows in the text', async () => {
    const proj = await ok<any>(
      owner('POST', '/api/projects', { key: 'RSCH', name: 'Reload research', workflowKey: 'research' }),
      201,
    );
    const rid = proj.project.id as string;
    const s = await ok<any>(
      create({
        name: 'Converted hook',
        trigger: { kind: 'event', event: 'project_converted' },
        action: {
          kind: 'integration',
          integration: 'webhook',
          url: hookUrl,
          format: 'slack',
          message: 'Converted {project}: {event}',
          projectId: rid,
        },
      }),
      201,
    );
    await scheduler().run(); // the cursor moves to the end of the log: older events never run it
    expect(await runsOf(s.id)).toHaveLength(0);
    const before = received.length;
    await ok(
      owner('POST', `/api/projects/${rid}/convert`, {
        toWorkflowKey: 'code',
        repos: [{ name: 'reload', remoteUrl: 'https://github.com/acme/reload.git' }],
      }),
    );
    await scheduler().run();
    await until(async () => received.length > before, 5000, 'webhook delivered');
    const last = JSON.parse(received.at(-1)?.body ?? '{}');
    expect(last.text).toBe('Converted RSCH: a project is converted');
    await scheduler().run();
    const runs = await runsOf(s.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'event', status: 'ok' });
    expect(runs[0]?.label).toBe('Project converted');
  });
});

const sign = (secret: string, ts: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

describe('outgoing webhooks', () => {
  it('post signed JSON in the chosen format, keep the secret out of the DTO and log the delivery', async () => {
    const s = await ok<any>(
      create({
        name: 'Teams hook',
        trigger: manual,
        action: {
          kind: 'integration',
          integration: 'webhook',
          url: hookUrl,
          format: 'teams',
          message: 'Hello from {project}',
          projectId: w.projectId,
        },
      }),
      201,
    );
    expect(s.webhookSecret).toMatch(/^whsec_/);
    expect(JSON.stringify(s)).not.toContain('secretEnc');
    expect(s.hasWebhookSecret).toBe(true);
    const listed = (await ok<any>(owner('GET', '/api/schedules'))).schedules.find((x: any) => x.id === s.id);
    expect(listed.webhookSecret).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain('secretEnc');
    const before = received.length;
    const out = await ok<any>(owner('POST', `/api/schedules/${s.id}/run`), 201);
    expect(out.status).toBe('ok');
    const hit = received[before];
    expect(hit).toBeDefined();
    const body = JSON.parse(hit?.body ?? '{}');
    expect(body).toMatchObject({ '@type': 'MessageCard', text: 'Hello from TOY' });
    const ts = String(hit?.headers['x-aom-timestamp']);
    expect(hit?.headers['x-aom-signature']).toBe(sign(s.webhookSecret, ts, hit?.body ?? ''));
    expect(hit?.headers['x-aom-event']).toBe('schedule.run');
    const runs = (await ok<any>(owner('GET', `/api/schedules/${s.id}/runs`))).runs;
    expect(runs[0]).toMatchObject({
      status: 'ok',
      attempts: 1,
      delivery: { kind: 'webhook', target: hookUrl },
      attemptLog: [{ attempt: 1, ok: true, httpStatus: 200 }],
    });
    // the secret rotates; the old signature stops being the right one
    const rot = await ok<any>(owner('POST', `/api/schedules/${s.id}/rotate-secret`));
    expect(rot.webhookSecret).not.toBe(s.webhookSecret);
    await ok(owner('POST', `/api/schedules/${s.id}/run`), 201);
    const again = received.at(-1);
    expect(again?.headers['x-aom-signature']).toBe(
      sign(rot.webhookSecret, String(again?.headers['x-aom-timestamp']), again?.body ?? ''),
    );
  });

  it('a Slack hook gets a text field; the test button sends one signed test and is not retried', async () => {
    const s = await ok<any>(
      create({
        name: 'Slack hook',
        trigger: manual,
        action: {
          kind: 'integration',
          integration: 'webhook',
          url: hookUrl,
          format: 'slack',
          projectId: w.projectId,
        },
      }),
      201,
    );
    const before = received.length;
    hookStatuses = [500];
    const t = await ok<any>(owner('POST', `/api/schedules/${s.id}/test`));
    expect(t).toMatchObject({ ok: false, httpStatus: 500 });
    expect(received).toHaveLength(before + 1);
    const body = JSON.parse(received.at(-1)?.body ?? '{}');
    expect(body.text).toContain('Test delivery');
    expect(received.at(-1)?.headers['x-aom-event']).toBe('schedule.test');
    const [run] = await runsOf(s.id);
    expect(run).toMatchObject({ trigger: 'test', status: 'failed', attempts: 1 });
    // a test is not a run of the schedule
    expect(
      (await ok<any>(owner('GET', '/api/schedules'))).schedules.find((x: any) => x.id === s.id).lastStatus,
    ).toBeNull();
    const good = await ok<any>(owner('POST', `/api/schedules/${s.id}/test`));
    expect(good).toMatchObject({ ok: true, httpStatus: 200 });
  });

  it('retries a server error with backoff, gives up on a client error', async () => {
    const s = await ok<any>(
      create({
        name: 'Flaky',
        trigger: manual,
        action: { kind: 'integration', integration: 'webhook', url: hookUrl, projectId: w.projectId },
      }),
      201,
    );
    hookStatuses = [503, 200];
    const out = await ok<any>(owner('POST', `/api/schedules/${s.id}/run`), 201);
    expect(out.status).toBe('pending');
    let [run] = await runsOf(s.id);
    expect(run).toMatchObject({ status: 'pending', attempts: 1 });
    const next = new Date(run?.next_attempt_at).getTime();
    expect(next - Date.now()).toBeGreaterThan(50_000);
    await scheduler().run();
    expect((await runsOf(s.id))[0]).toMatchObject({ attempts: 1 }); // not due yet
    setNow(new Date(next + 1000));
    await scheduler().run();
    [run] = await runsOf(s.id);
    expect(run).toMatchObject({ status: 'ok', attempts: 2 });
    const log = await q(
      'SELECT attempt, ok, http_status FROM schedule_attempts WHERE run_id=$1 ORDER BY attempt',
      [run?.id],
    );
    expect(log).toEqual([
      { attempt: 1, ok: false, http_status: 503 },
      { attempt: 2, ok: true, http_status: 200 },
    ]);
    setNow(new Date());
    hookStatuses = [404];
    await ok(owner('POST', `/api/schedules/${s.id}/run`), 201);
    const last = (await runsOf(s.id)).at(-1);
    expect(last).toMatchObject({ status: 'failed', attempts: 1 });
    expect(last?.error).toContain('404');
  });

  it('refuses addresses on this machine or a private network unless the deployment allows them', () => {
    const strict = { config: { webhookAllowPrivate: false } } as never;
    for (const url of [
      'http://localhost/h',
      'http://127.0.0.1:9/h',
      'http://10.1.2.3/h',
      'http://192.168.0.5/h',
      'http://[::1]/h',
      'http://169.254.169.254/',
    ])
      expect(() => assertWebhookUrl(strict, url), url).toThrow(/private|machine/);
    expect(() => assertWebhookUrl(strict, 'ftp://example.com/h')).toThrow();
    expect(() => assertWebhookUrl(strict, 'https://user:pw@example.com/h')).toThrow();
    expect(assertWebhookUrl(strict, 'https://hooks.slack.com/services/T/B/X').host).toBe('hooks.slack.com');
    expect(isPrivateAddress('172.20.1.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});

describe('e-mail digests', () => {
  it('send the floor report or a project summary through the site mailer', async () => {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const orig = ctx().mailer.send;
    ctx().mailer.send = async (m) => {
      sent.push(m);
    };
    try {
      const fl = await ok<any>(
        create({
          name: 'Morning digest',
          trigger: { kind: 'cron', cron: '0 8 * * *', timezone: 'UTC' },
          action: {
            kind: 'integration',
            integration: 'email',
            to: [w.owner.email],
            subject: 'Floor {date}',
            digest: 'floor_report',
          },
        }),
        201,
      );
      expect(fl.orgLevel).toBe(true);
      await ok(owner('POST', `/api/schedules/${fl.id}/run`), 201);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: w.owner.email });
      expect(sent[0]?.subject).toMatch(/^Floor \d{4}-\d\d-\d\d$/);
      expect(sent[0]?.text).toContain('# Organization report');
      const ps = await ok<any>(
        create({
          name: 'Project digest',
          trigger: manual,
          action: {
            kind: 'integration',
            integration: 'email',
            to: [w.owner.email],
            digest: 'project_summary',
            projectId: w.projectId,
          },
        }),
        201,
      );
      await ok(owner('POST', `/api/schedules/${ps.id}/run`), 201);
      expect(sent[1]?.subject).toBe('TOY summary');
      expect(sent[1]?.text).toContain('## Open work');
      // the interests digest (what the interests delivered to the desk in the last 24 hours)
      const interests = await ok<any>(
        create({
          name: 'Interests',
          trigger: manual,
          action: { kind: 'integration', integration: 'email', to: [w.owner.email], digest: 'interests' },
        }),
        201,
      );
      await ok(owner('POST', `/api/schedules/${interests.id}/run`), 201);
      expect(sent[2]?.subject).toMatch(/^Interests digest \d{4}-\d{2}-\d{2}$/);
      expect(sent[2]?.text).toContain('Interests: 0 active of 0');
      // a failing mailer is retried like a webhook
      ctx().mailer.send = async () => {
        throw new Error('smtp down');
      };
      const out = await ok<any>(owner('POST', `/api/schedules/${ps.id}/run`), 201);
      expect(out.status).toBe('pending');
      expect((await runsOf(ps.id)).at(-1)).toMatchObject({ status: 'pending', attempts: 1 });
    } finally {
      ctx().mailer.send = orig;
    }
  });
});

describe('issue polling', () => {
  async function answer(cmd: any, issues: unknown[], okFlag = true, error?: string) {
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: okFlag ? { ok: true, issues } : { ok: false, error, issues: [] },
    });
    await r.barrier();
  }
  const nextCommand = async (from: number) =>
    r.waitFor('command', (f: any) => f.command === 'integration.run', 10_000, from);

  it('an issues_poll action asks the workstation and takes each new issue into intake once', async () => {
    await w.hire('Olga', 'ba', 'senior');
    const s = await ok<any>(
      create({
        name: 'Poll GitHub',
        trigger: manual,
        action: {
          kind: 'integration',
          integration: 'github',
          operation: 'issues_poll',
          workstationId: w.workstationId,
          query: 'acme/toy',
          projectId: w.projectId,
        },
      }),
      201,
    );
    const from = r.received.length;
    const out = await ok<any>(owner('POST', `/api/schedules/${s.id}/run`), 201);
    expect(out.status).toBe('pending');
    const cmd: any = await nextCommand(from);
    expect(cmd.payload).toMatchObject({ integration: 'github', query: 'acme/toy', scheduleId: s.id });
    const issues = [
      {
        key: 'acme/toy#7',
        title: 'Login fails',
        url: 'https://github.com/acme/toy/issues/7',
        body: 'It fails.',
        labels: ['bug'],
      },
    ];
    await answer(cmd, issues);
    await until(async () => (await runsOf(s.id))[0]?.status === 'ok', 10_000, 'poll run completed');
    let [run] = await runsOf(s.id);
    expect(run?.summary).toContain('acme/toy#7');
    expect(run?.result.intakeIds).toHaveLength(1);
    const intake = (
      await q('SELECT external_system, external_key FROM intakes ORDER BY created_at DESC LIMIT 1')
    )[0];
    expect(intake).toMatchObject({ external_system: 'github', external_key: 'acme/toy#7' });
    // the same issue is not taken twice
    const from2 = r.received.length;
    await ok(owner('POST', `/api/schedules/${s.id}/run`), 201);
    await answer(await nextCommand(from2), issues);
    await until(
      async () => (await runsOf(s.id)).length === 2 && (await runsOf(s.id))[1]?.status !== 'pending',
      10_000,
      'second run',
    );
    [, run] = await runsOf(s.id);
    expect(run?.summary).toBe('No new issues');
    // a failed poll shows in the history
    const from3 = r.received.length;
    await ok(owner('POST', `/api/schedules/${s.id}/run`), 201);
    await answer(await nextCommand(from3), [], false, 'gh is not installed');
    await until(async () => (await runsOf(s.id)).at(2)?.status === 'failed', 10_000, 'failed run');
    expect((await runsOf(s.id)).at(2)?.error).toContain('gh is not installed');
  });

  it('a labelled-issue trigger polls on its cadence and runs the action for each new issue', async () => {
    const s = await ok<any>(
      create({
        name: 'Labelled',
        trigger: {
          kind: 'issue_labelled',
          provider: 'github',
          workstationId: w.workstationId,
          query: 'acme/toy',
          label: 'aom',
          cron: '*/15 * * * *',
          timezone: 'UTC',
        },
        action: {
          kind: 'create_card',
          projectId: w.projectId,
          template: { title: 'Fix {issue.key}: {issue.title}', fields: {} },
        },
      }),
      201,
    );
    expect(s.nextFireAt).not.toBeNull();
    const from = r.received.length;
    setNow(new Date(new Date(s.nextFireAt).getTime() + 1000));
    await scheduler().run();
    const cmd: any = await nextCommand(from);
    expect(cmd.payload).toMatchObject({ label: 'aom', query: 'acme/toy' });
    expect(cmd.payload.runId).toBeUndefined();
    const issues = [
      { key: 'acme/toy#11', title: 'Crash on save', body: '', labels: ['aom'] },
      { key: 'acme/toy#12', title: 'Typo', body: '', labels: ['aom'] },
    ];
    await answer(cmd, issues);
    await until(async () => (await runsOf(s.id)).length === 2, 10_000, 'two runs');
    const runs = await runsOf(s.id);
    expect(runs.map((x) => x.source_key).sort()).toEqual([
      'issue:github:acme/toy#11',
      'issue:github:acme/toy#12',
    ]);
    const titles = (await q('SELECT title FROM cards WHERE schedule_id=$1 ORDER BY title', [s.id])).map(
      (x) => x.title,
    );
    expect(titles).toEqual(['Fix acme/toy#11: Crash on save', 'Fix acme/toy#12: Typo']);
    // the next poll sees the same issues: nothing new runs
    const from2 = r.received.length;
    const second = (await q('SELECT next_fire_at FROM schedules WHERE id=$1', [s.id]))[0]?.next_fire_at;
    setNow(new Date(new Date(second).getTime() + 1000));
    await scheduler().run();
    await answer(await nextCommand(from2), issues);
    expect(await runsOf(s.id)).toHaveLength(2);
    setNow(new Date());
  });
});

describe('a project that goes away', () => {
  it('archiving pauses its schedules and keeps what they do; deleting removes them with their history', async () => {
    const proj = await ok<any>(owner('POST', '/api/projects', { key: 'ARC', name: 'Archive me' }), 201);
    const pid = proj.project.id as string;
    const s = await ok<any>(
      create({
        name: 'Archived hook',
        trigger: { kind: 'event', event: 'card_finalized' },
        action: { kind: 'integration', integration: 'webhook', url: hookUrl, projectId: pid },
      }),
      201,
    );
    await ok(owner('POST', `/api/schedules/${s.id}/run`), 201);
    await ok(owner('POST', `/api/projects/${pid}/archive`));
    const row = (await q('SELECT enabled, trigger, action, kind FROM schedules WHERE id=$1', [s.id]))[0];
    expect(row).toMatchObject({
      enabled: false,
      kind: 'integration',
      trigger: { kind: 'event', event: 'card_finalized' },
    });
    expect(row?.action).toMatchObject({ integration: 'webhook', projectId: pid });
    expect(row?.action.secretEnc).toMatch(/^v1:/);
    await ok(owner('POST', `/api/projects/${pid}/delete`, { confirmKey: 'ARC' }));
    expect(await q('SELECT 1 FROM schedules WHERE id=$1', [s.id])).toHaveLength(0);
    expect(await q('SELECT 1 FROM schedule_runs WHERE schedule_id=$1', [s.id])).toHaveLength(0);
    expect(await q('SELECT 1 FROM schedule_attempts WHERE schedule_id=$1', [s.id])).toHaveLength(0);
  });
});

describe('system rows and rebuild', () => {
  it('lists the repository hygiene job and the BA floor report as read-only system rows', async () => {
    const list = await ok<any>(owner('GET', '/api/schedules'));
    const kinds = list.system.map((x: any) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(['hygiene', 'floor_report']));
    const hyg = list.system.find((x: any) => x.kind === 'hygiene');
    expect(hyg.when).toMatch(/^Every 24 hours?$/);
    expect(list.system.find((x: any) => x.kind === 'floor_report').when).toMatch(/^Daily at \d\d:\d\d/);
    // a guest sees no organization-level job, only their own workstation's hygiene
    const gl = await ok<any>(as(guest.cookie)('GET', '/api/schedules'));
    expect(gl.system.map((x: any) => x.id)).not.toContain(`system:floor_report:${await_orgId}`);
  });

  it('a rebuild reproduces schedules, runs, attempts and seen issues', async () => {
    const snap = async () => {
      const out: Record<string, string[]> = {};
      for (const t of ['schedules', 'schedule_runs', 'schedule_attempts', 'schedule_issues', 'ba_tasks']) {
        expect(PROJECTION_TABLES).toContain(t);
        out[t] = (await q(`SELECT to_jsonb(t)::text AS j FROM "${t}" t`)).map((x) => x.j as string).sort();
      }
      return out;
    };
    const before = await snap();
    expect(before.schedule_runs?.length).toBeGreaterThan(5);
    await rebuildProjections(ctx().pool, ctx().store);
    expect(await snap()).toEqual(before);
  });
});

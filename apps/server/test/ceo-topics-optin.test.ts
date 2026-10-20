import { randomUUID } from 'node:crypto';
import { DIAGNOSTICS_CONSENT_VERSION } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptTopic, noteSignals, proposeTopic } from '../src/ceo/topics.ts';
import { sweepTopics } from '../src/ceo/topics-handoff.ts';
import { appoint, ceo, graduate, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Customer organizations (docs/design/ceo-blog-topics.md section 11): nothing is collected, proposed or handed on unless the
 * Owner switched "Share diagnostic data with Guildwise" on; every batch is the Owner's to answer; the platform side never
 * learns who a topic came from; at most 4 a month; turning the consent off withdraws what the writer has not taken.
 */
let w: World;
let r: FakeRunner;
let orgId: string;
let ceoId: string;
let shiftId: string;
let admin: { id: string; cookie: string };

const ctx = () => w.t.app.ctx;
const cfg = () => ctx().config as { diagnosticsConsentForCustomers: boolean };
const system = { kind: 'system', id: null } as const;
const candidates = (where = '') =>
  q(`SELECT * FROM ceo_topic_candidates WHERE org_id=$1 ${where} ORDER BY created_at, id`, [orgId]);

let n = 0;
const A = ['bran', 'cole', 'dun', 'fen', 'gar', 'hol', 'jan', 'kel', 'lor', 'mon'];
const B = ['ding', 'ster', 'ment', 'lock', 'wick', 'field', 'ford', 'gate', 'ward', 'port'];
const fresh = () => {
  const i = n++;
  return `${A[i % 10]}${B[Math.floor(i / 10) % 10]}${'s'.repeat(Math.floor(i / 100))}`;
};
const question = () =>
  `How can teams ${fresh()} ${fresh()} ${fresh()} when ${fresh()} ${fresh()} ${fresh()} keep changing?`;

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, headers: { 'x-aom-org': orgId }, body });
const setSharing = (on: boolean) =>
  owner('PATCH', '/api/org', {
    diagnosticsSharing: on,
    ...(on ? { consentVersion: DIAGNOSTICS_CONSENT_VERSION } : {}),
  });
const propose = (text: string, area = 'deploy') =>
  proposeTopic(ctx(), orgId, ceoId, { question: text, area, from: [] }, randomUUID());

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  ceoId = await appoint(w);
  await graduate(w);
  orgId = w.owner.id;
  await wakeNow(w);
  shiftId = (await startCeoShift(w, r)).shiftId;
  admin = await w.t.userSession(`admin-${randomUUID().slice(0, 6)}@example.com`);
  await w.t.addOrgMember(orgId, admin.id, 'admin');
  cfg().diagnosticsConsentForCustomers = true;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await q('DELETE FROM ceo_topic_candidates');
  await q(`DELETE FROM ceo_offboard_jobs`);
});

describe('sharing off (the default)', () => {
  it('collects nothing, and the topic verb answers sharing_off', async () => {
    await ctx().store.append([
      {
        streamId: `ceo-${orgId}`,
        event: {
          type: 'CeoOffboardJobLogged',
          payload: {
            jobId: randomUUID(),
            orgId,
            kind: 'rotate-certs',
            title: 'Rotate the certificates by hand',
            summary: '',
            costMicros: 0,
            durationMs: 1000,
            auto: false,
          },
        } as any,
        actor: system,
        scope: { orgId, projectId: null, audience: 'org' },
      },
    ]);
    expect(await noteSignals(ctx(), orgId)).toBe(0);
    await sweepTopics(ctx(), new Date(ctx().clock.now().getTime() + 10 * 60_000));
    expect(await candidates()).toHaveLength(0);

    const resp = await ceo(r, shiftId, {
      op: 'topic',
      sub: 'propose',
      question: question(),
      area: 'deploy',
      from: [],
    });
    expect(resp.ok).toBe(true);
    expect(resp.result).toMatchObject({ status: 'refused', code: 'sharing_off' });
    expect(resp.result.message).toContain('sharing_off');
    expect(await candidates()).toHaveLength(0);

    const api = await ok<any>(owner('GET', '/api/ceo/topics'));
    expect(api).toMatchObject({ enabled: false, reason: 'sharing_off', topics: [] });
  });

  it('an Accept cannot be forced through while sharing is off', async () => {
    await expect(acceptTopic(ctx(), w.owner.id, orgId, randomUUID())).rejects.toMatchObject({ status: 409 });
  });
});

describe('with the Owner opt-in', () => {
  it('the Admin cannot switch it on; the Owner can; a proposal then arrives as an open question to the Owner', async () => {
    const denied = await w.t.req('PATCH', '/api/org', {
      cookie: admin.cookie,
      headers: { 'x-aom-org': orgId },
      body: { diagnosticsSharing: true, consentVersion: DIAGNOSTICS_CONSENT_VERSION },
    });
    expect(denied.status).toBe(403);
    expect((await setSharing(true)).status).toBe(200);

    // the verb works now, through the CEO's own shift
    const resp = await ceo(r, shiftId, {
      op: 'topic',
      sub: 'propose',
      question: question(),
      area: 'deploy',
      from: [],
    });
    expect(resp.result.status).toBe('executed');
    const item = (
      await q(`SELECT * FROM desk_items WHERE org_id=$1 AND subkind='ceo_blog_topics' AND status='open'`, [
        orgId,
      ])
    )[0]!;
    expect(item.title).toBe(
      'These might make good blog articles for the community. May I send them to Guildwise as research topics?',
    );
    expect(item.blocking).toBe(false);
    expect(item.addressee_user_id).toBe(w.owner.id);
  });

  it('only the Owner decides in a customer organization: an Admin gets 403 on Accept, Reject and the desk question', async () => {
    const p = await propose(question());
    const as = (cookie: string, url: string, body: unknown = {}) =>
      w.t.req('POST', url, { cookie, headers: { 'x-aom-org': orgId }, body });
    expect((await as(admin.cookie, `/api/ceo/topics/${p.candidateId}/accept`)).status).toBe(403);
    expect((await as(admin.cookie, `/api/ceo/topics/${p.candidateId}/reject`)).status).toBe(403);
    const item = (
      await q(`SELECT id FROM desk_items WHERE org_id=$1 AND subkind='ceo_blog_topics' AND status='open'`, [
        orgId,
      ])
    )[0]!;
    expect((await as(admin.cookie, `/api/desk/${item.id}/resolve`, { resolution: 'approved' })).status).toBe(
      403,
    );
    expect((await candidates(`AND status='proposed'`)).length).toBeGreaterThan(0);
    expect((await as(w.owner.cookie, `/api/ceo/topics/${p.candidateId}/accept`)).status).toBe(200);
  });

  it('an accepted topic arrives with origin customer and no organization anywhere in the blog-topics stream', async () => {
    const qn = question();
    const p = await propose(qn, 'sandbox');
    const { topicId } = await acceptTopic(ctx(), w.owner.id, orgId, p.candidateId as string);
    await sweepTopics(ctx());
    const events = await q(`SELECT * FROM events WHERE stream_id='blog-topics' ORDER BY seq`);
    const queued = events.filter((e) => e.type === 'BlogTopicQueued').at(-1)!;
    expect(queued.payload).toEqual({ topicId, question: qn, area: 'sandbox', origin: 'customer' });
    expect(queued.actor_kind).toBe('system');
    expect(queued.causation_id).toBeNull();
    const cand = (await candidates())[0]!;
    const all = JSON.stringify(events);
    for (const secret of [orgId, w.owner.id, cand.id, w.projectId]) expect(all).not.toContain(secret);
    expect((await q('SELECT origin FROM blog_topics WHERE id=$1', [topicId]))[0]?.origin).toBe('customer');
    // no org id column or key to the org exists on the platform table
    const cols = (
      await q(`SELECT column_name FROM information_schema.columns WHERE table_name='blog_topics'`)
    ).map((c) => c.column_name);
    expect(cols).not.toContain('org_id');
  });

  it('is capped at 4 a month: the fifth stays accepted until next month', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await propose(question(), i % 2 ? 'cost' : 'review');
      await acceptTopic(ctx(), w.owner.id, orgId, p.candidateId as string);
      ids.push(p.candidateId as string);
    }
    expect((await sweepTopics(ctx())).handedOff).toBe(4);
    expect((await candidates(`AND status='queued'`)).length).toBe(4);
    expect((await candidates(`AND status='accepted'`)).length).toBe(1);
    expect((await ok<any>(owner('GET', '/api/ceo/topics'))).remainingThisMonth).toBe(0);
    expect((await sweepTopics(ctx())).handedOff).toBe(0);
    // next month: what was handed on last month no longer counts (the clock is not moved: the owner's session would expire)
    await q(`UPDATE ceo_topic_candidates SET handed_off_at = handed_off_at - interval '40 days'`);
    expect((await sweepTopics(ctx())).handedOff).toBe(1);
    expect((await candidates(`AND status='accepted'`)).length).toBe(0);
  });

  it('turning the consent off withdraws what the writer has not taken yet', async () => {
    await q(`DELETE FROM blog_topics`);
    await q('DELETE FROM ceo_topic_candidates');
    const queued = await propose(question(), 'auth');
    const waiting = await propose(question(), 'secrets');
    await acceptTopic(ctx(), w.owner.id, orgId, queued.candidateId as string);
    await sweepTopics(ctx());
    await acceptTopic(ctx(), w.owner.id, orgId, waiting.candidateId as string);
    const topicId = (await candidates(`AND status='queued'`))[0]?.topic_id as string;
    expect(topicId).toBeTruthy();

    expect((await setSharing(false)).status).toBe(200);
    expect((await q('SELECT status, reason FROM blog_topics WHERE id=$1', [topicId]))[0]).toMatchObject({
      status: 'rejected',
      reason: 'withdrawn',
    });
    const rej = (
      await q(
        `SELECT * FROM events WHERE stream_id='blog-topics' AND type='BlogTopicRejected' ORDER BY seq DESC`,
      )
    )[0]!;
    expect(rej.actor_kind).toBe('system');
    expect(rej.payload).toMatchObject({ topicId, reason: 'withdrawn', by: null });
    expect((await candidates()).map((c) => c.status)).toEqual(['withdrawn', 'withdrawn']);
    // and nothing leaves afterwards, even for an accepted topic that was waiting
    expect((await sweepTopics(ctx())).handedOff).toBe(0);
    await setSharing(true);
  });
});

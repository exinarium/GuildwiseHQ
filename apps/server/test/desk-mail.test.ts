import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BURST_LIMIT, deskMailTick, redact } from '../src/commands/desk-mail.ts';
import { withAppendTx } from '../src/db/tx.ts';
import { raiseDeskItem } from '../src/desk-port.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { messagesTo, messageText, waitForMessages } from './helpers/mailpit.ts';
import { ok } from './helpers/world.ts';

/**
 * Desk mail (docs/design/desk-mail.md): one mail per NEW desk item to the support address(es); none for edits, a
 * rebuild or a reboot; none without an address or with the setting off; bursts become a digest.
 */
let t: TestApp;
let sa: { id: string; email: string; cookie: string };
let owner: { id: string; cookie: string; email: string };
const rnd = () => Math.random().toString(36).slice(2, 8);
let SUPPORT: string;
let OPERATOR: string;
const ctx = () => t.app.ctx;

const settings = (body: Record<string, unknown>) =>
  ok(t.req('PATCH', '/api/platform/settings', { cookie: sa.cookie, body }));

let n = 0;
async function raise(over: { title?: string; blocking?: boolean; pinned?: boolean; body?: string } = {}) {
  const title = over.title ?? `Approve the thing ${++n} ${rnd()}`;
  const r = await withAppendTx(ctx().pool, (tx) =>
    raiseDeskItem(ctx(), tx, {
      kind: 'approval',
      subkind: 'devops',
      title,
      body: over.body ?? 'A short explanation.',
      pinned: over.pinned ?? false,
      blocking: over.blocking ?? false,
      orgId: owner.id,
      routeToUserId: owner.id,
      context: {},
    }),
  );
  return { id: r.deskItemId, title };
}
const logged = async () => Number((await q('SELECT count(*)::int AS n FROM desk_mail_log'))[0]?.n);

beforeAll(async () => {
  t = await createTestApp();
  sa = await t.superAdminSession();
  owner = await t.userSession(uniqueEmail('desk-owner'));
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  SUPPORT = `desk-support-${rnd()}@inbox.test`;
  OPERATOR = owner.email;
  await settings({
    supportEmail: `${SUPPORT}, ${OPERATOR}`,
    deskMailEnabled: true,
    deskMailMinPriority: 'all',
    deskMailScope: 'operator',
  });
  await deskMailTick(ctx()); // drain what earlier tests left
});

describe('desk mail', () => {
  it('mails each address once for a new item, with kind, title, org, priority and a link', async () => {
    const it1 = await raise({ blocking: true, body: 'Run npm install on the workstation.' });
    const res = await deskMailTick(ctx());
    expect(res.mails).toBe(1);
    const [m] = await waitForMessages(SUPPORT, 1);
    expect(m?.Subject).toBe(`[Desk] Approval: ${it1.title}`);
    const text = await messageText(m?.ID as string);
    expect(text).toContain('Blocking');
    expect(text).toContain('Run npm install');
    expect(text).toContain(`/desk#desk-item-${it1.id}`);
    expect((await waitForMessages(OPERATOR, 1)).some((x) => x.Subject.includes(it1.title))).toBe(true);
  });

  it('does not mail again on later passes, edits, a rebuild or a reboot', async () => {
    const it2 = await raise();
    await deskMailTick(ctx());
    await waitForMessages(SUPPORT, 1);
    const count = (await messagesTo(SUPPORT)).length;
    await deskMailTick(ctx());
    // an edit: the item is updated in place
    await q(`UPDATE desk_items SET title = 'renamed', updated_at = now() WHERE id=$1`, [it2.id]);
    await deskMailTick(ctx());
    // a rebuild replays every event into fresh desk_items; the marker table is not a projection
    await rebuildProjections(ctx().pool, ctx().store);
    await deskMailTick(ctx());
    expect((await messagesTo(SUPPORT)).length).toBe(count);
    const states = await q(`SELECT state FROM desk_mail_log WHERE desk_item_id=$1`, [it2.id]);
    expect(states).toHaveLength(1);
  });

  it('sends nothing when no support address is set (and does not mail the backlog when one is added)', async () => {
    await settings({ supportEmail: '' });
    // the env fallback is not set in tests
    const it3 = await raise();
    expect((await deskMailTick(ctx())).mails).toBe(0);
    expect(await q(`SELECT state FROM desk_mail_log WHERE desk_item_id=$1`, [it3.id])).toEqual([
      { state: 'skipped' },
    ]);
    await settings({ supportEmail: SUPPORT });
    expect((await deskMailTick(ctx())).mails).toBe(0);
    expect(await messagesTo(SUPPORT)).toHaveLength(0);
  });

  it('sends nothing when the setting is off', async () => {
    await settings({ deskMailEnabled: false });
    await raise();
    expect((await deskMailTick(ctx())).mails).toBe(0);
    await settings({ deskMailEnabled: true });
    expect((await deskMailTick(ctx())).mails).toBe(0);
    expect(await messagesTo(SUPPORT)).toHaveLength(0);
  });

  it('honours the minimum priority', async () => {
    await settings({ deskMailMinPriority: 'blocking' });
    await raise({ title: `quiet ${rnd()}` });
    await raise({ title: `pinned ${rnd()}`, pinned: true });
    const loud = await raise({ title: `loud ${rnd()}`, blocking: true });
    expect((await deskMailTick(ctx())).mails).toBe(1);
    const msgs = await waitForMessages(SUPPORT, 1);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.Subject).toContain(loud.title);
  });

  it('operator scope only covers organizations the operator belongs to; scope all covers every one', async () => {
    const stranger = await t.userSession(uniqueEmail('desk-stranger'));
    const raiseFor = (org: { id: string }, title: string) =>
      withAppendTx(ctx().pool, (tx) =>
        raiseDeskItem(ctx(), tx, {
          kind: 'approval',
          subkind: 'devops',
          title,
          body: '',
          pinned: false,
          blocking: false,
          orgId: org.id,
          routeToUserId: org.id,
          context: {},
        }),
      );
    const foreign = `foreign ${rnd()}`;
    await raiseFor(stranger, foreign);
    expect((await deskMailTick(ctx())).mails).toBe(0);
    await settings({ deskMailScope: 'all' });
    const foreign2 = `foreign again ${rnd()}`;
    await raiseFor(stranger, foreign2);
    expect((await deskMailTick(ctx())).mails).toBe(1);
    expect((await waitForMessages(SUPPORT, 1))[0]?.Subject).toContain(foreign2);
  });

  it('turns a burst into one digest mail', async () => {
    const titles: string[] = [];
    for (let i = 0; i < BURST_LIMIT + 2; i++) titles.push((await raise()).title);
    const res = await deskMailTick(ctx());
    expect(res.mails).toBe(1);
    const [m] = await waitForMessages(SUPPORT, 1);
    expect(m?.Subject).toBe(`[Desk] ${BURST_LIMIT + 2} new desk items`);
    const text = await messageText(m?.ID as string);
    for (const title of titles) expect(text).toContain(title);
    expect((await deskMailTick(ctx())).mails).toBe(0);
  });

  it('does not wait for an item still in triage, and never mails items that are already closed', async () => {
    const closed = await raise();
    await q(`UPDATE desk_items SET status='answered' WHERE id=$1`, [closed.id]);
    const pending = await raise();
    await q(`UPDATE desk_items SET triage='pending' WHERE id=$1`, [pending.id]);
    expect((await deskMailTick(ctx())).mails).toBe(0);
    await q(`UPDATE desk_items SET triage='none' WHERE id=$1`, [pending.id]);
    expect((await deskMailTick(ctx())).mails).toBe(1);
  });

  it('shows the settings on the platform settings endpoint', async () => {
    const s = await ok<any>(t.req('GET', '/api/platform/settings', { cookie: sa.cookie }));
    expect(s).toMatchObject({ deskMailEnabled: true, deskMailMinPriority: 'all', deskMailScope: 'operator' });
  });

  it('hides credentials in the text', () => {
    expect(redact('use password=hunter2 and token: abc, key sk-abcdefghijklmnopqrst')).not.toMatch(
      /hunter2|abcdefghij/,
    );
  });
});

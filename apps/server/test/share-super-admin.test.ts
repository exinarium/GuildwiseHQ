import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { messagesTo } from './helpers/mailpit.ts';
import { createWorld, type World } from './helpers/world.ts';

/**
 * R8 (audit F3) for project sharing: a platform account's email gets exactly the answer any other existing account gets
 * (the same body with the pending member listed, the same 409 on a repeat), no mail, and it can never join.
 */
let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const share = (email: string) =>
  w.t.req('POST', `/api/projects/${w.projectId}/members`, { cookie: w.owner.cookie, body: { email } });

type Member = { userId: string; displayName: string; email: string; role: string; status: string };
/** The response with the one person-specific member row taken out, so two answers can be compared in full. */
const without = (body: { members: Member[] }, userId: string) => {
  const mine = body.members.find((m) => m.userId === userId);
  return { rest: { ...body, members: body.members.filter((m) => m.userId !== userId) }, mine };
};

describe('sharing a project with a super admin’s email', () => {
  it('answers exactly like any other existing account; a repeat gives the same 409; nothing is mailed; it cannot join', async () => {
    const other = await w.t.userSession(uniqueEmail('guest'));
    const root = await w.t.superAdminSession();
    const email = (await q('SELECT email FROM users WHERE id=$1', [root.id]))[0]!.email as string;

    const normal = await share(other.email);
    const r = await share(email);
    expect(r.status).toBe(201);
    expect(normal.status).toBe(201);
    // the full body: everything but the two pending rows is identical, and each pending row has the same shape
    const a = without(normal.body, other.id);
    const b = without(r.body, root.id);
    expect({ ...b.rest, members: [] }).toEqual({ ...a.rest, members: [] });
    expect(b.rest.members.filter((m: Member) => m.userId !== other.id)).toEqual(a.rest.members);
    expect(r.body.members).toHaveLength(normal.body.members.length + 1);
    expect(a.mine).toMatchObject({ status: 'invited' });
    expect(b.mine).toEqual({
      userId: root.id,
      displayName: expect.any(String),
      email,
      role: a.mine!.role,
      status: a.mine!.status,
    });

    // a repeat: the same refusal for both
    const again = await share(email);
    const againNormal = await share(other.email);
    expect(again.status).toBe(againNormal.status);
    expect(again.body.error.code).toBe(againNormal.body.error.code);
    expect(again.body.error.code).toBe('already_invited');

    // no mail, and the platform account can never accept
    expect(await messagesTo(email)).toHaveLength(0);
    const accept = await w.t.req('POST', `/api/projects/${w.projectId}/members/accept`, {
      cookie: root.cookie,
    });
    expect(accept.status).toBe(403);
    expect(
      (
        await q('SELECT status FROM project_members WHERE project_id=$1 AND user_id=$2', [
          w.projectId,
          root.id,
        ])
      )[0]!.status,
    ).toBe('invited');
  });
});

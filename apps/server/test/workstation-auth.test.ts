import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaptureMailer } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { freshState, shiftHelpers } from './helpers/shifts.ts';
import { createWorld, MOCK_RUNTIME, ok, until, type World } from './helpers/world.ts';

/**
 * A workstation's sign-ins: the Claude login (expired pauses dispatching, shifts are put back without penalty, one
 * desk notice and one e-mail, cleared by the system on recovery) and the plugin MCP servers' sign-in state.
 */
let w: World;
let r: FakeRunner;
const mail = new CaptureMailer();
const CLAUDE = { id: 'claude-code', version: '2.1.299', available: true, capabilities: ['shell'] };
const ATLASSIAN = {
  name: 'plugin_atlassian_atlassian',
  plugin: 'atlassian',
  server: 'atlassian',
  transport: 'http',
  host: 'mcp.atlassian.com',
};

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  (w.t.app.ctx as { mailer: unknown }).mailer = mail;
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const h = () => shiftHelpers(w);
const items = (subkind: string, status = 'open') =>
  q(`SELECT id, org_id, title, body, status, kind FROM desk_items WHERE subkind=$1 AND status=$2`, [
    subkind,
    status,
  ]);
const reportRuntimes = async (mock: Record<string, unknown>, claude: Record<string, unknown>) => {
  r.send('runtimes.report', {
    runtimes: [
      { ...MOCK_RUNTIME[0], ...mock },
      { ...CLAUDE, ...claude },
    ],
  });
  await r.barrier();
};
const workstation = async () =>
  (await w.t.req('GET', '/api/workstations', { cookie: w.owner.cookie })).body.workstations[0];

describe('an expired Claude login', () => {
  it('pauses dispatching to the workstation, puts the shift back without penalty and raises one notice', async () => {
    await freshState();
    await q(`TRUNCATE desk_items, card_blockers CASCADE`);
    await w.hire('Ada', 'builder', 'junior');
    const card = await w.card({ title: 'Needs a login' });

    // a shift starts, then the runner finds the login dead
    const start = await h().dispatchTo(r, 'Ada', r.received.length);
    await h().startShift(r, start);
    await reportRuntimes({ available: false, auth: 'expired' }, { available: false, auth: 'expired' });
    r.send('shift.rejected', { shiftId: start.shiftId, reason: 'auth_expired', detail: 'login expired' });
    await until(
      async () => (await q('SELECT claim_id FROM cards WHERE id=$1', [card.id]))[0]?.claim_id === null,
      3000,
      'claim released',
    );
    const c = (await q('SELECT status, retry_after, retry_failures FROM cards WHERE id=$1', [card.id]))[0]!;
    expect(c.status).toBe('queued');
    expect(c.retry_after).toBeNull();
    expect(Number(c.retry_failures ?? 0)).toBe(0);
    const [shift] = await q('SELECT outcome FROM shifts WHERE id=$1', [start.shiftId]);
    expect(shift?.outcome).toBe('rejected'); // not crashed / no_report: the loop breaker and digests ignore it
    const msg = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system'`, [card.id]);
    expect(msg.map((m) => m.body).join('\n')).toMatch(/Claude login .* expired/);

    // nothing is dispatched while the login is expired
    expect(await w.t.app.ctx.services.dispatcher.run()).toEqual([]);

    // the desk has one notice, the owner one e-mail, the workstation page the state
    const open = await items('claude_auth_expired');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'alert' });
    expect(open[0]?.title).toMatch(/Claude login expired on /);
    expect(open[0]?.body).toMatch(/claude.*\/login/s);
    expect(mail.sent).toHaveLength(1);
    expect((await workstation()).runtimes.find((x: any) => x.id === 'claude-code').auth).toBe('expired');

    // the same report again changes nothing
    await reportRuntimes({ available: false, auth: 'expired' }, { available: false, auth: 'expired' });
    expect(await items('claude_auth_expired')).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
  });

  it('resumes by itself: the notice closes and the card is dispatched again', async () => {
    await reportRuntimes({ available: true, auth: 'ok' }, { available: true, auth: 'ok' });
    await until(async () => (await items('claude_auth_expired')).length === 0, 3000, 'notice closed');
    const [closed] = await q(
      `SELECT status, answer_option, answer FROM desk_items WHERE subkind='claude_auth_expired' ORDER BY created_at DESC`,
    );
    expect(closed).toMatchObject({ status: 'answered', answer_option: 'acknowledged' });
    w.t.app.ctx.services.dispatcher.cooldown.clear(); // a rejection pauses the agent for 30 s
    const start = await h().dispatchTo(r, 'Ada', r.received.length);
    expect(start.agent.name).toBe('Ada');
  });
});

describe('plugin MCP servers: sign-in state', () => {
  it('is stored, shown on the workstation and the candidates, and noticed once a project grants the server', async () => {
    await q(`TRUNCATE desk_items, card_blockers CASCADE`);
    r.send('mcp.servers', { servers: [{ ...ATLASSIAN, authState: 'needs_sign_in' }] });
    await r.barrier();
    const ws = await workstation();
    expect(ws.mcpServers).toEqual([
      { ...{ name: ATLASSIAN.name, plugin: 'atlassian', server: 'atlassian' }, authState: 'needs_sign_in' },
    ]);
    // not granted yet: nothing to tell
    expect(await items('mcp_needs_sign_in')).toHaveLength(0);

    await ok(
      w.t.req('PUT', `/api/projects/${w.projectId}/mcp-servers`, {
        cookie: w.owner.cookie,
        body: { servers: [ATLASSIAN.name] },
      }),
    );
    const cands = await w.t.req('GET', '/api/mcp-servers', { cookie: w.owner.cookie });
    expect(cands.body.servers[0]).toMatchObject({ name: ATLASSIAN.name, needsSignIn: [ws.name] });

    // the next report (every minute) notices it
    r.send('mcp.servers', { servers: [{ ...ATLASSIAN, authState: 'needs_sign_in' }] });
    await r.barrier();
    const open = await items('mcp_needs_sign_in');
    expect(open).toHaveLength(1);
    expect(open[0]?.body).toContain(
      `On ${ws.name}, run \`claude\`, then \`/mcp\`, choose atlassian, Authenticate.`,
    );
    r.send('mcp.servers', { servers: [{ ...ATLASSIAN, authState: 'needs_sign_in' }] });
    await r.barrier();
    expect(await items('mcp_needs_sign_in')).toHaveLength(1);

    // signed in: closed by the system
    r.send('mcp.servers', { servers: [{ ...ATLASSIAN, authState: 'signed_in' }] });
    await r.barrier();
    expect(await items('mcp_needs_sign_in')).toHaveLength(0);
  });

  it('an older runner (no authState) never raises a notice', async () => {
    r.send('mcp.servers', { servers: [ATLASSIAN] });
    await r.barrier();
    expect(await items('mcp_needs_sign_in')).toHaveLength(0);
  });
});

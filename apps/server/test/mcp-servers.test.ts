import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMcpServersReport } from '../src/commands/mcp-servers.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { createWorld, ok, pairWorkstation, type World } from './helpers/world.ts';

/**
 * Plugin MCP servers: the workstation's report (names and facts only), the grant to a project (the organization's Owner
 * only), what shift.start and chat.start carry, and the per-shift tally of MCP tools used.
 */
let w: World;
const ATLASSIAN = {
  name: 'plugin_atlassian_atlassian',
  plugin: 'atlassian',
  server: 'atlassian',
  transport: 'http',
  host: 'mcp.atlassian.com',
};
const FILES = { name: 'plugin_files_local', plugin: 'files', server: 'local', transport: 'stdio' };

const put = (cookie: string, servers: string[], org?: string) =>
  w.t.req('PUT', `/api/projects/${w.projectId}/mcp-servers`, {
    cookie,
    ...(org ? { headers: { 'x-aom-org': org } } : {}),
    body: { servers },
  });
const detail = (cookie: string, org?: string) =>
  ok<any>(
    w.t.req('GET', `/api/projects/${w.projectId}`, {
      cookie,
      ...(org ? { headers: { 'x-aom-org': org } } : {}),
    }),
  );

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  const r = await w.connectRunner();
  // an env value and a header ride along in a (hostile or careless) report: the server keeps facts only
  r.send('mcp.servers', {
    servers: [
      { ...ATLASSIAN, env: { TOKEN: 'secret-token' }, headers: { Authorization: 'Bearer x' } },
      FILES,
    ],
  });
  await r.barrier();
  r.close();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('plugin MCP servers: the report', () => {
  it('stores names and facts per workstation, drops invalid entries and anything secret', async () => {
    const [row] = await q('SELECT mcp_servers FROM workstations WHERE id=$1', [w.workstationId]);
    expect(row?.mcp_servers).toEqual([ATLASSIAN, FILES]);
    expect(JSON.stringify(row?.mcp_servers)).not.toContain('secret-token');
  });

  it('keeps the valid entries of a report that holds an invalid one', async () => {
    const other = await w.t.userSession(uniqueEmail('mcp-ws'));
    const ws = await pairWorkstation(w.t, other, 'other-box');
    await applyMcpServersReport(w.t.app.ctx, ws.workstationId, {
      servers: [{ name: 'bad name!', plugin: 'x', server: 'y', transport: 'stdio' }, FILES],
    });
    const [row] = await q('SELECT mcp_servers FROM workstations WHERE id=$1', [ws.workstationId]);
    expect(row?.mcp_servers).toEqual([FILES]);
  });
});

describe('plugin MCP servers: granting', () => {
  it('the organization Owner sees the candidates and grants servers; the grant is an event and survives a rebuild', async () => {
    const d = await detail(w.owner.cookie);
    expect(d.canGrantMcpServers).toBe(true);
    expect(d.mcpServers).toEqual([]);
    expect(d.mcpServerCandidates.map((c: any) => c.name)).toEqual([ATLASSIAN.name, FILES.name]);
    expect(d.mcpServerCandidates[0]).toMatchObject({ host: 'mcp.atlassian.com', workstations: ['Desk'] });
    const set = await ok<any>(put(w.owner.cookie, [ATLASSIAN.name, ATLASSIAN.name]));
    expect(set.mcpServers).toEqual([ATLASSIAN.name]);
    expect(
      await q(`SELECT 1 FROM events WHERE type='ProjectMcpServersSet' AND project_id=$1`, [w.projectId]),
    ).toHaveLength(1);
    // the same list again appends nothing
    await ok(put(w.owner.cookie, [ATLASSIAN.name]));
    expect(
      await q(`SELECT 1 FROM events WHERE type='ProjectMcpServersSet' AND project_id=$1`, [w.projectId]),
    ).toHaveLength(1);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await detail(w.owner.cookie)).mcpServers).toEqual([ATLASSIAN.name]);
    const [ws] = await q('SELECT mcp_servers FROM workstations WHERE id=$1', [w.workstationId]);
    expect(ws?.mcp_servers).toHaveLength(2); // the report survives a rebuild too
  });

  it('refuses a server no workstation of the Owner reports', async () => {
    const res = await put(w.owner.cookie, ['plugin_nothing_here']);
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('invalid_mcp_server');
  });

  it('refuses organization admins and project managers, who only read the grant', async () => {
    const admin = await addMember(w, 'mcp-admin');
    await w.t.addOrgMember(w.owner.id, admin.id, 'admin');
    expect((await put(admin.cookie, [], w.owner.id)).status).toBe(403);
    const manager = await addMember(w, 'mcp-manager');
    expect((await put(manager.cookie, [])).status).toBe(403);
    for (const c of [admin, manager]) {
      const d = await detail(c.cookie, w.owner.id);
      expect(d.mcpServers).toEqual([ATLASSIAN.name]);
      expect(d.canGrantMcpServers).toBe(false);
      expect(d.mcpServerCandidates).toEqual([]);
    }
    // nothing changed
    expect((await detail(w.owner.cookie)).mcpServers).toEqual([ATLASSIAN.name]);
  });

  it('a stranger cannot even see the project', async () => {
    const s = await w.t.userSession(uniqueEmail('mcp-stranger'));
    expect((await put(s.cookie, [])).status).toBe(404);
  });
});

describe('plugin MCP servers: what the runner is told', () => {
  it('shift.start of a card shift carries the granted names (and only names)', async () => {
    const r = await w.connectRunner();
    await w.hire('Mina', 'builder', 'junior');
    await w.card({ title: 'Uses a tracker' });
    await w.t.app.ctx.services.dispatcher.run();
    const start = await r.waitFor('shift.start');
    expect(start.mcpServers).toEqual([ATLASSIAN.name]);
    expect(JSON.stringify(start)).not.toContain('mcp.atlassian.com');

    // tools the agent calls are tallied per shift for the card's log
    r.accepted(start.shiftId);
    r.started(start.shiftId);
    const at = new Date().toISOString();
    r.send('shift.progress', {
      shiftId: start.shiftId,
      items: [
        { at, kind: 'tool', text: 'mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql: {"jql":"x"}' },
        { at, kind: 'tool', text: 'mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql: {"jql":"y"}' },
        { at, kind: 'tool', text: 'mcp__plugin_atlassian_atlassian__getJiraIssue: {"key":"A-1"}' },
        { at, kind: 'tool', text: 'Bash: ls' },
        { at, kind: 'text', text: 'mcp__not_a_tool__x: just text' },
      ],
    });
    await r.barrier();
    const shifts = await ok<any>(
      w.t.req('GET', `/api/shifts?cardId=${start.brief.card.id}`, { cookie: w.owner.cookie }),
    );
    expect(shifts.shifts[0].mcpCalls).toEqual([
      { server: 'plugin_atlassian_atlassian', tool: 'getJiraIssue', count: 1 },
      { server: 'plugin_atlassian_atlassian', tool: 'searchJiraIssuesUsingJql', count: 2 },
    ]);
    // the card shows them per shift
    const card = await ok<any>(
      w.t.req('GET', `/api/cards/${start.brief.card.id}`, { cookie: w.owner.cookie }),
    );
    expect(card.mcpUsage).toEqual([
      expect.objectContaining({
        shiftId: start.shiftId,
        agentName: 'Mina',
        calls: [
          { server: 'plugin_atlassian_atlassian', tool: 'getJiraIssue', count: 1 },
          { server: 'plugin_atlassian_atlassian', tool: 'searchJiraIssuesUsingJql', count: 2 },
        ],
      }),
    ]);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const [row] = await q('SELECT mcp_calls FROM shifts WHERE id=$1', [start.shiftId]);
    expect(row?.mcp_calls).toHaveLength(2);
    r.close();
  });

  it('chat.start carries the granted names, and none once the grant is cleared', async () => {
    const r = await w.connectRunner();
    const agent = await w.hire('Chatty', 'builder', 'junior');
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    const chat = (
      await ok<any>(
        w.t.req('POST', '/api/chats', {
          cookie: w.owner.cookie,
          body: { agentId: agent.id, projectId: w.projectId },
        }),
        201,
      )
    ).chat;
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'hi', clientMsgId: 'c1' });
    const start = await r.waitFor('chat.start');
    expect(start.context.mcpServers).toEqual([ATLASSIAN.name]);
    r.send('chat.done', {
      chatId: start.chatId,
      threadId: start.threadId,
      messageText: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await b.until(() => b.of('chat.done').length === 1);
    await ok(put(w.owner.cookie, []));
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'again', clientMsgId: 'c2' });
    const second = await r.waitFor('chat.start', (f) => f.message === 'again');
    expect(second.context.mcpServers).toBeUndefined();
    b.close();
    r.close();
  });

  it('a chat with no project (intake) carries what the user’s projects were granted', async () => {
    await ok(put(w.owner.cookie, [ATLASSIAN.name]));
    const r = await w.connectRunner();
    const agent = await w.hire('Intake BA', 'builder', 'junior');
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    const chat = (
      await ok<any>(w.t.req('POST', '/api/chats', { cookie: w.owner.cookie, body: { agentId: agent.id } }), 201)
    ).chat;
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'read the ticket', clientMsgId: 'i1' });
    const start = await r.waitFor('chat.start', (f) => f.message === 'read the ticket');
    expect(start.context.projectId).toBeUndefined();
    expect(start.context.mcpServers).toEqual([ATLASSIAN.name]);
    b.close();
    r.close();
  });
});

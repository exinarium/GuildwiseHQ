import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * A repository requested by the BA in a simulation organization is a simulated one: approving it creates a local
 * throwaway origin on the server and adds it to the project; no runner command, no forge.
 */
const simDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'aom-simrepo-'));
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_SIMULATION_DIR: simDir } });
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

const post = (url: string, body: unknown, status = 200) =>
  ok<any>(w.t.req('POST', url, { cookie: w.owner.cookie, body }), status);

describe('repository requests in a simulation organization', () => {
  it('approving creates a simulated repository, not a forge repository', async () => {
    await freshState();
    await q('TRUNCATE repo_requests CASCADE');
    await q("DELETE FROM project_repos WHERE name <> 'toy'");
    r = await w.connectRunner();
    const ba = await w.hire('Grace', 'ba', 'senior');
    const chat = (await post('/api/chats', { agentId: ba.id }, 201)).chat;
    const from = r.received.length;
    w.t.app.ctx.services.chat.send(w.owner.id, {
      threadId: chat.threadId,
      body: 'hello',
      clientMsgId: randomUUID(),
    });
    const start = (await r.waitFor('chat.start', (f) => f.threadId === chat.threadId, 15_000, from)) as any;
    // The chat is already running on this runner; the organization becomes a simulation only now (real workstations
    // are not given chats of a simulation organization). Set directly: this organization has projects.
    await q('UPDATE organizations SET simulation=true WHERE id=$1', [w.owner.id]);
    const rpcId = randomUUID();
    const at = r.received.length;
    r.send('rpc.request', {
      rpcId,
      shiftId: start.chatId,
      method: 'repo.create',
      params: { name: 'acme/demo-shop', visibility: 'private', project: 'TOY', description: 'Demo' },
    });
    const asked = (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, at)) as any;
    expect(asked.ok, asked.error).toBe(true);
    expect(asked.result).toMatchObject({ status: 'pending' });

    const items = (await ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }))).items.filter(
      (i: any) => i.subkind === 'repo_create',
    );
    expect(items).toHaveLength(1);
    expect(items[0].body).toContain('simulated repository');
    expect(items[0].body).not.toContain('GitHub login');

    const cmdAt = r.received.length;
    const res = await w.t.req('POST', `/api/desk/${items[0].id}/resolve`, {
      cookie: w.owner.cookie,
      body: { resolution: 'approved' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(r.received.slice(cmdAt).filter((f: any) => f.command === 'repo.create')).toHaveLength(0);

    const req = (await q('SELECT status, remote_url, project_repo_id FROM repo_requests'))[0]!;
    expect(req.status).toBe('created');
    expect(req.remote_url).toContain(join(simDir, w.owner.id, 'origin'));
    expect(existsSync(req.remote_url)).toBe(true);
    const repos = await q(
      `SELECT name, remote_url FROM project_repos WHERE project_id=$1 AND removed_at IS NULL AND name='demo-shop'`,
      [w.projectId],
    );
    expect(repos).toHaveLength(1);
    expect(repos[0]!.remote_url).toBe(req.remote_url);
    const note = await q(
      `SELECT body FROM thread_messages WHERE thread_id=$1 AND author_kind='system' ORDER BY event_seq`,
      [chat.threadId],
    );
    expect(note.some((m: any) => /is ready/.test(m.body))).toBe(true);
  });
});

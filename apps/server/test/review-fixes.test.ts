import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueRunnerCommand } from '../src/runner-gateway/commands-queue.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember, connectMemberRunner, type Member } from './helpers/members.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('command.result belongs to the sending workstation (review low)', () => {
  it('another runner cannot complete or fail a command it was never sent', async () => {
    const owner = await w.connectRunner();
    const m: Member = await addMember(w, 'intruder');
    const mr = await connectMemberRunner(w, m);
    const id = await enqueueRunnerCommand(w.t.app.ctx.pool, w.workstationId, 'repos.rescan', {});
    const status = async () => (await q('SELECT status FROM runner_commands WHERE id=$1', [id]))[0]!.status;

    mr.send('command.result', { commandId: id, ok: true });
    await mr.barrier();
    expect(await status()).not.toBe('done');
    mr.send('command.result', { commandId: id, ok: false, error: 'sabotage' });
    await mr.barrier();
    expect((await q('SELECT last_error FROM runner_commands WHERE id=$1', [id]))[0]!.last_error).not.toBe(
      'sabotage',
    );

    owner.send('command.result', { commandId: id, ok: true });
    await until(async () => (await status()) === 'done', 3000, 'owner completes its own command');
    owner.close();
    mr.close();
  });
});

describe('hiring on an archived project (review low)', () => {
  it('is refused', async () => {
    const p = await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key: 'OLD', name: 'Old' } }),
      201,
    );
    await q(`UPDATE projects SET status='archived' WHERE id=$1`, [p.project.id]);
    const r = await w.t.req('POST', '/api/agents', {
      cookie: w.owner.cookie,
      body: {
        name: 'Late',
        roleKey: 'builder',
        seniority: 'junior',
        workstationId: w.workstationId,
        projectId: p.project.id,
        runtime: 'mock',
        model: 'mock',
      },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('project_archived');
  });
});

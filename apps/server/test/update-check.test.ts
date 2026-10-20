import { RUNNER_UPDATE_CHECK_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/** "Check for updates": POST /api/workstations/:id/update-check, the runner.update.check command and its stored answer. */
let w: World;
let r: FakeRunner | undefined;
const url = () => `/api/workstations/${w.workstationId}/update-check`;
const post = () => w.t.req('POST', url(), { cookie: w.owner.cookie });
const dto = async () =>
  (await ok<any>(w.t.req('GET', '/api/workstations', { cookie: w.owner.cookie }))).workstations.find(
    (x: any) => x.id === w.workstationId,
  );

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

async function reset() {
  await q(`DELETE FROM runner_commands`);
  await q(`UPDATE workstations SET runner_update_check=NULL`);
}

describe('update check route', () => {
  it('is an error while the runner is offline, and queues nothing', async () => {
    await reset();
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe('workstation_offline');
    expect(await q(`SELECT 1 FROM runner_commands WHERE type='runner.update.check'`)).toHaveLength(0);
  });

  it('is refused for an old runner without the capability, and the DTO says unsupported', async () => {
    await reset();
    r = await w.connectRunner({ capabilities: [] });
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe('update_check_unsupported');
    expect((await dto()).updateCheck).toMatchObject({ supported: false, state: 'idle', result: null });
    r.close();
    r = undefined;
  });

  it('only the workstation owner may ask', async () => {
    await reset();
    const other = await w.t.userSession(uniqueEmail('other'));
    expect((await w.t.req('POST', url(), { cookie: other.cookie })).status).toBe(404);
    expect((await w.t.req('POST', url(), {})).status).toBe(401);
  });

  it('sends the command to a capable runner, stores its answer, and allows one request a minute', async () => {
    await reset();
    r = await w.connectRunner({ capabilities: [RUNNER_UPDATE_CHECK_CAPABILITY] });
    expect((await dto()).updateCheck).toMatchObject({ supported: true, state: 'idle' });
    const res = await ok<any>(post(), 202);
    expect(res.ok).toBe(true);
    const cmd = await r.waitFor('command', (f) => f.command === 'runner.update.check');
    expect((await dto()).updateCheck).toMatchObject({ state: 'checking', result: null });

    // a second request inside the minute is rate limited and queues nothing more
    expect((await post()).status).toBe(429);
    expect(await q(`SELECT 1 FROM runner_commands WHERE type='runner.update.check'`)).toHaveLength(1);

    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { outcome: 'update_found', version: '0.1.35', detail: null },
    });
    await until(async () => (await dto()).updateCheck.state === 'idle', 3000, 'answer stored');
    expect((await dto()).updateCheck.result).toMatchObject({ outcome: 'update_found', version: '0.1.35' });
    expect((await q(`SELECT status FROM runner_commands WHERE id=$1`, [cmd.commandId]))[0]?.status).toBe(
      'done',
    );

    // after the minute a new request goes through
    w.t.clock.advance(61_000);
    await ok(post(), 202);
    const again = await r.waitFor(
      'command',
      (f) => f.command === 'runner.update.check' && f.commandId !== cmd.commandId,
    );
    r.send('command.result', { commandId: again.commandId, ok: false, error: 'boom' });
    await until(async () => (await dto()).updateCheck.result?.outcome === 'failed', 3000, 'failure stored');
    expect((await dto()).updateCheck.result.detail).toBe('boom');
  });

  it('shows a request nobody answered as timed out', async () => {
    await reset();
    await ok(post(), 202);
    w.t.clock.advance(6 * 60_000);
    expect((await dto()).updateCheck).toMatchObject({ state: 'timed_out' });
  });
});

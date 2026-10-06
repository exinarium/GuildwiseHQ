import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pngSize } from '../src/commands/avatar.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

/** A solid-colour RGBA PNG, `side` pixels square (enough of PNG for the server's header checks). */
function png(side: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(side * 4, 0x77)]);
  const raw = Buffer.concat(Array.from({ length: side }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('agent faces', () => {
  it('every agent has a seed and a style; hiring mints a fresh one; re-rolling changes the seed and keeps the style', async () => {
    const a = await w.hire('Faye', 'builder', 'junior');
    const b = await w.hire('Gus', 'builder', 'junior');
    const list = (await ok<any>(w.t.req('GET', '/api/agents', { cookie: w.owner.cookie }))).agents as any[];
    const faye = list.find((x) => x.id === a.id);
    const gus = list.find((x) => x.id === b.id);
    expect(faye.avatarSeed).toMatch(/^[0-9a-z]{8}$/);
    expect(faye.avatarStyle).toBe('notionists');
    expect(faye.avatarSeed).not.toBe(gus.avatarSeed);
    // DevOps engineers have one too
    expect(list.filter((x) => x.isDevops).every((x) => !!x.avatarSeed)).toBe(true);

    const res = await ok<any>(
      w.t.req('POST', `/api/agents/${a.id}/avatar/reroll`, { cookie: w.owner.cookie, body: {} }),
    );
    expect(res.agent.avatarSeed).not.toBe(faye.avatarSeed);
    expect(res.agent.avatarStyle).toBe('notionists');
    const other = await ok<any>(
      w.t.req('POST', `/api/agents/${a.id}/avatar/reroll`, {
        cookie: w.owner.cookie,
        body: { style: 'lorelei' },
      }),
    );
    expect(other.agent.avatarStyle).toBe('lorelei');

    // it survives a rebuild of the projections
    const seed = other.agent.avatarSeed;
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const again = (await ok<any>(w.t.req('GET', '/api/agents', { cookie: w.owner.cookie }))).agents.find(
      (x: any) => x.id === a.id,
    );
    expect(again).toMatchObject({ avatarSeed: seed, avatarStyle: 'lorelei' });
  });

  it('an agent hired before faces existed gets a face seeded from its id (also after a rebuild)', async () => {
    const id = randomUUID();
    const ws = (await q('SELECT id FROM workstations LIMIT 1'))[0]?.id;
    const permissions = (await q(`SELECT permissions FROM agents WHERE NOT is_devops LIMIT 1`))[0]
      ?.permissions;
    await seed(w, [
      {
        streamId: streamId.agent(id),
        event: {
          type: 'AgentHired',
          payload: {
            agentId: id,
            orgId: w.owner.id,
            hiredByUserId: w.owner.id,
            workstationId: ws,
            name: 'Hal',
            roleKey: 'builder',
            roleVersion: 1,
            seniority: 'junior',
            runtime: 'mock',
            model: 'mock',
            skills: [],
            permissions,
            capacity: 1,
            isDevops: false,
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: w.owner.id, projectId: null, audience: 'org' as const },
      },
    ]);
    const get = async () =>
      (await ok<any>(w.t.req('GET', '/api/agents', { cookie: w.owner.cookie }))).agents.find(
        (x: any) => x.id === id,
      );
    expect(await get()).toMatchObject({ avatarSeed: id, avatarStyle: 'notionists' });
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await get()).toMatchObject({ avatarSeed: id, avatarStyle: 'notionists' });
  });

  it('only the owner or the hiring manager may re-roll', async () => {
    const m = await addMember(w, 'faces');
    const a = await w.hire('Ivy', 'builder', 'junior');
    const res = await w.t.req('POST', `/api/agents/${a.id}/avatar/reroll`, { cookie: m.cookie, body: {} });
    expect([403, 404]).toContain(res.status);
  });
});

describe('the user picture', () => {
  const put = (body: unknown, cookie = w.owner.cookie) => w.t.req('PUT', '/api/me/avatar', { cookie, body });

  it('a generated face is stored and returned on /auth/me', async () => {
    const me = await ok<any>(put({ kind: 'cartoon', seed: 'sunrise', style: 'lorelei' }));
    expect(me.user.avatar).toEqual({ kind: 'cartoon', seed: 'sunrise', style: 'lorelei' });
    expect((await ok<any>(w.t.req('GET', '/api/auth/me', { cookie: w.owner.cookie }))).user.avatar).toEqual({
      kind: 'cartoon',
      seed: 'sunrise',
      style: 'lorelei',
    });
    expect((await put({ kind: 'cartoon', seed: 'x', style: 'pixel-art' })).status).toBe(400);
  });

  it('an uploaded PNG is validated, stored, served to the right people and survives a rebuild', async () => {
    const ok256 = png(256);
    const set = await ok<any>(put({ kind: 'image', pngBase64: ok256.toString('base64') }));
    expect(set.user.avatar.kind).toBe('image');
    const version = set.user.avatar.version;

    const mine = await w.t.app.inject({
      method: 'GET',
      url: `/api/users/${w.owner.id}/avatar`,
      headers: { cookie: w.owner.cookie },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['content-type']).toBe('image/png');
    expect(pngSize(mine.rawPayload)).toEqual({ width: 256, height: 256 });

    // a project mate may see it, a stranger may not
    const mate = await addMember(w, 'mate');
    expect((await w.t.req('GET', `/api/users/${w.owner.id}/avatar`, { cookie: mate.cookie })).status).toBe(
      200,
    );
    const stranger = await w.t.userSession(`avatar-stranger-${Date.now()}@example.com`);
    expect(
      (await w.t.req('GET', `/api/users/${w.owner.id}/avatar`, { cookie: stranger.cookie })).status,
    ).toBe(404);

    // replacing it drops the old bytes
    const second = await ok<any>(put({ kind: 'image', pngBase64: png(128).toString('base64') }));
    expect(second.user.avatar.version).not.toBe(version);
    expect(
      (await q('SELECT count(*)::int AS n FROM avatar_images WHERE user_id=$1', [w.owner.id]))[0]?.n,
    ).toBe(1);

    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await ok<any>(w.t.req('GET', '/api/auth/me', { cookie: w.owner.cookie }))).user.avatar).toEqual({
      kind: 'image',
      version: second.user.avatar.version,
    });
    expect((await w.t.req('GET', `/api/users/${w.owner.id}/avatar`, { cookie: w.owner.cookie })).status).toBe(
      200,
    );

    // none: back to the initials
    expect((await ok<any>(put({ kind: 'none' }))).user.avatar).toBeNull();
  });

  it('refuses what is not a small square PNG', async () => {
    const b64 = (b: Buffer) => b.toString('base64');
    expect(
      (await put({ kind: 'image', pngBase64: b64(Buffer.from('GIF89a not a png at all......')) })).status,
    ).toBe(400);
    expect((await put({ kind: 'image', pngBase64: b64(png(600)) })).status).toBe(422);
    const wide = png(64);
    wide.writeUInt32BE(32, 16); // width 32, height 64
    expect((await put({ kind: 'image', pngBase64: b64(wide) })).status).toBe(422);
    const big = Buffer.concat([png(64), Buffer.alloc(310 * 1024)]);
    expect((await put({ kind: 'image', pngBase64: b64(big) })).status).toBe(422);
  });

  it('the Permissions-Policy lets the page use the camera (for taking a photo) and nothing else', async () => {
    const res = await w.t.req('GET', '/api/auth/me', { cookie: w.owner.cookie });
    expect(res.headers?.['permissions-policy']).toContain('camera=(self)');
    expect(res.headers?.['permissions-policy']).toContain('microphone=()');
  });
});

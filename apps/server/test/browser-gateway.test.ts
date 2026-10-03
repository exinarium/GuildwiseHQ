import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ORIGIN, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

class Browser {
  msgs: any[] = [];
  closed: { code: number } | null = null;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString())));
    ws.on('close', (code) => {
      this.closed = { code };
    });
    ws.on('error', () => {});
  }
  static async open(cookie: string | null, origin: string | null = ORIGIN): Promise<Browser> {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const ws = new WebSocket(`${w.baseUrl.replace('http', 'ws')}/api/ws`, { headers });
    const b = new Browser(ws);
    await new Promise<void>((res) => {
      ws.once('open', () => res());
      ws.once('close', () => res());
      ws.once('error', () => res());
    });
    return b;
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  of(type: string) {
    return this.msgs.filter((m) => m.type === type);
  }
  events() {
    return this.of('event').map((m) => m.event);
  }
  async until(fn: () => boolean, ms = 3000) {
    await until(async () => fn(), ms, 'browser message');
  }
  async hello(lastSeq?: number) {
    this.send({ type: 'hello', ...(lastSeq !== undefined ? { lastSeq } : {}) });
    await this.until(() => this.of('ready').length > 0);
  }
  close() {
    this.ws.close();
  }
}

describe('browser websocket', () => {
  it('requires a session cookie and a matching Origin', async () => {
    const anon = await Browser.open(null);
    await until(async () => anon.closed, 3000);
    expect(anon.closed?.code).toBe(4401);
    const evil = await Browser.open(w.owner.cookie, 'http://evil.example');
    await until(async () => evil.closed, 3000);
    expect(evil.closed?.code).toBe(4403);
    const noOrigin = await Browser.open(w.owner.cookie, null);
    await until(async () => noOrigin.closed, 3000);
    expect(noOrigin.closed?.code).toBe(4403);
  });

  it("delivers only events from the user's own org/projects, live and in seq order", async () => {
    const owner = await Browser.open(w.owner.cookie);
    await owner.hello();
    const ready = owner.of('ready')[0];
    expect(typeof ready.seq).toBe('number');

    const other = await w.t.userSession(uniqueEmail('other'));
    const otherBrowser = await Browser.open(other.cookie);
    await otherBrowser.hello();
    const otherProject = await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: other.cookie, body: { key: 'OTH', name: 'Other' } }),
      201,
    );

    const card = await w.card({ title: 'Visible card' });
    await ok(
      w.t.req('POST', `/api/cards/${card.id}/comments`, { cookie: w.owner.cookie, body: { body: 'hi' } }),
      201,
    );
    await owner.until(() => owner.events().some((e) => e.type === 'ThreadMessagePosted'));
    await otherBrowser.until(() => otherBrowser.events().some((e) => e.type === 'ProjectCreated'));

    const mine = owner.events();
    expect(mine.map((e) => e.seq)).toEqual([...mine.map((e) => e.seq)].sort((a, b) => a - b));
    expect(mine.some((e) => e.type === 'CardCreated' && e.payload.cardId === card.id)).toBe(true);
    expect(mine.every((e) => e.projectId === null || e.projectId === w.projectId)).toBe(true);
    expect(mine.some((e) => e.projectId === otherProject.project.id)).toBe(false);
    expect(otherBrowser.events().some((e) => e.type === 'CardCreated')).toBe(false);
    expect(otherBrowser.events().every((e) => e.projectId === otherProject.project.id)).toBe(true);
    expect(mine[0]).toMatchObject({
      type: expect.any(String),
      streamId: expect.any(String),
      actor: expect.any(Object),
      createdAt: expect.any(String),
    });
    owner.close();
    otherBrowser.close();
  });

  it('hello{lastSeq} replays missed visible events; resync when more than 500 behind', async () => {
    const b = await Browser.open(w.owner.cookie);
    await b.hello();
    const head = b.of('ready')[0].seq as number;
    b.close();
    const card = await w.card({ title: 'While away' });
    await ok(
      w.t.req('POST', `/api/cards/${card.id}/comments`, { cookie: w.owner.cookie, body: { body: 'missed' } }),
      201,
    );
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    await w.t.req('POST', '/api/projects', {
      cookie: stranger.cookie,
      body: { key: 'STR', name: 'Stranger' },
    });

    const again = await Browser.open(w.owner.cookie);
    await again.hello(head);
    const replayed = again.events();
    expect(replayed.map((e) => e.type)).toContain('CardCreated');
    expect(replayed.some((e) => e.type === 'ThreadMessagePosted' && e.payload.body === 'missed')).toBe(true);
    expect(replayed.every((e) => e.seq > head)).toBe(true);
    expect(replayed.some((e) => e.type === 'ProjectCreated' && e.payload.key === 'STR')).toBe(false);
    expect(again.of('resync')).toHaveLength(0);
    again.close();

    // 600 org events while away -> resync
    const behind = await Browser.open(w.owner.cookie);
    await behind.hello();
    const seq = behind.of('ready')[0].seq as number;
    behind.close();
    const wsId = randomUUID();
    await w.t.app.ctx.store.append(
      Array.from({ length: 600 }, (_, i) => ({
        streamId: streamId.workstation(wsId),
        event: { type: 'WorkstationRenamed' as const, payload: { workstationId: wsId, name: `n${i}` } },
        actor: { kind: 'system' as const, id: null },
        scope: { orgId: w.owner.id, projectId: null, audience: 'org' as const },
      })),
    );
    const late = await Browser.open(w.owner.cookie);
    await late.hello(seq);
    expect(late.of('resync')).toHaveLength(1);
    expect(late.events()).toHaveLength(0);
    expect(late.of('ready')).toHaveLength(1);
    late.close();
  });

  it('redacts credential hashes and gives admins only the admin audience', async () => {
    const admin = await w.t.userSession(uniqueEmail('admin'), 'admin');
    const b = await Browser.open(admin.cookie);
    await b.hello();
    await ok(
      w.t.req('POST', '/api/admin/invitations', {
        cookie: admin.cookie,
        body: { email: uniqueEmail('inv'), role: 'member' },
      }),
      201,
    );
    await w.card({ title: 'Admin must not see this' });
    await b.until(() => b.events().some((e) => e.type === 'UserInvited'));
    const invited = b.events().find((e) => e.type === 'UserInvited');
    expect(JSON.stringify(invited)).not.toContain('tokenHash');
    expect(b.events().some((e) => e.type === 'CardCreated')).toBe(false);
    expect(b.events().some((e) => e.type === 'ProjectCreated')).toBe(false);
    // deactivating the admin's own account closes sockets of that user
    const victim = await w.t.userSession(uniqueEmail('victim'));
    const vb = await Browser.open(victim.cookie);
    await vb.hello();
    await ok(
      w.t.req('PATCH', `/api/admin/users/${victim.id}`, {
        cookie: admin.cookie,
        body: { status: 'deactivated' },
      }),
    );
    await until(async () => vb.closed, 3000);
    expect(vb.closed?.code).toBe(4401);
    b.close();
  });

  it('forwards shift progress to authorised watchers and sends presence', async () => {
    const owner = await Browser.open(w.owner.cookie);
    await owner.hello();
    const r = await w.connectRunner();
    await owner.until(() =>
      owner.of('presence').some((p) => p.workstationId === w.workstationId && p.connected),
    );
    await w.hire('Watcher', 'builder', 'junior');
    await w.card({ title: 'Watched' });
    await w.t.app.ctx.services.dispatcher.run();
    const start = await r.waitFor('shift.start');
    const card = { id: start.brief.card.id };
    r.accepted(start.shiftId);
    r.started(start.shiftId);

    const stranger = await w.t.userSession(uniqueEmail('nosy'));
    const nosy = await Browser.open(stranger.cookie);
    await nosy.hello();
    nosy.send({ type: 'shift.watch', shiftId: start.shiftId });
    owner.send({ type: 'shift.watch', shiftId: start.shiftId });
    await new Promise((res) => setTimeout(res, 200));
    r.send('shift.progress', {
      shiftId: start.shiftId,
      items: [{ at: new Date().toISOString(), kind: 'text', text: 'thinking' }],
    });
    await owner.until(() => owner.of('shift.progress').length === 1);
    expect(owner.of('shift.progress')[0]).toMatchObject({
      shiftId: start.shiftId,
      cardId: card.id,
      items: [{ kind: 'text', text: 'thinking' }],
    });
    await new Promise((res) => setTimeout(res, 200));
    expect(nosy.of('shift.progress')).toHaveLength(0);
    // tail is also visible on the card detail
    const detail = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(detail.currentShift.progressTail[0].text).toBe('thinking');
    owner.send({ type: 'shift.unwatch', shiftId: start.shiftId });
    r.close();
    await owner.until(() => owner.of('presence').some((p) => p.connected === false));
    owner.send({ type: 'ping' });
    await owner.until(() => owner.of('pong').length === 1);
    owner.close();
    nosy.close();
  });
});

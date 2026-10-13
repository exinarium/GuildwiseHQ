import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { ORIGIN } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, type Member } from './helpers/members.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let manager: Member;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  manager = await addMember(w, 'manager');
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** The raw upload the web app sends: the file as the body, its name in the query. */
const upload = (cookie: string, cardId: string, name: string, body: Buffer, origin: string | null = ORIGIN) =>
  w.t.app.inject({
    method: 'POST',
    url: `/api/cards/${cardId}/attachments?name=${encodeURIComponent(name)}`,
    headers: {
      ...(origin ? { origin } : {}),
      cookie,
      'content-type': 'application/octet-stream',
    },
    payload: body,
  });
const fetchFile = (cookie: string, cardId: string, id: string, query = '') =>
  w.t.app.inject({
    method: 'GET',
    url: `/api/cards/${cardId}/attachments/${id}${query}`,
    headers: { cookie },
  });

describe('uploading, viewing and removing card attachments', () => {
  it('stores bytes outside the event log, lists them in the card detail and serves them safely', async () => {
    const card = await w.card();
    const seqBefore = (await q('SELECT COALESCE(max(seq),0) AS s FROM events'))[0]!.s;
    const res = await upload(w.owner.cookie, card.id, 'screen.png', PNG);
    expect(res.statusCode).toBe(201);
    const dto = res.json();
    expect(dto).toMatchObject({
      name: 'screen.png',
      contentType: 'image/png',
      size: PNG.length,
      sha256: sha(PNG),
      image: true,
      addedByAgent: false,
    });

    // metadata in the event, never the bytes
    const ev = (
      await q(`SELECT payload FROM events WHERE type='CardAttachmentAdded' AND seq > $1`, [seqBefore])
    )[0]!;
    expect(ev.payload).toMatchObject({
      cardId: card.id,
      attachmentId: dto.id,
      name: 'screen.png',
      size: PNG.length,
    });
    expect(JSON.stringify(ev.payload)).not.toContain(PNG.toString('base64'));
    expect(JSON.stringify(ev.payload)).not.toContain('iVBOR');
    expect((await q('SELECT length(data) AS n FROM card_attachment_data WHERE id=$1', [dto.id]))[0]!.n).toBe(
      PNG.length,
    );

    const detail = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(detail.attachments).toMatchObject([
      { id: dto.id, name: 'screen.png', addedByName: expect.any(String) },
    ]);
    expect(detail.permissions.canAttach).toBe(true);
    expect(detail.activity.map((a: any) => a.summary)).toContain('attached screen.png');

    const img = await fetchFile(w.owner.cookie, card.id, dto.id);
    expect(img.statusCode).toBe(200);
    expect(img.rawPayload.equals(PNG)).toBe(true);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['content-disposition']).toMatch(/^inline/);
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(String(img.headers['content-security-policy'])).toMatch(/^sandbox;/);
    const dl = await fetchFile(w.owner.cookie, card.id, dto.id, '?download=1');
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="screen.png"/);
    // listing endpoint with the limits
    const list = await ok<any>(
      w.t.req('GET', `/api/cards/${card.id}/attachments`, { cookie: w.owner.cookie }),
    );
    expect(list.attachments).toHaveLength(1);
    expect(list.limits).toMatchObject({ maxFileBytes: 20 * 1024 * 1024, maxCardBytes: 100 * 1024 * 1024 });
  });

  it('serves SVG as an image that cannot run script in the app origin, and HTML and text as plain-text downloads', async () => {
    const card = await w.card();
    const svg = (await upload(w.owner.cookie, card.id, 'SlideOutHistory.svg', SVG)).json();
    expect(svg.contentType).toBe('image/svg+xml');
    const s = await fetchFile(w.owner.cookie, card.id, svg.id);
    expect(s.headers['content-type']).toBe('image/svg+xml');
    expect(String(s.headers['content-security-policy'])).toContain('sandbox');
    expect(String(s.headers['content-security-policy'])).not.toContain('allow-scripts');
    expect(s.headers['x-content-type-options']).toBe('nosniff');
    expect(
      (await fetchFile(w.owner.cookie, card.id, svg.id, '?download=1')).headers['content-disposition'],
    ).toMatch(/^attachment/);

    const html = (
      await upload(w.owner.cookie, card.id, 'page.html', Buffer.from('<script>alert(1)</script>'))
    ).json();
    const h = await fetchFile(w.owner.cookie, card.id, html.id);
    expect(h.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(h.headers['content-disposition']).toMatch(/^attachment/);
  });

  it('refuses programs, disguised content, empty and oversized files, and unknown types', async () => {
    const card = await w.card();
    const bad: Array<[string, Buffer]> = [
      ['setup.exe', Buffer.from([0x4d, 0x5a, 1, 2, 3])],
      ['run.sh', Buffer.from('#!/bin/sh\necho hi')],
      ['photo.png', Buffer.from('this is not a png')],
      ['notes.txt', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1])],
      ['empty.txt', Buffer.alloc(0)],
      ['thing.xyz', Buffer.from('hello')],
    ];
    for (const [name, body] of bad) {
      const res = await upload(w.owner.cookie, card.id, name, body);
      expect([400, 422], name).toContain(res.statusCode);
    }
    const big = await upload(w.owner.cookie, card.id, 'big.txt', Buffer.alloc(20 * 1024 * 1024 + 1, 97));
    expect([413, 422]).toContain(big.statusCode);
    expect((await q('SELECT 1 FROM card_attachments WHERE card_id=$1', [card.id])).length).toBe(0);
  });

  it('is idempotent for the same file and limits the number of files on a card', async () => {
    const card = await w.card();
    const a = (await upload(w.owner.cookie, card.id, 'a.txt', Buffer.from('one'))).json();
    const again = (await upload(w.owner.cookie, card.id, 'a.txt', Buffer.from('one'))).json();
    expect(again.id).toBe(a.id);
    for (let i = 1; i < 50; i++) {
      expect((await upload(w.owner.cookie, card.id, `f${i}.txt`, Buffer.from(`file ${i}`))).statusCode).toBe(
        201,
      );
    }
    const over = await upload(w.owner.cookie, card.id, 'one-too-many.txt', Buffer.from('x'));
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('too_many_attachments');
  });

  it('lets only whoever may edit the card add or remove; every member can look; others see nothing', async () => {
    const card = await w.card();
    const att = (await upload(w.owner.cookie, card.id, 'a.png', PNG)).json();

    // a manager of the project who does not own the card
    const denied = await upload(manager.cookie, card.id, 'b.png', PNG);
    expect(denied.statusCode).toBe(403);
    expect(
      (await w.t.req('DELETE', `/api/cards/${card.id}/attachments/${att.id}`, { cookie: manager.cookie }))
        .status,
    ).toBe(403);
    expect((await fetchFile(manager.cookie, card.id, att.id)).statusCode).toBe(200);
    const detail = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: manager.cookie }));
    expect(detail.permissions.canAttach).toBe(false);
    expect(detail.attachments).toHaveLength(1);

    // a stranger: the card does not exist for them
    const stranger = await w.t.userSession(`stranger-${randomUUID().slice(0, 6)}@example.com`);
    expect((await fetchFile(stranger.cookie, card.id, att.id)).statusCode).toBe(404);
    expect((await upload(stranger.cookie, card.id, 'c.png', PNG)).statusCode).toBe(404);
    // no session, wrong origin
    expect((await upload('', card.id, 'c.png', PNG)).statusCode).toBe(401);
    expect((await upload(w.owner.cookie, card.id, 'c.png', PNG, 'http://evil.test')).statusCode).toBe(403);
  });

  it('removes the attachment, its bytes and records an event; a closed card keeps its files', async () => {
    const card = await w.card();
    const att = (await upload(w.owner.cookie, card.id, 'gone.png', PNG)).json();
    const del = await w.t.req('DELETE', `/api/cards/${card.id}/attachments/${att.id}`, {
      cookie: w.owner.cookie,
    });
    expect(del.status).toBe(204);
    expect(await q('SELECT 1 FROM card_attachment_data WHERE id=$1', [att.id])).toHaveLength(0);
    expect(await q('SELECT 1 FROM card_attachments WHERE id=$1', [att.id])).toHaveLength(0);
    const ev = (
      await q(`SELECT payload FROM events WHERE type='CardAttachmentRemoved' ORDER BY seq DESC LIMIT 1`)
    )[0]!;
    expect(ev.payload).toMatchObject({ cardId: card.id, attachmentId: att.id, name: 'gone.png' });
    expect((await fetchFile(w.owner.cookie, card.id, att.id)).statusCode).toBe(404);
    expect(
      (await w.t.req('DELETE', `/api/cards/${card.id}/attachments/${att.id}`, { cookie: w.owner.cookie }))
        .status,
    ).toBe(404);

    const kept = (await upload(w.owner.cookie, card.id, 'kept.png', PNG)).json();
    await ok(
      w.t.req('POST', `/api/cards/${card.id}/cancel`, {
        cookie: w.owner.cookie,
        body: { reason: 'not needed' },
      }),
    );
    expect((await upload(w.owner.cookie, card.id, 'late.png', PNG)).statusCode).toBe(409);
    expect((await fetchFile(w.owner.cookie, card.id, kept.id)).statusCode).toBe(200);
  });

  it('survives a projection rebuild: metadata is replayed from events, the bytes stay', async () => {
    const card = await w.card();
    const att = (await upload(w.owner.cookie, card.id, 'rebuild.png', PNG)).json();
    const gone = (
      await upload(w.owner.cookie, card.id, 'removed.png', Buffer.concat([PNG, Buffer.from([9])]))
    ).json();
    await w.t.req('DELETE', `/api/cards/${card.id}/attachments/${gone.id}`, { cookie: w.owner.cookie });
    const before = await q(
      'SELECT id, name, content_type, size, sha256, source, created_at FROM card_attachments ORDER BY id',
    );
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const after = await q(
      'SELECT id, name, content_type, size, sha256, source, created_at FROM card_attachments ORDER BY id',
    );
    expect(after).toEqual(before);
    expect(after.map((a) => a.id)).toContain(att.id);
    expect(after.map((a) => a.id)).not.toContain(gone.id);
    expect((await fetchFile(w.owner.cookie, card.id, att.id)).rawPayload.equals(PNG)).toBe(true);
  });
});

describe('a card shift gets the attachments of its card', () => {
  it('carries them in the brief and lets the runner of that shift (only) download them', async () => {
    await w.hire('Una', 'builder', 'junior');
    // only the two cards of this test are in the queue
    await q(`UPDATE cards SET status='cancelled' WHERE status='queued'`);
    const card = await w.card();
    const att = (await upload(w.owner.cookie, card.id, 'target.svg', SVG)).json();
    const other = await w.card();
    const otherAtt = (await upload(w.owner.cookie, other.id, 'other.png', PNG)).json();
    const from = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    const start = (await r.waitFor(
      'shift.start',
      (f) => f.brief.card.id === card.id || f.brief.card.id === other.id,
      8000,
      from,
    )) as any;
    const mine = start.brief.card.id === card.id ? att : otherAtt;
    expect(start.brief.card.attachments).toMatchObject([
      { id: mine.id, name: mine.name, sha256: mine.sha256 },
    ]);
    r.accepted(start.shiftId);
    r.started(start.shiftId);
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
      3000,
      'shift running',
    );
    const get = (id: string, token = w.runnerToken, shift = start.shiftId) =>
      w.t.app.inject({
        method: 'GET',
        url: `/api/runner/attachments/${id}?shift=${shift}`,
        headers: { authorization: `Bearer ${token}` },
      });
    const ok1 = await get(mine.id);
    expect(ok1.statusCode).toBe(200);
    expect(sha(ok1.rawPayload)).toBe(mine.sha256);
    // another card's file, another runner, no token: refused
    const theirs = mine.id === att.id ? otherAtt : att;
    expect((await get(theirs.id)).statusCode).toBe(403);
    expect((await get(mine.id, manager.runnerToken)).statusCode).toBe(404);
    expect((await get(mine.id, 'aomr_nonsense')).statusCode).toBe(401);
    expect(
      (
        await w.t.app.inject({
          method: 'GET',
          url: `/api/runner/attachments/${mine.id}?shift=${start.shiftId}`,
        })
      ).statusCode,
    ).toBe(401);
    // the shift can list its card's attachments through the rpc
    const rpcId = randomUUID();
    const f2 = r.received.length;
    r.send('rpc.request', { rpcId, shiftId: start.shiftId, method: 'card.attachments', params: {} });
    const res = (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 5000, f2)) as any;
    expect(res.ok).toBe(true);
    expect(res.result.cards[0].attachments[0].id).toBe(mine.id);
    // ... but cannot attach (only the BA's intake can)
    const rpcId2 = randomUUID();
    const f3 = r.received.length;
    r.send('rpc.request', {
      rpcId: rpcId2,
      shiftId: start.shiftId,
      method: 'card.attach.begin',
      params: { name: 'x.png', size: PNG.length, sha256: sha(PNG) },
    });
    const res2 = (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId2, 5000, f3)) as any;
    expect(res2.ok).toBe(false);
  });
});

describe('the BA attaches files to the cards of its intake', () => {
  async function openIntake() {
    await q('TRUNCATE intakes, intake_cards CASCADE');
    await w.hire('Ben', 'ba', 'senior');
    const from = r.received.length;
    const { intake } = await ok<any>(
      w.t.req('POST', '/api/intakes', { cookie: w.owner.cookie, body: { note: 'DCPL-4276' } }),
      201,
    );
    const start = (await r.waitFor('chat.start', (f) => f.threadId === intake.threadId, 15_000, from)) as any;
    return { intake, start };
  }
  const rpc = async (chatId: string, method: string, params: Record<string, unknown> = {}) => {
    const rpcId = randomUUID();
    const from = r.received.length;
    r.send('rpc.request', { rpcId, shiftId: chatId, method, params });
    return (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, from)) as any;
  };
  const draft = {
    title: 'Slide-out history',
    cardType: 'feature',
    completionAction: 'pr',
    repo: 'toy',
    externalRef: 'DCPL-4276',
    fields: {
      context: 'DCPL-4276',
      requirements: 'Build the panel as in the SVG.',
      acceptanceCriteria: ['Matches the SVG'],
      affectedAreas: 'apps/web',
      constraints: 'none',
      testPlan: 'unit',
    },
  };
  const put = (token: string, uploadId: string, body: Buffer) =>
    w.t.app.inject({
      method: 'PUT',
      url: `/api/runner/uploads/${uploadId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      payload: body,
    });

  it('hands out an upload ticket for its own cards only, then stores the bytes as the BA', async () => {
    const { start } = await openIntake();
    expect((await rpc(start.chatId, 'intake.map', { project: 'toy' })).ok).toBe(true);
    expect((await rpc(start.chatId, 'card.create', draft)).ok).toBe(true);
    const cardRef = (await q(`SELECT ref FROM cards ORDER BY created_at DESC LIMIT 1`))[0]!.ref as string;
    const foreign = await w.card();

    // not a card of this intake, not an unknown card
    const bad = await rpc(start.chatId, 'card.attach.begin', {
      ref: foreign.ref,
      name: 'x.svg',
      size: SVG.length,
      sha256: sha(SVG),
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/not a card you can attach files to/);

    // the ticket (the card is the only one of the intake, so no ref is needed)
    const begin = await rpc(start.chatId, 'card.attach.begin', {
      name: 'SlideOutHistory.svg',
      size: SVG.length,
      sha256: sha(SVG),
      source: 'jira DCPL-4276',
    });
    expect(begin).toMatchObject({ ok: true, result: { ref: cardRef, name: 'SlideOutHistory.svg' } });
    const uploadId = begin.result.uploadId as string;

    // wrong bytes, wrong runner, no token: refused; the ticket survives a refusal
    expect((await put(w.runnerToken, uploadId, Buffer.from('<svg>tampered</svg>'))).statusCode).toBe(422);
    expect((await put(manager.runnerToken, uploadId, SVG)).statusCode).toBe(404);
    expect(
      (await w.t.app.inject({ method: 'PUT', url: `/api/runner/uploads/${uploadId}`, payload: SVG }))
        .statusCode,
    ).toBe(401);

    const done = await put(w.runnerToken, uploadId, SVG);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({
      name: 'SlideOutHistory.svg',
      addedByAgent: true,
      addedByName: 'Ben',
      source: 'jira DCPL-4276',
    });
    const ev = (
      await q(
        `SELECT actor_kind, payload FROM events WHERE type='CardAttachmentAdded' ORDER BY seq DESC LIMIT 1`,
      )
    )[0]!;
    expect(ev.actor_kind).toBe('agent');
    expect(ev.payload.source).toBe('jira DCPL-4276');
    // single use
    expect((await put(w.runnerToken, uploadId, SVG)).statusCode).toBe(404);

    // the BA lists the attachments of its cards; its chat may download them for the runner
    const list = await rpc(start.chatId, 'card.attachments');
    expect(list.result.cards[0]).toMatchObject({
      ref: cardRef,
      attachments: [{ name: 'SlideOutHistory.svg' }],
    });
    const dl = await w.t.app.inject({
      method: 'GET',
      url: `/api/runner/attachments/${done.json().id}?shift=${start.chatId}`,
      headers: { authorization: `Bearer ${w.runnerToken}` },
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(SVG)).toBe(true);
    // a rejected type never gets a ticket's bytes stored
    const exe = await rpc(start.chatId, 'card.attach.begin', {
      name: 'a.exe',
      size: 5,
      sha256: sha(Buffer.from('hello')),
    });
    expect(exe.ok).toBe(true);
    expect((await put(w.runnerToken, exe.result.uploadId, Buffer.from('hello'))).statusCode).toBe(422);
  });
});

import { createHash } from 'node:crypto';
import { VaultWriteCommandSchema, VaultWriteFileCommandSchema } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { ORIGIN, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, type Member } from './helpers/members.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/** Document tags, search, and uploads (a file becomes an approved document published through the vault queue). */
let w: World;
let r: FakeRunner;
let member: Member;
let orgId: string;
let plain: { id: string; cookie: string; email: string };
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  member = await addMember(w, 'member');
  orgId = (await q('SELECT id FROM organizations WHERE owner_user_id=$1', [w.owner.id]))[0]?.id as string;
  // an organization member who is on no project
  plain = await w.t.userSession(uniqueEmail('plain'));
  await w.t.addOrgMember(orgId, plain.id, 'member');
  await ok(
    w.t.req('POST', '/api/vaults', {
      cookie: w.owner.cookie,
      body: { kind: 'org', remoteUrl: 'git@example.test:srv/docs.git' },
    }),
    201,
  );
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const call = (method: string, url: string, body?: unknown, expected = 200) =>
  // biome-ignore lint/suspicious/noExplicitAny: a response body
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );
const raw = (method: string, url: string, body?: unknown, cookie = w.owner.cookie) =>
  w.t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) });
const create = async (over: Record<string, unknown> = {}) =>
  (
    await call(
      'POST',
      '/api/documents',
      { kind: 'prd', title: 'Doc', projectId: w.projectId, content: 'text', ...over },
      201,
    )
  ).document;
const asOrg = (cookie: string, method: string, url: string, body?: unknown) =>
  w.t.req(method, url, {
    cookie,
    headers: { 'x-aom-org': orgId },
    ...(body !== undefined ? { body } : {}),
  });
const ids = (list: Array<{ id: string }>) => list.map((d) => d.id);
const listIds = async (query: string, cookie = w.owner.cookie) =>
  ids(
    (await ok<{ documents: Array<{ id: string }> }>(w.t.req('GET', `/api/documents${query}`, { cookie })))
      .documents,
  );
const upload = (cookie: string, name: string, body: Buffer, query = '', origin: string | null = ORIGIN) =>
  w.t.app.inject({
    method: 'POST',
    url: `/api/documents/upload?name=${encodeURIComponent(name)}${query}`,
    headers: {
      ...(origin ? { origin } : {}),
      cookie,
      'x-aom-org': orgId,
      'content-type': 'application/octet-stream',
    },
    payload: body,
  });
const commands = (type: string) => r.of('command').filter((c) => c.command === type);
const fileRows = async (id: string) =>
  Number((await q('SELECT count(*) AS n FROM document_file_data WHERE document_id=$1', [id]))[0]?.n);
const counts = async () => ({
  docs: Number((await q('SELECT count(*) AS n FROM documents'))[0]?.n),
  data: Number((await q('SELECT count(*) AS n FROM document_file_data'))[0]?.n),
  writes: commands('vault.write').length + commands('vault.write_file').length,
});

describe('document tags', () => {
  it('sets tags at creation, normalizes them and leaves untagged documents without a tags key', async () => {
    const tagged = await create({ title: 'Tagged', tags: ['Release Notes', 'q4', 'q4', ''] });
    expect(tagged.tags).toEqual(['release-notes', 'q4']);
    const untagged = await create({ title: 'Plain' });
    expect('tags' in untagged).toBe(false);
    expect('file' in untagged).toBe(false);
    const listed = (await call('GET', '/api/documents')).documents as Array<Record<string, unknown>>;
    expect('tags' in (listed.find((d) => d.id === untagged.id) as object)).toBe(false);
    expect((listed.find((d) => d.id === tagged.id) as { tags: string[] }).tags).toEqual([
      'release-notes',
      'q4',
    ]);
    expect(
      (await raw('POST', '/api/documents', { kind: 'prd', title: 'x', tags: Array(21).fill('a') })).status,
    ).toBe(400);
  });

  it('edits tags later and keeps them across new versions and status changes', async () => {
    const d = await create({ title: 'Keep my tags' });
    const set = (await call('PUT', `/api/documents/${d.id}/tags`, { tags: ['Alpha', 'beta'] })).document;
    expect(set.tags).toEqual(['alpha', 'beta']);
    const v2 = (await call('POST', `/api/documents/${d.id}/versions`, { content: 'second' }, 201)).document;
    expect(v2.tags).toEqual(['alpha', 'beta']);
    await call('POST', `/api/documents/${d.id}/status`, { status: 'in_review' });
    const approved = (await call('POST', `/api/documents/${d.id}/status`, { status: 'approved' })).document;
    expect(approved.tags).toEqual(['alpha', 'beta']);
    // tags can change in any status, and an unchanged set appends no event
    const events = async () =>
      Number((await q(`SELECT count(*) AS n FROM events WHERE type='DocumentTagsChanged'`))[0]?.n);
    const before = await events();
    await call('PUT', `/api/documents/${d.id}/tags`, { tags: ['alpha', 'beta'] });
    expect(await events()).toBe(before);
    const cleared = (await call('PUT', `/api/documents/${d.id}/tags`, { tags: [] })).document;
    expect('tags' in cleared).toBe(false);
    expect(await events()).toBe(before + 1);
  });

  it('re-publishes an approved document when its tags change, with the tags in the vault copy', async () => {
    const d = await create({ title: 'Republish tags', content: 'body' });
    await call('POST', `/api/documents/${d.id}/status`, { status: 'in_review' });
    await call('POST', `/api/documents/${d.id}/status`, { status: 'approved' });
    const before = commands('vault.write').length;
    await call('PUT', `/api/documents/${d.id}/tags`, { tags: ['handbook'] });
    await until(async () => commands('vault.write').length > before);
    const cmd = VaultWriteCommandSchema.parse(commands('vault.write').at(-1)?.payload);
    expect(cmd.content).toContain('tags: ["handbook"]');
  });

  it('only an Owner or Admin changes tags, and a stranger cannot see the document', async () => {
    const d = await create({ title: 'Guarded tags' });
    expect((await asOrg(plain.cookie, 'PUT', `/api/documents/${d.id}/tags`, { tags: ['x'] })).status).toBe(
      403,
    );
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect(
      (await raw('PUT', `/api/documents/${d.id}/tags`, { tags: ['x'] }, stranger.cookie)).status,
    ).not.toBe(200);
  });

  it('survives a projection rebuild', async () => {
    const d = await create({ title: 'Rebuilt tags', tags: ['one'] });
    await call('PUT', `/api/documents/${d.id}/tags`, { tags: ['one', 'two'] });
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect((await call('GET', `/api/documents/${d.id}`)).document.tags).toEqual(['one', 'two']);
  });
});

describe('searching and filtering', () => {
  it('searches title, file name and current text, every word must match', async () => {
    const a = await create({ title: 'Quarterly roadmap', content: 'Focus on onboarding' });
    const b = await create({ title: 'Other', content: 'The roadmap mentions billing' });
    const c = await create({ title: 'Unrelated', content: 'nothing' });
    expect(await listIds('?q=roadmap')).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(await listIds('?q=roadmap')).not.toContain(c.id);
    expect(await listIds('?q=roadmap%20billing')).toEqual([b.id]);
    expect(await listIds('?q=ROADMAP%20onboarding')).toEqual([a.id]);
    // an old version's text is not searched
    await call('POST', `/api/documents/${c.id}/versions`, { content: 'now about zebrafish' }, 201);
    expect(await listIds('?q=zebrafish')).toEqual([c.id]);
    await call('POST', `/api/documents/${c.id}/versions`, { content: 'changed again' }, 201);
    expect(await listIds('?q=zebrafish')).toEqual([]);
    // LIKE wildcards are literal
    expect(await listIds('?q=%25')).toEqual([]);
    expect(await listIds('?q=_')).toEqual([]);
  });

  it('filters by one or more tags (all must be present) combined with kind and status', async () => {
    const x = await create({ title: 'Tag filter X', kind: 'prd', tags: ['red', 'blue'] });
    const y = await create({ title: 'Tag filter Y', kind: 'minutes', tags: ['red'] });
    expect(await listIds('?tags=red')).toEqual(expect.arrayContaining([x.id, y.id]));
    expect(await listIds('?tags=red,blue')).toEqual([x.id]);
    expect(await listIds('?tags=Red,%20BLUE')).toEqual([x.id]);
    expect(await listIds('?tags=red&kind=minutes')).toEqual([y.id]);
    await call('POST', `/api/documents/${x.id}/status`, { status: 'in_review' });
    expect(await listIds('?tags=red&status=in_review')).toEqual([x.id]);
    expect(await listIds('?tags=red,blue&q=filter%20x&kind=prd&status=in_review')).toEqual([x.id]);
    expect(await listIds('?tags=missing')).toEqual([]);
    const tags = (await call('GET', '/api/documents/tags')).tags as Array<{ tag: string; count: number }>;
    expect(tags.find((t) => t.tag === 'red')?.count).toBeGreaterThanOrEqual(2);
  });

  it('never returns documents (or tag counts) of a project the user cannot see', async () => {
    const secret = await create({ title: 'Secret plan zzq', tags: ['secretonly'], content: 'zzq' });
    const open = await create({
      title: 'Org zzq',
      projectId: undefined,
      kind: 'brief',
      tags: ['secretonly'],
    });
    const outsider = await w.t.userSession(uniqueEmail('outsider'));
    await w.t.addOrgMember(orgId, outsider.id, 'member');
    const asOutsider = (url: string) => asOrg(outsider.cookie, 'GET', url);
    for (const query of ['?q=zzq', '?tags=secretonly', '?q=zzq&tags=secretonly', '']) {
      const list = ids((await ok(asOutsider(`/api/documents${query}`))).documents);
      expect(list).not.toContain(secret.id);
      if (query) expect(list).toContain(open.id);
    }
    const tags = (await ok(asOutsider('/api/documents/tags'))).tags as Array<{ tag: string; count: number }>;
    expect(tags.find((t) => t.tag === 'secretonly')?.count).toBe(1);
  });
});

describe('uploading a document', () => {
  it('turns a markdown file into an approved text document and publishes it through the vault queue', async () => {
    const before = commands('vault.write').length;
    const res = await upload(
      w.owner.cookie,
      'Handbook.md',
      Buffer.from('# Handbook\n\nHello'),
      `&projectId=${w.projectId}&tags=Policy,hr`,
    );
    expect(res.statusCode).toBe(201);
    const d = res.json().document;
    expect(d).toMatchObject({
      kind: 'file',
      title: 'Handbook',
      status: 'approved',
      approvedVersion: 1,
      projectId: w.projectId,
      content: '# Handbook\n\nHello',
      tags: ['policy', 'hr'],
    });
    expect('file' in d).toBe(false);
    expect(await listIds('?tags=policy')).toContain(d.id);
    await until(async () => commands('vault.write').length > before);
    const cmd = VaultWriteCommandSchema.parse(commands('vault.write').at(-1)?.payload);
    expect(cmd).toMatchObject({ path: 'projects/toy/docs/handbook.md', mode: 'replace' });
    expect(cmd.content).toContain('tags: ["policy", "hr"]');
    expect(cmd.content).toContain('# Handbook');
    expect(await fileRows(d.id)).toBe(0);
    // the trail respects the allowed transitions
    const trail = await q(
      `SELECT payload FROM events WHERE type='DocumentStatusChanged' AND payload->>'docId'=$1 ORDER BY seq`,
      [d.id],
    );
    expect(trail.map((e) => `${e.payload.from}>${e.payload.to}`)).toEqual([
      'draft>in_review',
      'in_review>approved',
    ]);
  });

  it('keeps a binary file as a file document: the file command comes before the sidecar, same workstation', async () => {
    const files = commands('vault.write_file').length;
    const writes = commands('vault.write').length;
    const res = await upload(w.owner.cookie, 'diagram.png', PNG, '&title=Architecture%20diagram&tags=design');
    expect(res.statusCode).toBe(201);
    const d = res.json().document;
    expect(d).toMatchObject({
      kind: 'file',
      title: 'Architecture diagram',
      status: 'approved',
      tags: ['design'],
      file: {
        name: 'diagram.png',
        contentType: 'image/png',
        size: PNG.length,
        sha256: sha(PNG),
        image: true,
      },
    });
    await until(
      async () => commands('vault.write_file').length > files && commands('vault.write').length > writes,
    );
    const fileCmd = commands('vault.write_file').at(-1);
    const parsed = VaultWriteFileCommandSchema.parse(fileCmd?.payload);
    expect(parsed).toMatchObject({
      path: 'org/docs/files/architecture-diagram.png',
      documentId: d.id,
      sha256: sha(PNG),
      size: PNG.length,
    });
    const sidecar = VaultWriteCommandSchema.parse(commands('vault.write').at(-1)?.payload);
    expect(sidecar.path).toBe('org/docs/architecture-diagram.md');
    expect(sidecar.content).toContain('file: "files/architecture-diagram.png"');
    expect(sidecar.content).toContain('file_name: "diagram.png"');
    // the command was sent before the sidecar
    const order = r.of('command').map((c) => c.command);
    expect(order.lastIndexOf('vault.write_file')).toBeLessThan(order.lastIndexOf('vault.write'));

    // the owner can download it, safely
    const file = await w.t.app.inject({
      method: 'GET',
      url: `/api/documents/${d.id}/file`,
      headers: { cookie: w.owner.cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(String(file.headers['content-security-policy'])).toContain('sandbox');

    // the runner may fetch it only while its command is waiting
    const get = (token: string) =>
      w.t.app.inject({
        method: 'GET',
        url: `/api/runner/document-files/${d.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await get(w.runnerToken)).statusCode).toBe(200);
    expect((await get(member.runnerToken)).statusCode).toBe(404);
    expect(
      (await w.t.app.inject({ method: 'GET', url: `/api/runner/document-files/${d.id}` })).statusCode,
    ).toBe(401);
    r.send('command.result', { commandId: fileCmd?.commandId, ok: true, result: { committed: true } });
    await until(async () => (await get(w.runnerToken)).statusCode === 404);
  });

  it('approves a file document whose text is empty, and survives a rebuild', async () => {
    const res = await upload(w.owner.cookie, 'pic.png', PNG);
    const d = res.json().document;
    expect(d.status).toBe('approved');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    const again = (await call('GET', `/api/documents/${d.id}`)).document;
    expect(again.file).toMatchObject({ name: 'pic.png', size: PNG.length });
    expect(await fileRows(d.id)).toBe(1);
    expect(await listIds('?q=pic.png')).toContain(d.id);
  });

  it('rejects a bad upload with a clear error and writes nothing', async () => {
    const before = await counts();
    const check = async (res: Awaited<ReturnType<typeof upload>>, status: number, text?: string) => {
      expect(res.statusCode).toBe(status);
      if (text) expect(res.body).toContain(text);
    };
    await check(await upload(w.owner.cookie, 'run.exe', Buffer.from('MZ\x90\x00')), 422, 'document_rejected');
    await check(await upload(w.owner.cookie, 'notes.xyz', Buffer.from('x')), 422, 'not an allowed');
    await check(await upload(w.owner.cookie, 'empty.txt', Buffer.alloc(0)), 422, 'the file is empty');
    await check(await upload(w.owner.cookie, 'fake.png', Buffer.from('not a png')), 422, 'not a valid');
    await check(await upload(w.owner.cookie, 'bad.txt', Buffer.from([0xff, 0xfe, 0xfd])), 422);
    await check(
      await upload(w.owner.cookie, 'big.png', Buffer.concat([PNG, Buffer.alloc(21 * 1024 * 1024)])),
      413,
    );
    await check(
      await upload(
        w.owner.cookie,
        'many.txt',
        Buffer.from('x'),
        `&tags=${Array.from({ length: 21 }, (_, i) => `t${i}`).join(',')}`,
      ),
      400,
      'too_many_tags',
    );
    // an organization member who is no Owner or Admin may not upload
    await check(await upload(plain.cookie, 'a.txt', Buffer.from('x')), 403);
    // a project that does not exist (or is not visible to the caller) looks the same: not found
    const unknown = await upload(
      w.owner.cookie,
      'a.txt',
      Buffer.from('x'),
      '&projectId=00000000-0000-4000-8000-000000000000',
    );
    expect(unknown.statusCode).toBe(404);
    await new Promise((res) => setTimeout(res, 200));
    expect(await counts()).toEqual(before);
  });

  it('refuses a cross-site upload', async () => {
    expect(
      (await upload(w.owner.cookie, 'x.txt', Buffer.from('x'), '', 'https://evil.example')).statusCode,
    ).toBe(403);
  });
});

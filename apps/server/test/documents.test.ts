import { randomUUID } from 'node:crypto';
import { VaultWriteCommandSchema } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishPendingDocuments } from '../src/commands/documents.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/** Documents: versions, status flow, the vault publish on approval (with retry) and replay safety. */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

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
      { kind: 'prd', title: 'Invoicing PRD', projectId: w.projectId, content: '# PRD\n\nv1', ...over },
      201,
    )
  ).document;
const status = (id: string, to: string) => call('POST', `/api/documents/${id}/status`, { status: to });
const docRow = async (id: string) => (await q('SELECT * FROM documents WHERE id=$1', [id]))[0];
const writes = () => r.of('command').filter((c) => c.command === 'vault.write');

describe('documents', () => {
  it('creates a document with a first version and a unique slug', async () => {
    const d = await create();
    expect(d).toMatchObject({
      kind: 'prd',
      title: 'Invoicing PRD',
      slug: 'invoicing-prd',
      status: 'draft',
      currentVersion: 1,
      approvedVersion: null,
      publishState: 'none',
      projectId: w.projectId,
      content: '# PRD\n\nv1',
    });
    expect(d.versions).toHaveLength(1);
    const again = await create();
    expect(again.slug).toBe('invoicing-prd-2');
    const org = await create({ projectId: undefined, kind: 'brief', title: 'Invoicing PRD' });
    expect(org).toMatchObject({ slug: 'invoicing-prd', projectId: null, kind: 'brief' });
    expect((await raw('POST', '/api/documents', { kind: 'prd', title: '' })).status).toBe(400);
    expect((await raw('POST', '/api/documents', { kind: 'nope', title: 'x' })).status).toBe(400);
  });

  it('saves versions, refuses a stale base and ignores an identical save', async () => {
    const d = await create({ title: 'Versions' });
    const v2 = (
      await call(
        'POST',
        `/api/documents/${d.id}/versions`,
        { content: 'second', baseVersion: 1, note: 'tweak' },
        201,
      )
    ).document;
    expect(v2).toMatchObject({ currentVersion: 2, content: 'second' });
    expect(v2.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const stale = await raw('POST', `/api/documents/${d.id}/versions`, { content: 'third', baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain('version_conflict');
    const same = (await call('POST', `/api/documents/${d.id}/versions`, { content: 'second' }, 201)).document;
    expect(same.currentVersion).toBe(2);
    const titled = (
      await call(
        'POST',
        `/api/documents/${d.id}/versions`,
        { content: 'third', title: 'Versions renamed' },
        201,
      )
    ).document;
    expect(titled).toMatchObject({ currentVersion: 3, title: 'Versions renamed', slug: 'versions' });
    const old = (await call('GET', `/api/documents/${d.id}/versions/1`)).version;
    expect(old).toMatchObject({ version: 1, content: '# PRD\n\nv1', savedBy: { kind: 'user' } });
    expect((await raw('GET', `/api/documents/${d.id}/versions/9`)).status).toBe(404);
  });

  it('follows the status flow and locks an approved document', async () => {
    const d = await create({ title: 'Flow' });
    expect((await raw('POST', `/api/documents/${d.id}/status`, { status: 'approved' })).status).toBe(409);
    expect((await status(d.id, 'in_review')).document.status).toBe('in_review');
    // still editable while in review
    await call('POST', `/api/documents/${d.id}/versions`, { content: 'reviewed' }, 201);
    const approved = (await status(d.id, 'approved')).document;
    expect(approved).toMatchObject({ status: 'approved', approvedVersion: 2, publishState: 'pending' });
    const locked = await raw('POST', `/api/documents/${d.id}/versions`, { content: 'sneaky' });
    expect(locked.status).toBe(409);
    expect(JSON.stringify(locked.body)).toContain('document_locked');
    expect((await status(d.id, 'draft')).document).toMatchObject({ status: 'draft', approvedVersion: null });
    await call('POST', `/api/documents/${d.id}/versions`, { content: 'reopened' }, 201);
    expect((await raw('POST', `/api/documents/${d.id}/status`, { status: 'handed_off' })).status).toBe(409);
  });

  it('refuses to approve an empty document', async () => {
    const d = await create({ title: 'Empty', content: '  ' });
    await status(d.id, 'in_review');
    const res = await raw('POST', `/api/documents/${d.id}/status`, { status: 'approved' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('document_empty');
  });

  it('lists per project and organization with filters, and hides documents from strangers', async () => {
    const proj = await create({ title: 'Listed project doc', kind: 'minutes' });
    const org = await create({ title: 'Listed org doc', kind: 'brief', projectId: undefined });
    const all = (await call('GET', '/api/documents')).documents as Array<{ id: string }>;
    expect(all.map((d) => d.id)).toEqual(expect.arrayContaining([proj.id, org.id]));
    const byProject = (await call('GET', `/api/documents?projectId=${w.projectId}`)).documents;
    expect(byProject.map((d: { id: string }) => d.id)).toContain(proj.id);
    expect(byProject.map((d: { id: string }) => d.id)).not.toContain(org.id);
    const orgOnly = (await call('GET', '/api/documents?orgOnly=true')).documents;
    expect(orgOnly.map((d: { id: string }) => d.id)).toContain(org.id);
    expect(orgOnly.map((d: { id: string }) => d.id)).not.toContain(proj.id);
    expect(
      (await call('GET', '/api/documents?kind=minutes')).documents.every(
        (d: { kind: string }) => d.kind === 'minutes',
      ),
    ).toBe(true);
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect((await raw('GET', `/api/documents/${proj.id}`, undefined, stranger.cookie)).status).not.toBe(200);
    expect((await raw('GET', '/api/documents', undefined, stranger.cookie)).body.documents ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: proj.id })]),
    );
  });

  it('lets a project member read a project document but not change it, and hides it from other members', async () => {
    const org = (await q('SELECT id FROM organizations WHERE owner_user_id=$1', [w.owner.id]))[0]
      ?.id as string;
    const as = (u: { cookie: string }, method: string, url: string, body?: unknown) =>
      w.t.req(method, url, {
        cookie: u.cookie,
        headers: { 'x-aom-org': org },
        ...(body !== undefined ? { body } : {}),
      });
    const reader = await w.t.userSession(uniqueEmail('reader'));
    const outsider = await w.t.userSession(uniqueEmail('outsider'));
    await w.t.addOrgMember(org, reader.id, 'member');
    await w.t.addOrgMember(org, outsider.id, 'member');
    await ok(as(w.owner, 'POST', `/api/projects/${w.projectId}/members`, { email: reader.email }), 201);
    const d = await create({ title: 'Shared read' });
    const orgDoc = await create({ title: 'Org read', projectId: undefined, kind: 'brief' });
    expect((await as(reader, 'GET', `/api/documents/${d.id}`)).status).toBe(200);
    expect((await as(reader, 'POST', `/api/documents/${d.id}/versions`, { content: 'x' })).status).toBe(403);
    expect((await as(reader, 'POST', `/api/documents/${d.id}/status`, { status: 'in_review' })).status).toBe(
      403,
    );
    expect((await as(reader, 'POST', '/api/documents', { kind: 'prd', title: 'x' })).status).toBe(403);
    // a member of the organization who is not on the project sees the organization's documents only
    expect((await as(outsider, 'GET', `/api/documents/${d.id}`)).status).toBe(404);
    expect((await as(outsider, 'GET', `/api/documents/${orgDoc.id}`)).status).toBe(200);
    const listed = (await as(outsider, 'GET', '/api/documents')).body.documents.map(
      (x: { id: string }) => x.id,
    );
    expect(listed).toContain(orgDoc.id);
    expect(listed).not.toContain(d.id);
  });

  it('links source sessions and refuses sessions that are not the caller’s', async () => {
    const session = (await call('POST', '/api/sessions', { kind: 'discovery', title: 'Source' }, 201))
      .session;
    const d = await create({ title: 'From a session', sourceThreadIds: [session.threadId] });
    expect(d.sourceThreadIds).toEqual([session.threadId]);
    expect(
      (await call('GET', `/api/documents?threadId=${session.threadId}`)).documents.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([d.id]);
    expect(
      (await raw('POST', '/api/documents', { kind: 'prd', title: 'x', sourceThreadIds: [randomUUID()] }))
        .status,
    ).toBe(400);
  });
});

describe('publishing to the vault', () => {
  it('keeps an approved document pending without a vault and publishes it once there is one', async () => {
    const d = await create({ title: 'Publish me', content: '# Publish me\n\nBody.' });
    await status(d.id, 'in_review');
    const approved = (await status(d.id, 'approved')).document;
    expect(approved.publishState).toBe('pending');
    expect(writes()).toHaveLength(0);
    expect(await publishPendingDocuments(w.t.app.ctx)).toBe(0);

    const vault = await call(
      'POST',
      '/api/vaults',
      { kind: 'org', remoteUrl: 'git@example.test:srv/docs.git' },
      201,
    );
    expect(await publishPendingDocuments(w.t.app.ctx)).toBeGreaterThanOrEqual(1);
    const cmd = await r.waitFor(
      'command',
      (f) => f.command === 'vault.write' && String(f.payload.path).endsWith('/publish-me.md'),
    );
    const payload = VaultWriteCommandSchema.parse(cmd.payload);
    expect(payload).toMatchObject({
      vaultId: vault.id,
      path: 'projects/toy/docs/publish-me.md',
      mode: 'replace',
      push: true,
    });
    expect(payload.content).toContain('title: "Publish me"');
    expect(payload.content).toContain(`document_id: ${d.id}`);
    expect(payload.content).toContain('version: 1');
    expect(payload.content).toContain('# Publish me\n\nBody.');
    const row = await docRow(d.id);
    expect(row).toMatchObject({
      publish_state: 'queued',
      published_version: 1,
      vault_path: 'projects/toy/docs/publish-me.md',
    });
    // nothing more to do
    expect(await publishPendingDocuments(w.t.app.ctx)).toBe(0);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { committed: true, pushed: true },
    });
  });

  it('publishes straight away on approval when a vault exists, to org/docs for an organization document', async () => {
    const before = writes().length;
    const d = await create({
      title: 'Org level brief',
      kind: 'brief',
      projectId: undefined,
      content: 'Brief body',
    });
    await status(d.id, 'in_review');
    const out = (await status(d.id, 'approved')).document;
    expect(out.publishState).toBe('queued');
    expect(out.vaultPath).toBe('org/docs/org-level-brief.md');
    await until(async () => writes().length > before);
    const cmd = writes().at(-1);
    expect(VaultWriteCommandSchema.parse(cmd?.payload).path).toBe('org/docs/org-level-brief.md');
  });

  it('publishes the new version after a reopen and a second approval', async () => {
    const d = await create({ title: 'Twice approved', content: 'first' });
    await status(d.id, 'in_review');
    await status(d.id, 'approved');
    await status(d.id, 'draft');
    await call('POST', `/api/documents/${d.id}/versions`, { content: 'second' }, 201);
    await status(d.id, 'in_review');
    const before = writes().length;
    const out = (await status(d.id, 'approved')).document;
    expect(out).toMatchObject({ approvedVersion: 2, publishedVersion: 2, publishState: 'queued' });
    await until(async () => writes().length > before);
    expect(VaultWriteCommandSchema.parse(writes().at(-1)?.payload).content).toContain('second');
    expect(VaultWriteCommandSchema.parse(writes().at(-1)?.payload).content).toContain('version: 2');
    // hand off, then archive
    expect((await status(d.id, 'handed_off')).document.status).toBe('handed_off');
    expect((await status(d.id, 'archived')).document.status).toBe('archived');
  });

  it('retries while no workstation is online', async () => {
    r.close();
    await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'offline');
    // the command queue is durable: with the workstation offline the write is queued for it
    const d = await create({ title: 'Offline publish', content: 'x' });
    await status(d.id, 'in_review');
    const out = (await status(d.id, 'approved')).document;
    expect(['pending', 'queued']).toContain(out.publishState);
    r = await w.connectRunner();
    await until(async () => writes().some((c) => String(c.payload.path).endsWith('offline-publish.md')));
  });
});

describe('cards and replay', () => {
  it('accepts linkedDocIds in card fields and leaves other cards alone', async () => {
    const d = await create({ title: 'Linked to a card' });
    const card = await w.card({
      title: 'Drafted from the PRD',
      fields: {
        context: 'c',
        requirements: 'r',
        acceptanceCriteria: ['a'],
        affectedAreas: 'x',
        constraints: 'y',
        testPlan: 't',
        linkedDocIds: [d.id],
      },
    });
    expect(card.fields.linkedDocIds).toEqual([d.id]);
    const plain = await w.card({ title: 'No docs' });
    expect(plain.fields.linkedDocIds).toBeUndefined();
    const bad = await raw('POST', '/api/cards', {
      projectId: w.projectId,
      title: 'Bad link',
      cardType: 'feature',
      fields: { linkedDocIds: ['not-a-uuid'] },
      completionAction: 'merge',
    });
    expect(bad.status).toBe(400);
  });

  it('rebuilds identical document tables', async () => {
    const snapshot = async () => {
      const out: Record<string, string[]> = {};
      for (const table of ['documents', 'document_versions']) {
        const rows = await q(`SELECT to_jsonb(t)::text AS j FROM "${table}" t`);
        out[table] = rows.map((x) => x.j as string).sort();
      }
      return out;
    };
    const before = await snapshot();
    expect(before.documents?.length).toBeGreaterThan(5);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(await snapshot()).toEqual(before);
  });
});

import { newFormDefinition, newFormField } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { ORIGIN, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let orgId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  orgId = (await q('SELECT id FROM organizations WHERE owner_user_id=$1', [w.owner.id]))[0]?.id as string;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await q('TRUNCATE forms, form_versions, org_brand_images');
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 1),
]);

const defOf = (title = 'Rental application', n = 2) => {
  const d = newFormDefinition(title);
  d.fields = Array.from({ length: n }, (_, i) =>
    newFormField('short_text', `f_field0${i}x`, `Question ${i + 1}`),
  );
  return d;
};
const asOwner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) });
const create = async (definition = defOf()) => ok<any>(asOwner('POST', '/api/forms', { definition }), 201);
const memberCookie = async (role: 'member' | 'admin') => {
  const email = uniqueEmail('fm');
  const id = await w.t.createUser(email, 'member');
  await w.t.addOrgMember(orgId, id, role);
  return w.t.login(email);
};
const upload = (cookie: string, body: Buffer, org = orgId) =>
  w.t.app.inject({
    method: 'POST',
    url: '/api/forms/logos',
    headers: { origin: ORIGIN, cookie, 'x-aom-org': org, 'content-type': 'application/octet-stream' },
    payload: body,
  });

describe('forms API', () => {
  it('creates a form and reads it back with the fields in order', async () => {
    const f = await create();
    expect(f.latestVersion).toBe(1);
    expect(f.definition.fields.map((x: any) => x.label)).toEqual(['Question 1', 'Question 2']);
    const got = await ok<any>(asOwner('GET', `/api/forms/${f.id}`));
    expect(got.definition).toEqual(f.definition);
    const list = await ok<any>(asOwner('GET', '/api/forms'));
    expect(list.forms[0]).toMatchObject({
      id: f.id,
      title: 'Rental application',
      fieldCount: 2,
      latestVersion: 1,
    });
  });

  it('every save is a new version; the previous one stays readable and unchanged', async () => {
    const f = await create();
    const d2 = defOf('Rental application v2', 3);
    const saved = await ok<any>(asOwner('PUT', `/api/forms/${f.id}`, { baseVersion: 1, definition: d2 }));
    expect(saved.created).toBe(true);
    expect(saved.form.latestVersion).toBe(2);
    const v1 = await ok<any>(asOwner('GET', `/api/forms/${f.id}/versions/1`));
    expect(v1.definition).toEqual(f.definition);
    const v2 = await ok<any>(asOwner('GET', `/api/forms/${f.id}/versions/2`));
    expect(v2.definition.fields).toHaveLength(3);
    expect(saved.form.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect((await asOwner('GET', `/api/forms/${f.id}/versions/3`)).status).toBe(404);
  });

  it('an unchanged save appends nothing', async () => {
    const f = await create();
    const again = await ok<any>(
      asOwner('PUT', `/api/forms/${f.id}`, { baseVersion: 1, definition: f.definition }),
    );
    expect(again.created).toBe(false);
    expect(again.form.latestVersion).toBe(1);
    expect(await q('SELECT 1 FROM form_versions WHERE form_id=$1', [f.id])).toHaveLength(1);
  });

  it('a stale baseVersion answers 409', async () => {
    const f = await create();
    await ok(asOwner('PUT', `/api/forms/${f.id}`, { baseVersion: 1, definition: defOf('B') }));
    const r = await asOwner('PUT', `/api/forms/${f.id}`, { baseVersion: 1, definition: defOf('C') });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('form_version_conflict');
  });

  it('an invalid definition answers 422 with the issues', async () => {
    const d = defOf();
    (d.fields[0] as any).minLength = 9;
    (d.fields[0] as any).maxLength = 3;
    const r = await asOwner('POST', '/api/forms', { definition: d });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain('invalid_form');
  });

  it('a member reads but cannot write', async () => {
    const f = await create();
    const m = await memberCookie('member');
    // the member's oldest membership is their own personal org: name the Owner's org explicitly
    const asMember = (method: string, url: string, body?: unknown) =>
      w.t.req(method, url, {
        cookie: m,
        headers: { 'x-aom-org': orgId },
        ...(body !== undefined ? { body } : {}),
      });
    expect((await asMember('GET', '/api/forms')).status).toBe(200);
    expect((await asMember('GET', `/api/forms/${f.id}`)).status).toBe(200);
    expect((await asMember('POST', '/api/forms', { definition: defOf() })).status).toBe(403);
    expect(
      (await asMember('PUT', `/api/forms/${f.id}`, { baseVersion: 1, definition: defOf() })).status,
    ).toBe(403);
    expect((await asMember('POST', `/api/forms/${f.id}/archive`)).status).toBe(403);
    expect((await upload(m, PNG)).statusCode).toBe(403);
  });

  it('archive hides a form from the active list; unarchive brings it back', async () => {
    const f = await create();
    expect((await asOwner('POST', `/api/forms/${f.id}/archive`)).status).toBe(204);
    expect((await ok<any>(asOwner('GET', '/api/forms'))).forms).toHaveLength(0);
    expect((await ok<any>(asOwner('GET', '/api/forms?status=archived'))).forms).toHaveLength(1);
    expect((await asOwner('GET', `/api/forms/${f.id}`)).status).toBe(200);
    expect((await asOwner('POST', `/api/forms/${f.id}/unarchive`)).status).toBe(204);
    expect((await ok<any>(asOwner('GET', '/api/forms'))).forms).toHaveLength(1);
  });

  it("another organization's form answers 404 everywhere", async () => {
    const f = await create();
    const otherUser = await w.t.userSession(uniqueEmail('other'), 'member');
    const otherOrg = (await q('SELECT id FROM organizations WHERE owner_user_id=$1', [otherUser.id]))[0]
      ?.id as string;
    const as = (method: string, url: string, body?: unknown) =>
      w.t.req(method, url, {
        cookie: otherUser.cookie,
        headers: { 'x-aom-org': otherOrg },
        ...(body !== undefined ? { body } : {}),
      });
    expect((await ok<any>(as('GET', '/api/forms'))).forms).toHaveLength(0);
    expect((await as('GET', `/api/forms/${f.id}`)).status).toBe(404);
    expect((await as('GET', `/api/forms/${f.id}/versions/1`)).status).toBe(404);
    expect((await as('PUT', `/api/forms/${f.id}`, { baseVersion: 1, definition: defOf('x') })).status).toBe(
      404,
    );
    expect((await as('POST', `/api/forms/${f.id}/archive`)).status).toBe(404);
  });

  it('rebuilding the projections gives the same rows', async () => {
    const f = await create();
    await ok(asOwner('PUT', `/api/forms/${f.id}`, { baseVersion: 1, definition: defOf('Two', 3) }));
    // the rebuild replays every event of the file, so look at this test's form only
    const versions = () =>
      q('SELECT form_id, version, definition_hash FROM form_versions WHERE form_id=$1 ORDER BY version', [
        f.id,
      ]);
    const before = await versions();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    const after = await versions();
    expect(after).toHaveLength(2);
    expect(after).toEqual(before);
    expect((await q('SELECT latest_version, title FROM forms WHERE id=$1', [f.id]))[0]).toMatchObject({
      latest_version: 2,
      title: 'Two',
    });
  });
});

describe('form logo', () => {
  it('accepts a PNG, serves it with safe headers, and a form can reference it', async () => {
    const up = await upload(w.owner.cookie, PNG);
    expect(up.statusCode).toBe(201);
    const { imageId, url } = up.json();
    expect(url).toBe(`/api/forms/logos/${imageId}`);
    const get = await w.t.app.inject({
      method: 'GET',
      url,
      headers: { cookie: w.owner.cookie, 'x-aom-org': orgId },
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(String(get.headers['content-security-policy'])).toContain('sandbox');
    const d = defOf();
    d.settings.logo = { imageId, alt: 'Logo' };
    const f = await create(d);
    expect(f.definition.settings.logo.imageId).toBe(imageId);
    expect(
      JSON.stringify(await q('SELECT payload FROM events WHERE stream_id=$1', [`form-${f.id}`])),
    ).not.toContain(PNG.toString('base64'));
  });

  it('refuses SVG, text and anything over 512 KB', async () => {
    expect(
      (await upload(w.owner.cookie, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).statusCode,
    ).toBe(422);
    expect((await upload(w.owner.cookie, Buffer.from('hello world, not an image'))).statusCode).toBe(422);
    const big = Buffer.concat([PNG, Buffer.alloc(513 * 1024)]);
    expect((await upload(w.owner.cookie, big)).statusCode).toBe(422);
    expect(await q('SELECT 1 FROM org_brand_images')).toHaveLength(0);
  });

  it("refuses another organization's logo on save and on GET", async () => {
    const otherUser = await w.t.userSession(uniqueEmail('lo'), 'member');
    const otherOrg = (await q('SELECT id FROM organizations WHERE owner_user_id=$1', [otherUser.id]))[0]
      ?.id as string;
    const up = (await upload(otherUser.cookie, PNG, otherOrg)).json();
    const d = defOf();
    d.settings.logo = { imageId: up.imageId, alt: '' };
    const r = await asOwner('POST', '/api/forms', { definition: d });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain('logo_not_found');
    const get = await w.t.app.inject({
      method: 'GET',
      url: up.url,
      headers: { cookie: w.owner.cookie, 'x-aom-org': orgId },
    });
    expect(get.statusCode).toBe(404);
  });
});

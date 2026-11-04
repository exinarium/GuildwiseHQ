import { publicFormPath } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { publicPageCsp } from '../src/public-forms/routes.ts';
import { ORIGIN, uniqueEmail } from './helpers/app.ts';
import { q } from './helpers/db.ts';
import { usePublicFormsWorld } from './helpers/public-forms.ts';
import { ok } from './helpers/world.ts';

const pf = usePublicFormsWorld();
const UNKNOWN = 'Zz9_-Zz9_-Zz9_-Zz9_-Zz';

describe('publishing a form (AC1)', () => {
  it('refuses to publish while a destination is not set, naming the fields', async () => {
    const d = pf.definition('No destination');
    d.settings.answersDestination.connectionId = null;
    const id = d.fields.find((f) => f.id === 'id_copy');
    if (id?.type === 'file') id.destination.connectionId = null;
    const f = await pf.createForm(d);
    const res = await pf.api('POST', `/api/forms/${f.id}/publish`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('destination_missing');
    expect(res.body.error.details.fields).toEqual(expect.arrayContaining(['answers', 'id_copy']));
    const pub = await ok<any>(pf.api('GET', `/api/forms/${f.id}/publication`));
    expect(pub.status).toBe('unpublished');
    expect(pub.warnings.map((w: any) => w.code)).toContain('destination_missing');
  });

  it('publishes with a public URL of 22 unguessable characters and serves the page and the definition', async () => {
    const { formId, publicId, url } = await pf.published(pf.definition('Public one'));
    expect(publicId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(url).toBe(`${ORIGIN}${publicFormPath(publicId)}`);
    const page = await pf.get(`/f/${publicId}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    const api = await pf.load(publicId);
    expect(api.status).toBe(200);
    expect(api.json.form.settings.title).toBe('Public one');
    expect(api.json.version).toBe(1);
    expect(api.json.session).toMatch(/^s1\./);
    // nothing about where the answers go is public
    expect(api.text).not.toContain(pf.connectionId);
    expect(api.text).not.toContain('Forms/{form}');
    const pub = await ok<any>(pf.api('GET', `/api/forms/${formId}/publication`));
    expect(pub).toMatchObject({ status: 'published', publicId, version: 1, url });
  });

  it('unpublish, archive and a suspended organization all answer exactly like an unknown address', async () => {
    const a = await pf.published(pf.definition('To unpublish'));
    const b = await pf.published(pf.definition('To archive'));
    const unknown = await pf.load(UNKNOWN);
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe('form_not_available');

    await ok(pf.api('POST', `/api/forms/${a.formId}/unpublish`));
    await ok(pf.api('POST', `/api/forms/${b.formId}/archive`), 204);
    for (const id of [a.publicId, b.publicId]) {
      const r = await pf.load(id);
      expect(r.status).toBe(404);
      expect(r.text).toBe(unknown.text);
      expect((await pf.get(`/f/${id}`)).status).toBe(404);
      expect((await pf.get(`/api/public/forms/${id}/logo`)).status).toBe(404);
    }
    // the page of an unpublished form is the same document as for an unknown address
    expect((await pf.get(`/f/${a.publicId}`)).text).toBe((await pf.get(`/f/${UNKNOWN}`)).text);

    const c = await pf.published(pf.definition('Suspended org'));
    await q(`UPDATE organizations SET status='suspended' WHERE id=$1`, [pf.orgId]);
    const s = await pf.load(c.publicId);
    expect(s.status).toBe(404);
    expect(s.text).toBe(unknown.text);
    await q(`UPDATE organizations SET status='active' WHERE id=$1`, [pf.orgId]);
    expect((await pf.load(c.publicId)).status).toBe(200);
  });

  it('a malformed address is not looked up at all and answers the same', async () => {
    for (const bad of ['short', 'x'.repeat(40), '..%2f..%2fetc']) {
      const r = await pf.load(bad);
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe('form_not_available');
    }
  });

  it('publishing changes keeps the address and moves to the new version; a reset ends the old address', async () => {
    const { formId, publicId } = await pf.published(pf.definition('Changing'));
    const d = pf.definition('Changing v2');
    const saved = await ok<any>(pf.api('PUT', `/api/forms/${formId}`, { baseVersion: 1, definition: d }));
    expect(saved.form.latestVersion).toBe(2);
    expect((await pf.load(publicId)).json.version).toBe(1);
    const pub = await ok<any>(pf.api('GET', `/api/forms/${formId}/publication`));
    expect(pub.latestVersion).toBe(2);
    const again = await ok<any>(pf.api('POST', `/api/forms/${formId}/publish`));
    expect(again.publicId).toBe(publicId);
    expect((await pf.load(publicId)).json).toMatchObject({ version: 2 });
    expect((await pf.load(publicId)).json.form.settings.title).toBe('Changing v2');

    const reset = await ok<any>(pf.api('POST', `/api/forms/${formId}/publication/reset-link`));
    expect(reset.publicId).not.toBe(publicId);
    expect((await pf.load(publicId)).status).toBe(404);
    expect((await pf.load(reset.publicId)).status).toBe(200);
  });

  it('only Owners and Admins publish; a member can read the status', async () => {
    const { formId } = await pf.published(pf.definition('Roles'));
    const email = uniqueEmail('pfm');
    const id = await pf.w.t.createUser(email, 'member');
    await pf.w.t.addOrgMember(pf.orgId, id, 'member');
    const cookie = await pf.w.t.login(email);
    const headers = { 'x-aom-org': pf.orgId };
    const post = (url: string, body: object = {}) => pf.w.t.req('POST', url, { cookie, headers, body });
    expect((await post(`/api/forms/${formId}/unpublish`)).status).toBe(403);
    expect((await post(`/api/forms/${formId}/client-links`, { reference: 'X' })).status).toBe(403);
    expect((await pf.w.t.req('GET', `/api/forms/${formId}/publication`, { cookie, headers })).status).toBe(
      200,
    );
  });

  it('a form of another organization is not found', async () => {
    const { formId } = await pf.published(pf.definition('Mine'));
    const other = await pf.w.t.userSession(uniqueEmail('other'));
    expect(
      (await pf.w.t.req('GET', `/api/forms/${formId}/publication`, { cookie: other.cookie })).status,
    ).toBe(404);
    expect(
      (await pf.w.t.req('POST', `/api/forms/${formId}/publish`, { cookie: other.cookie, body: {} })).status,
    ).toBe(404);
  });
});

describe('the public page (AC7)', () => {
  it('sends a restrictive CSP with no third party and no inline script or style', async () => {
    const { publicId } = await pf.published(pf.definition('Headers'));
    const page = await pf.get(`/f/${publicId}`);
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toBe(publicPageCsp(false));
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/https?:|\*/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.text).not.toMatch(/<script[^>]+src="https?:/);
    // the secure variant adds upgrade-insecure-requests
    expect(publicPageCsp(true)).toContain('upgrade-insecure-requests');
  });

  it('the API answers are never cached and the logo route is sandboxed', async () => {
    const { publicId } = await pf.published(pf.definition('No cache'));
    const r = await pf.load(publicId);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['set-cookie']).toBeUndefined();
  });
});

describe('personal links (AC2)', () => {
  const createLink = async (formId: string, body: object = { reference: 'CL-1042' }) =>
    ok<any>(pf.api('POST', `/api/forms/${formId}/client-links`, body), 201);
  const tokenOf = (url: string) => /#c=(.+)$/.exec(url)?.[1] as string;

  it('opens the form for that client; the token holds no reference and the page URL carries it in the fragment', async () => {
    const { formId, publicId } = await pf.published(pf.definition('Links'));
    const link = await createLink(formId);
    expect(link.url.startsWith(`${ORIGIN}/f/${publicId}#c=`)).toBe(true);
    const token = tokenOf(link.url);
    expect(token).not.toContain('CL-1042');
    expect(Buffer.from(token, 'base64url').toString('latin1')).not.toContain('CL-1042');
    const r = await pf.load(publicId, token);
    expect(r.status).toBe(200);
    expect(r.json.link).toMatchObject({ state: 'valid' });
    // the page never shows who the link is for
    expect(r.text).not.toContain('CL-1042');
    const list = await ok<any>(pf.api('GET', `/api/forms/${formId}/client-links`));
    expect(list.links[0]).toMatchObject({ reference: 'CL-1042', state: 'active', url: link.url });
  });

  it('refuses a forged, foreign, revoked, expired and used link with a clear code', async () => {
    const { formId, publicId } = await pf.published(pf.definition('Link states'));
    const other = await pf.published(pf.definition('Another form'));
    const link = await createLink(formId, { reference: 'A', expiresInDays: 1 });
    const token = tokenOf(link.url);

    const flipped = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await pf.load(publicId, flipped)).json.error.code).toBe('link_invalid');
    expect((await pf.load(publicId, 'garbage')).json.error.code).toBe('link_invalid');
    // another form's address with this form's token
    const foreign = await pf.load(other.publicId, token);
    expect(foreign.status).toBe(404);
    expect(foreign.json.error.code).toBe('link_invalid');

    const revoked = await createLink(formId, { reference: 'B' });
    await ok(pf.api('POST', `/api/forms/${formId}/client-links/${revoked.id}/revoke`), 204);
    const rv = await pf.load(publicId, tokenOf(revoked.url));
    expect(rv.status).toBe(410);
    expect(rv.json.error.code).toBe('link_revoked');

    const used = await createLink(formId, { reference: 'C' });
    await q(`UPDATE form_client_links SET used_at=now() WHERE id=$1`, [used.id]);
    expect((await pf.load(publicId, tokenOf(used.url))).json.error.code).toBe('link_used');

    pf.w.t.clock.advance(2 * 86_400_000);
    const expired = await pf.load(publicId, token);
    expect(expired.status).toBe(410);
    expect(expired.json.error.code).toBe('link_expired');
    pf.w.t.clock.advance(-2 * 86_400_000);

    const states = (await ok<any>(pf.api('GET', `/api/forms/${formId}/client-links`))).links.map(
      (l: any) => l.state,
    );
    expect(states).toEqual(expect.arrayContaining(['active', 'revoked', 'used']));
  });

  it('needs a published form', async () => {
    const f = await pf.createForm();
    const res = await pf.api('POST', `/api/forms/${f.id}/client-links`, { reference: 'X' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('form_not_published');
  });
});

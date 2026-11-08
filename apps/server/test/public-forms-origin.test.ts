import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { checkOrigin, checkWsOrigin } from '../src/auth/origin-check.ts';
import { loadConfig } from '../src/config.ts';
import { PDF, PNG, usePublicFormsWorld } from './helpers/public-forms.ts';

const FOREIGN = 'http://192.168.1.50:3000';

const cfg = loadConfig({
  ...process.env,
  AOM_PUBLIC_ORIGIN: 'https://aom.example.com/',
  AOM_EXTRA_ORIGINS: undefined,
});
const req = (method: string, url: string, origin?: string) =>
  ({ method, url, headers: origin === undefined ? {} : { origin } }) as unknown as FastifyRequest;

describe('checkOrigin on the public form prefix', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('%s with a foreign Origin passes', (m) => {
    expect(() => checkOrigin(cfg, req(m, '/api/public/forms/abc/submissions', FOREIGN))).not.toThrow();
    expect(() => checkOrigin(cfg, req(m, '/api/public/forms/abc/submissions?x=1', 'null'))).not.toThrow();
  });

  it('a configured Origin still passes', () => {
    expect(() =>
      checkOrigin(cfg, req('POST', '/api/public/forms/abc/submissions', 'https://aom.example.com')),
    ).not.toThrow();
  });

  it('a request without Origin is still refused', () => {
    expect(() => checkOrigin(cfg, req('POST', '/api/public/forms/abc/submissions'))).toThrow(/Origin/);
  });

  it.each([
    '/api/public/formsX',
    '/api/public/formsX/abc',
    '/api/public/forms',
    '/api/public/forms/',
    '/api/public/forms?x=/api/public/forms/abc',
    '/api/forms',
    '/api/forms/abc/unpublish',
    '/api/forms/offline-requests/abc/resend',
    '/api/auth/login',
  ])('%s with a foreign Origin is still refused', (url) => {
    expect(() => checkOrigin(cfg, req('POST', url, FOREIGN))).toThrow(/Origin/);
  });

  it('checkWsOrigin is unchanged', () => {
    expect(checkWsOrigin(cfg, FOREIGN)).toBe(false);
    expect(checkWsOrigin(cfg, 'https://aom.example.com')).toBe(true);
  });
});

describe('public forms through the app from an unconfigured address', () => {
  const pf = usePublicFormsWorld({
    AOM_FORMS_IP_BURST: '100000',
    AOM_FORMS_IP_PER_MIN: '100000',
    AOM_FORMS_IP_SUBMIT_BURST: '1000',
    AOM_FORMS_IP_SUBMITS_PER_HOUR: '100000',
  });
  const o = { origin: FOREIGN };

  it('submits with a file: start 201, upload 200, complete 200', async () => {
    const { publicId } = await pf.published(pf.definition('Origin form'));
    const dto = (await pf.get(`/api/public/forms/${publicId}`, o)).json;
    const files = [
      { field: 'id_copy', name: 'id.pdf', bytes: PDF },
      { field: 'photo', name: 'me.png', bytes: PNG },
    ];
    const { createHash } = await import('node:crypto');
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const start = await pf.post(
      `/api/public/forms/${publicId}/submissions`,
      {
        session: dto.session,
        nonce: '0',
        website: '',
        answers: { full_name: 'Lan Visitor' },
        files: files.map((f) => ({
          field: f.field,
          index: 0,
          name: f.name,
          size: f.bytes.length,
          sha256: sha(f.bytes),
        })),
      },
      o,
    );
    expect(start.status).toBe(201);
    const { submissionId: sid, uploadToken: token } = start.json;
    const url = `/api/public/forms/${publicId}/submissions/${sid}`;
    for (const [i, f] of files.entries()) {
      const put = await pf.put(`${url}/parts/${i}`, f.bytes, {
        ...o,
        'x-upload-token': token,
        'x-file-name': encodeURIComponent(f.name),
      });
      expect(put.status).toBe(200);
    }
    const done = await pf.post(
      `${url}/complete`,
      { answers: { full_name: 'Lan Visitor' } },
      { ...o, 'x-upload-token': token },
    );
    expect(done.status).toBe(200);

    // a wrong upload token and a non-JSON body are still refused
    const badTok = await pf.put(`${url}/parts/0`, PDF, { ...o, 'x-upload-token': 'nope' });
    expect(badTok.status).toBeGreaterThanOrEqual(400);
    const text = await pf.w.t.app.inject({
      method: 'POST',
      url: `${url}/complete`,
      headers: { origin: FOREIGN, 'content-type': 'text/plain', 'x-upload-token': token },
      payload: 'x',
    });
    expect(text.statusCode).toBe(415);
  });

  it('a start without Origin is refused with bad_origin', async () => {
    const { publicId } = await pf.published(pf.definition('No origin form'));
    const res = await pf.w.t.app.inject({
      method: 'POST',
      url: `/api/public/forms/${publicId}/submissions`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('bad_origin');
  });

  it('admin and form routes with the owner cookie and a foreign Origin are refused', async () => {
    const { formId } = await pf.published(pf.definition('Admin form'));
    const headers = { origin: FOREIGN, cookie: pf.w.owner.cookie, 'content-type': 'application/json' };
    const create = await pf.w.t.app.inject({
      method: 'POST',
      url: '/api/forms',
      headers,
      payload: { definition: pf.definition('x') },
    });
    expect(create.statusCode).toBe(403);
    const unpub = await pf.w.t.app.inject({
      method: 'POST',
      url: `/api/forms/${formId}/unpublish`,
      headers,
      payload: {},
    });
    expect(unpub.statusCode).toBe(403);
    expect(unpub.json().error.code).toBe('bad_origin');
  });
});

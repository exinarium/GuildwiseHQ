import { describe, expect, it } from 'vitest';
import { PDF, usePublicFormsWorld } from './helpers/public-forms.ts';

// Slow refill so a refused call stays refused for the length of the test.
const pf = usePublicFormsWorld({
  AOM_FORMS_IP_PER_MIN: '1',
  AOM_FORMS_IP_BURST: '20',
  AOM_FORMS_IP_SUBMITS_PER_HOUR: '1',
  AOM_FORMS_IP_SUBMIT_BURST: '2',
  AOM_FORMS_FORM_SUBMITS_PER_MIN: '1',
  AOM_FORMS_FORM_SUBMIT_BURST: '3',
});
const f1 = [{ field: 'id_copy', name: 'a.pdf', bytes: PDF }];

describe('rate limiting (AC6)', () => {
  it('answers 429 with Retry-After after the per-IP threshold; another address is unaffected', async () => {
    const { publicId } = await pf.published(pf.definition('Rate IP'));
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await pf.get(`/api/public/forms/${publicId}`, {}, '203.0.113.7')).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    const refused = await pf.get(`/api/public/forms/${publicId}`, {}, '203.0.113.7');
    expect(refused.status).toBe(429);
    expect(refused.json.error.code).toBe('rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await pf.get(`/api/public/forms/${publicId}`, {}, '203.0.113.8')).status).toBe(200);
    // the page and the other public routes share the same budget
    expect((await pf.get(`/f/${publicId}`, {}, '203.0.113.7')).status).toBe(429);
  });

  it('limits submission starts per address across forms', async () => {
    const forms = [await pf.published(pf.definition('Rate A')), await pf.published(pf.definition('Rate B')), await pf.published(pf.definition('Rate C'))];
    const ip = '198.51.100.20';
    const codes: number[] = [];
    for (const f of forms) {
      const dto = (await pf.get(`/api/public/forms/${f.publicId}`, {}, ip)).json;
      codes.push((await pf.start(f.publicId, dto, { full_name: 'x' }, f1, {}, ip)).status);
    }
    expect(codes).toEqual([201, 201, 429]);
  });

  it('limits submission starts per form whatever the address, and another form stays open', async () => {
    const busy = await pf.published(pf.definition('Rate busy'));
    const quiet = await pf.published(pf.definition('Rate quiet'));
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const ip = `192.0.2.${10 + i}`;
      const dto = (await pf.get(`/api/public/forms/${busy.publicId}`, {}, ip)).json;
      const r = await pf.start(busy.publicId, dto, { full_name: 'x' }, f1, {}, ip);
      codes.push(r.status);
      if (r.status === 429) {
        expect(r.json.error.code).toBe('rate_limited');
        expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      }
    }
    expect(codes).toEqual([201, 201, 201, 429]);
    const ip = '192.0.2.99';
    const dto = (await pf.get(`/api/public/forms/${quiet.publicId}`, {}, ip)).json;
    expect((await pf.start(quiet.publicId, dto, { full_name: 'x' }, f1, {}, ip)).status).toBe(201);
  });
});

import { describe, expect, it } from 'vitest';
import { q } from './helpers/db.ts';
import { PDF, usePublicFormsWorld } from './helpers/public-forms.ts';

const ORIGIN = 'https://s3.example.com';

// The documented rollback: with AOM_FORMS_DIRECT_UPLOADS off every file goes through the relay, as in 1.6.0.
const pf = usePublicFormsWorld({
  AOM_FORMS_DIRECT_UPLOADS: 'false',
  AOM_FORMS_IP_BURST: '100000',
  AOM_FORMS_IP_PER_MIN: '100000',
  AOM_FORMS_IP_SUBMIT_BURST: '1000',
  AOM_FORMS_IP_SUBMITS_PER_HOUR: '100000',
});

describe('direct uploads switched off', () => {
  it('a cloud destination relays, lists no upload host and keeps connect-src to self', async () => {
    await q(`UPDATE storage_connections SET kind='s3' WHERE id=$1`, [pf.connectionId]);
    // Even when the runner reports an upload host, it is ignored.
    pf.r.send('storage.direct.report', {
      connections: [{ connectionId: pf.connectionId, uploadOrigin: ORIGIN, reason: null }],
    });
    await new Promise((r) => setTimeout(r, 150));
    const { publicId } = await pf.published(pf.definition('Off'));
    const page = await pf.get(`/f/${publicId}`);
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("connect-src 'self';");
    expect(csp).not.toContain(ORIGIN);
    const dto = (await pf.load(publicId)).json;
    expect(dto.uploadOrigins ?? []).toEqual([]);
    const start = await pf.start(publicId, dto, { full_name: 'P' }, [
      { field: 'id_copy', name: 'My ID.pdf', bytes: PDF },
    ]);
    expect(start.status).toBe(201);
    expect(start.json.parts.every((p: { mode: string }) => p.mode === 'relay')).toBe(true);
  });
});

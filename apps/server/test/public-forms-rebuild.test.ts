import { describe, expect, it } from 'vitest';
import { rebuildProjections, unsavedCascadeTargets } from '../src/projections/rebuild.ts';
import { PNG, usePublicFormsWorld } from './helpers/public-forms.ts';
import { q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

const pf = usePublicFormsWorld();

describe('projections:rebuild with public forms', () => {
  it('keeps a stored submission exactly once and replays publications and client links', async () => {
    expect(await unsavedCascadeTargets(pf.w.t.app.ctx.pool)).toEqual([]);
    const { formId, publicId } = await pf.published(pf.definition('Rebuild'));
    const link = await ok<any>(
      pf.api('POST', `/api/forms/${formId}/client-links`, { reference: 'CL-7' }),
      201,
    );
    const token = /#c=(.+)$/.exec(link.url)?.[1] as string;
    const s = await pf.submit(
      publicId,
      { full_name: 'Rebuild Person' },
      [{ field: 'id_copy', name: 'id.png', bytes: PNG }],
      token,
    );
    expect(s.complete?.status).toBe(200);

    const sub = () => q('SELECT * FROM form_submissions WHERE id=$1', [s.sid]);
    const pub = () => q('SELECT * FROM form_publications WHERE form_id=$1', [formId]);
    const links = () => q('SELECT * FROM form_client_links WHERE form_id=$1 ORDER BY id', [formId]);
    const before = { sub: await sub(), pub: await pub(), links: await links() };
    expect(before.sub).toHaveLength(1);
    expect(before.sub[0]?.status).toBe('complete');

    await rebuildProjections(pf.w.t.app.ctx.pool, pf.w.t.app.ctx.store);

    expect(await sub()).toEqual(before.sub);
    expect(await pub()).toEqual(before.pub);
    expect(await links()).toEqual(before.links);
    expect(Number((await q('SELECT count(*) n FROM form_submissions WHERE id=$1', [s.sid]))[0]?.n)).toBe(1);
  });
});

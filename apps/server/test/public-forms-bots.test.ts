import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PDF, usePublicFormsWorld } from './helpers/public-forms.ts';

// Proof of work on, and a minimum time a person needs to fill a form.
const pf = usePublicFormsWorld({
  AOM_FORMS_POW_BITS: '8',
  AOM_FORMS_MIN_FILL_MS: '60000',
  AOM_FORMS_IP_BURST: '100000',
  AOM_FORMS_IP_PER_MIN: '100000',
  AOM_FORMS_IP_SUBMIT_BURST: '1000',
});
const f1 = [{ field: 'id_copy', name: 'a.pdf', bytes: PDF }];

const hasBits = (session: string, nonce: string, bits: number) => {
  const h = createHash('sha256').update(`${session}:${nonce}`).digest();
  return h[0] === 0 && bits === 8;
};
const solve = (session: string) => {
  for (let i = 0; ; i++) if (hasBits(session, i.toString(36), 8)) return i.toString(36);
};
const wrong = (session: string) => {
  for (let i = 0; ; i++) if (!hasBits(session, i.toString(36), 8)) return i.toString(36);
};

describe('bot protection', () => {
  it('a session that is too fresh is refused (minimum fill time) and an old enough one with a solved puzzle is accepted', async () => {
    const { publicId } = await pf.published(pf.definition('Bots 1'));
    const dto = (await pf.load(publicId)).json;
    expect(dto.powBits).toBe(8);
    expect(dto.minFillMs).toBe(60000);
    const tooFast = await pf.start(publicId, dto, { full_name: 'x' }, f1, { nonce: solve(dto.session) });
    expect(tooFast.status).toBe(422);
    expect(tooFast.json.error.code).toBe('submission_refused');

    const dto2 = (await pf.load(publicId)).json;
    pf.w.t.clock.advance(61_000);
    const ok = await pf.start(publicId, dto2, { full_name: 'x' }, f1, { nonce: solve(dto2.session) });
    expect(ok.status).toBe(201);
  });

  it('a missing or wrong proof of work is refused, whatever else is right', async () => {
    const { publicId } = await pf.published(pf.definition('Bots 2'));
    const dto = (await pf.load(publicId)).json;
    pf.w.t.clock.advance(61_000);
    const bad = await pf.start(publicId, dto, { full_name: 'x' }, f1, { nonce: wrong(dto.session) });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe('submission_refused');
    const none = await pf.start(publicId, dto, { full_name: 'x' }, f1, { nonce: '' });
    expect(none.status).toBe(422);
  });
});

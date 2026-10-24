import { SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { kit } from './helpers/sessions-r2.ts';
import { createWorld, type World } from './helpers/world.ts';

/** Revision R2: the CEO's prep-mode turn cap is a setting of the New Discovery dialog (default 12, 2 to 40). */
let w: World;
let r: FakeRunner;
let K: ReturnType<typeof kit>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY] });
  K = kit(w, () => r);
  await appoint(w);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('prep-mode turn cap', () => {
  it('defaults to 12, takes 2 to 40, and refuses anything else', async () => {
    expect((await K.createDiscovery({ ceoMode: 'ceo_prep' })).config.ceoPrep).toMatchObject({
      cap: 12,
      state: 'running',
    });
    expect((await K.createDiscovery({ ceoMode: 'ceo_prep', prepTurnCap: 3 })).config.ceoPrep.cap).toBe(3);
    expect((await K.createDiscovery({ ceoMode: 'ceo_prep', prepTurnCap: 40 })).config.ceoPrep.cap).toBe(40);
    for (const bad of [1, 41, 2.5])
      expect(
        (await K.raw('POST', '/api/discovery', { title: 'x', ceoMode: 'ceo_prep', prepTurnCap: bad })).status,
      ).toBe(400);
    // it only matters in prep mode
    expect((await K.createDiscovery({ ceoMode: 'joint', prepTurnCap: 5 })).config.ceoPrep).toBeNull();
  });
});

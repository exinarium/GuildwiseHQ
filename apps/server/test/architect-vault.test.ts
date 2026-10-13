import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { pipeline } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, fullFields, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const cookie = () => w.owner.cookie;
const setArchitect = (body: Record<string, unknown>) =>
  w.t.req('PUT', `/api/projects/${w.projectId}/architect-settings`, {
    cookie: cookie(),
    body: {
      designStep: false,
      mergeMainFirst: true,
      investigationPath: 'docs/investigations',
      investigationLocation: 'repo',
      ...body,
    },
  });
const createCard = (fields: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  w.t.req('POST', '/api/cards', {
    cookie: cookie(),
    body: {
      projectId: w.projectId,
      title: 'Vault path',
      cardType: 'feature',
      fields: fullFields(fields),
      completionAction: 'merge',
      ...over,
    },
  });

describe('a vault report location needs a vault', () => {
  it('without a vault: the vault location and a vault: card path are refused with a plain 400', async () => {
    await freshState();
    await q('DELETE FROM vaults');
    const s = await setArchitect({ investigationLocation: 'vault' });
    expect(s.status).toBe(400);
    expect(JSON.stringify(s.body)).toContain('no knowledge vault');
    expect((await setArchitect({ investigationLocation: 'repo' })).status).toBe(200);

    const c = await createCard({ reportPath: 'vault:research' });
    expect(c.status).toBe(400);
    expect(JSON.stringify(c.body)).toContain('needs a knowledge vault');

    const draft = await ok<any>(createCard({}, { specify: false }), 201);
    const patch = await w.t.req('PATCH', `/api/cards/${draft.card.id}`, {
      cookie: cookie(),
      body: { fields: { reportPath: 'vault:research' } },
    });
    expect(patch.status).toBe(400);
    // a path in the repository is fine
    await ok(
      w.t.req('PATCH', `/api/cards/${draft.card.id}`, {
        cookie: cookie(),
        body: { fields: { reportPath: 'docs/answers' } },
      }),
    );
    // a draft that carries a vault: path (the vault went away) is refused at specify
    await q(`UPDATE cards SET fields = fields || '{"reportPath":"vault:old"}'::jsonb WHERE id=$1`, [
      draft.card.id,
    ]);
    const spec = await w.t.req('POST', `/api/cards/${draft.card.id}/specify`, { cookie: cookie() });
    expect(spec.status).toBe(400);
  });

  it('with a vault the same requests succeed', async () => {
    await ok(
      w.t.req('POST', '/api/vaults', {
        cookie: cookie(),
        body: { kind: 'org', remoteUrl: 'git@example.test:srv/work.git' },
      }),
      201,
    );
    expect((await setArchitect({ investigationLocation: 'vault' })).status).toBe(200);
    expect((await createCard({ reportPath: 'vault:research' })).status).toBe(201);
    const proj = await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: cookie() }));
    expect(proj.project.hasVault).toBe(true);
  });

  it('the brief falls back to the repository when the vault was removed later', async () => {
    await freshState();
    await w.hire('Aria', 'architect', 'senior');
    await ok(setArchitect({ investigationLocation: 'vault', designStep: true }));
    const card = await w.card({ title: 'Lost vault', designNeeded: true });
    await q('DELETE FROM vaults');
    const start = await p.next('Aria');
    expect(start.brief.card.id).toBe(card.id);
    expect(start.brief.investigation).toMatchObject({
      location: 'repo',
      reportPath: `docs/investigations/${card.ref}-lost-vault.md`,
      folder: 'docs/investigations',
    });
    expect(start.brief.investigation?.note).toContain("vault location isn't available");
    expect(start.vault).toBeNull();
  });
});

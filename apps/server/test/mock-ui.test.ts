import { afterAll, describe, expect, it } from 'vitest';
import { closeAdminPool } from './helpers/db.ts';
import { createWorld, fullFields, ok } from './helpers/world.ts';

afterAll(async () => {
  await closeAdminPool();
});

const MOCK_VALUES: Record<string, unknown> = {
  mock: { build: ['ok'] },
  mockEnv: 'docker_missing',
  mockOutbound: { body: 'x' },
};

describe('mock-runtime fields (AOM_MOCK_UI off)', () => {
  it('are not advertised, and creating or editing a card with them is refused with 422', async () => {
    const off = await createWorld({ env: { AOM_MOCK_UI: 'false' }, listen: false });
    try {
      const me = await ok<any>(off.t.req('GET', '/api/auth/me', { cookie: off.owner.cookie }));
      expect(me.features).toEqual({ mockUi: false });
      const create = (fields: Record<string, unknown>) =>
        off.t.req('POST', '/api/cards', {
          cookie: off.owner.cookie,
          body: { projectId: off.projectId, title: 'x', cardType: 'feature', fields },
        });
      for (const [key, value] of Object.entries(MOCK_VALUES)) {
        const res = await create({ ...fullFields(), [key]: value });
        expect(res.status, key).toBe(422);
        expect(res.body.error.code).toBe('mock_fields_disabled');
      }
      const fine = await create(fullFields());
      expect(fine.status).toBe(201);
      const refused = await off.t.req('PATCH', `/api/cards/${fine.body.card.id}`, {
        cookie: off.owner.cookie,
        body: { fields: { mock: { build: ['ok'] } } },
      });
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('mock_fields_disabled');
    } finally {
      await off.t.close();
    }
  });
});

describe('mock-runtime fields (AOM_MOCK_UI on)', () => {
  it('are advertised and accepted', async () => {
    const on = await createWorld({ env: { AOM_MOCK_UI: 'true' }, listen: false });
    try {
      const me = await ok<any>(on.t.req('GET', '/api/auth/me', { cookie: on.owner.cookie }));
      expect(me.features).toEqual({ mockUi: true });
      const res = await on.t.req('POST', '/api/cards', {
        cookie: on.owner.cookie,
        body: {
          projectId: on.projectId,
          title: 'x',
          cardType: 'feature',
          fields: { ...fullFields(), mock: { build: ['ok'] } },
        },
      });
      expect(res.status).toBe(201);
    } finally {
      await on.t.close();
    }
  });
});

import { BUSINESS_CARD_TYPES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { effectiveCompletion } from '../src/commands/completion.ts';

const db = (projectDefault: string | null) => ({
  query: async () => ({ rows: [{ default_completion: projectDefault }], rowCount: 1 }),
});

describe('effectiveCompletion', () => {
  it.each(BUSINESS_CARD_TYPES)(
    'a %s card has no git completion even when the project default is merge',
    async (t) => {
      const r = await effectiveCompletion(db('merge') as never, {
        card_type: t,
        project_id: 'p',
        completion_action: 'merge',
      });
      expect(r.action).toBeNull();
    },
  );

  it('a dev card follows the project default', async () => {
    const r = await effectiveCompletion(db('merge') as never, {
      card_type: 'feature',
      project_id: 'p',
      completion_action: null,
    });
    expect(r).toEqual({ action: 'merge', source: 'project' });
  });

  it('a dev card keeps its own override', async () => {
    const r = await effectiveCompletion(db('merge') as never, {
      card_type: 'bug',
      project_id: 'p',
      completion_action: 'pr',
    });
    expect(r).toEqual({ action: 'pr', source: 'card' });
  });
});

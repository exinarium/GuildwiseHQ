import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/release/docs-prep.ts', () => ({ advance: vi.fn(async () => ['ws-1', 'ws-1', 'ws-2']) }));
vi.mock('../src/db/sql.ts', async (orig) => {
  const real = await orig<typeof import('../src/db/sql.ts')>();
  return {
    ...real,
    one: vi.fn(async (_tx: unknown, sql: string) =>
      sql.includes('release_docs_prep_runs')
        ? { id: 'run-1', org_id: 'o', project_id: 'p', status: 'running' }
        : { state: 'running' },
    ),
  };
});

import { withTx } from '../src/db/tx.ts';
import { runLegacyChangelogFallback } from '../src/release/docs-prep-legacy.ts';

const log: string[] = [];
function fakePool() {
  const client = {
    query: async (sql: string) => {
      log.push(sql);
      return { rows: [] };
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as pg.Pool;
}
const task = { id: 't1', org_id: 'o', project_id: 'p', prep_run_id: 'run-1', prep_repo_id: 'r1' } as never;
const ctx = (deliver: (w: string) => unknown) =>
  ({
    store: { append: async () => log.push('append') },
    services: { gateway: { deliverPending: deliver } },
  }) as never;
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  log.length = 0;
  vi.restoreAllMocks();
});

describe('legacy changelog cancel: delivery', () => {
  it('delivers once per workstation after COMMIT, with no 250 ms timer', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const deliver = vi.fn((w: string) => {
      log.push(`deliver:${w}`);
    });
    await withTx(fakePool(), (tx) => runLegacyChangelogFallback(ctx(deliver), tx, task));
    await tick();
    expect(log.filter((l) => l === 'COMMIT' || l.startsWith('deliver:'))).toEqual([
      'COMMIT',
      'deliver:ws-1',
      'deliver:ws-2',
    ]);
    expect(timer.mock.calls.filter((c) => c[1] === 250)).toEqual([]);
  });

  it('delivers nothing when the transaction rolls back', async () => {
    const deliver = vi.fn();
    await expect(
      withTx(fakePool(), async (tx) => {
        await runLegacyChangelogFallback(ctx(deliver), tx, task);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await tick();
    expect(log).toContain('ROLLBACK');
    expect(deliver).not.toHaveBeenCalled();
  });
});

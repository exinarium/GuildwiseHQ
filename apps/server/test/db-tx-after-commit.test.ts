import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { afterCommit, withTx } from '../src/db/tx.ts';

function fakePool() {
  const log: string[] = [];
  const client = {
    query: async (sql: string) => {
      log.push(sql);
      return { rows: [] };
    },
    release: () => log.push('release'),
  };
  return { log, pool: { connect: async () => client } as unknown as pg.Pool, client };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('afterCommit', () => {
  it('runs the hook after COMMIT', async () => {
    const { log, pool } = fakePool();
    await withTx(pool, async (tx) => {
      afterCommit(tx, () => log.push('hook'));
      log.push('body');
    });
    await tick();
    expect(log.filter((l) => ['BEGIN', 'body', 'COMMIT', 'hook'].includes(l))).toEqual(['BEGIN', 'body', 'COMMIT', 'hook']);
  });

  it('never runs the hook when the transaction rolls back', async () => {
    const { log, pool } = fakePool();
    await expect(
      withTx(pool, async (tx) => {
        afterCommit(tx, () => log.push('hook'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await tick();
    expect(log).toContain('ROLLBACK');
    expect(log).not.toContain('hook');
  });

  it('throws outside a transaction', () => {
    expect(() => afterCommit({} as never, () => undefined)).toThrow(/withTx/);
  });

  it('a throwing hook does not reject the transaction', async () => {
    const { pool } = fakePool();
    await expect(
      withTx(pool, async (tx) => {
        afterCommit(tx, () => {
          throw new Error('hook');
        });
        return 7;
      }),
    ).resolves.toBe(7);
    await tick();
  });
});

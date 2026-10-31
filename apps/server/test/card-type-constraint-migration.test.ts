import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CardType } from '@aom/shared';
import { describe, expect, it } from 'vitest';

/** The cards.card_type CHECK constraint must list every CardType (the last migration that defines it wins). */
describe('cards_card_type_check migrations', () => {
  const dir = join(import.meta.dirname, '..', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  it('the latest definition allows every card type', () => {
    let list: string[] | null = null;
    for (const f of files) {
      const sql = readFileSync(join(dir, f), 'utf8');
      const m =
        /cards_card_type_check\s+CHECK\s*\(\s*card_type\s+IN\s*\(([^)]*)\)/i.exec(sql) ??
        (f.startsWith('0007_') ? /card_type\s+text NOT NULL CHECK \(card_type IN \(([^)]*)\)/i.exec(sql) : null);
      if (m) list = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    }
    expect(list).not.toBeNull();
    expect([...(list ?? [])].sort()).toEqual([...CardType.options].sort());
  });
});

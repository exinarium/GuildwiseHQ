import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CardType } from '@aom/shared';
import { describe, expect, it } from 'vitest';

/** Quoted values of an `IN ('a', 'b')` list body; empty when the match has no list. */
function quotedValues(match: RegExpExecArray | null): string[] | null {
  const body = match?.[1];
  if (body === undefined) return null;
  const values: string[] = [];
  for (const x of body.matchAll(/'([^']+)'/g)) {
    const value = x[1];
    if (value !== undefined) values.push(value);
  }
  return values;
}

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
        (f.startsWith('0007_')
          ? /card_type\s+text NOT NULL CHECK \(card_type IN \(([^)]*)\)/i.exec(sql)
          : null);
      const found = quotedValues(m);
      if (found) list = found;
    }
    expect(list).not.toBeNull();
    expect([...(list ?? [])].sort()).toEqual([...CardType.options].sort());
  });

  it('reads the quoted values and tolerates a missing match', () => {
    expect(quotedValues(null)).toBeNull();
    expect(quotedValues(/(.*)/.exec(''))).toEqual([]);
    expect(quotedValues(/\((.*)\)/.exec("('a', 'b')"))).toEqual(['a', 'b']);
  });
});

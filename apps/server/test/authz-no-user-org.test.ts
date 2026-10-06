import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "Org owner" used to be written as `userId === orgId` (an organization was its user). Organizations are first class
 * now (docs/design/organizations.md section 4.1): nothing may compare or substitute a user id for an organization id.
 */
const ROOTS = [join(__dirname, '../src'), join(__dirname, '../../../packages/shared/src')];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ['orgScope(user.id ...)', /orgScope\((s\.|session\.)?user\.id/],
  ['orgId: user.id', /orgId:\s*(s\.|session\.)?user\.id/],
  ['org_id compared with user.id', /org_id\s*[!=]==?\s*(s\.|session\.)?user\.id/],
  ['user.id compared with org_id', /user\.id\s*[!=]==?\s*[\w.]*org_?[iI]d/],
  ['userId === orgId', /userId\s*[!=]==?\s*[\w.]*org_?[iI]d/],
  ['orgId === userId', /org_?[iI]d\s*[!=]==?\s*(s\.|session\.)?user(Id|\.id)/],
  ['resolveWorkflow(tx, user.id', /resolveWorkflow\(\w+,\s*(s\.)?user\.id/],
  ['loadRole(tx, user.id', /loadRole\(\w+,\s*(s\.)?user\.id/],
];

describe('no user id stands in for an organization id', () => {
  const all = ROOTS.flatMap(files);
  it('scans the server and shared sources', () => {
    expect(all.length).toBeGreaterThan(100);
  });
  for (const [name, re] of FORBIDDEN) {
    it(`has no ${name}`, () => {
      const hits = all.flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .flatMap((line, i) =>
            re.test(line) && !line.trim().startsWith('//') ? [`${f}:${i + 1}: ${line.trim()}`] : [],
          ),
      );
      expect(hits).toEqual([]);
    });
  }
});

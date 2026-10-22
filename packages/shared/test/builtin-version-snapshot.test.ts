import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES, BUILTIN_WORKFLOWS } from '../src/index.ts';

/**
 * A built-in role or workflow is registered once per (key, version) at server boot, and agents only follow a NEWER
 * role version. Changing a definition without bumping its version therefore never reaches production (GWP-11: the
 * tester's `--scope e2e-spec` text). This test pins a hash of every definition to its version.
 *
 * To update after an intended change: bump `version` of the definition, then run
 * `UPDATE_BUILTIN_SNAPSHOT=1 npx vitest run test/builtin-version-snapshot.test.ts`.
 */
const FILE = new URL('./fixtures/builtin-definitions.snapshot.json', import.meta.url);

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]),
    );
  return v;
}

const sha = (def: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(def)))
    .digest('hex');

const id = (e: { kind: string; key: string; version: number }) => `${e.kind}/${e.key}/${e.version}`;

type Entry = { kind: 'role' | 'workflow'; key: string; version: number; sha256: string };

const current = (): Entry[] =>
  [
    ...BUILTIN_ROLES.map((d) => ({ kind: 'role' as const, key: d.key, version: d.version, sha256: sha(d) })),
    ...BUILTIN_WORKFLOWS.map((d) => ({
      kind: 'workflow' as const,
      key: d.key,
      version: d.version,
      sha256: sha(d),
    })),
  ].sort((a, b) => {
    const x = id(a);
    const y = id(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });

/**
 * Problems between a snapshot and the current definitions. In update mode a changed hash of an existing (kind, key,
 * version) is still a problem (that is exactly the bug the guard exists for); new entries are fine there.
 */
function problems(snap: Entry[], now: Entry[], update: boolean): string[] {
  const byKey = new Map(snap.map((e) => [id(e), e]));
  const cur = new Set(now.map(id));
  const out: string[] = [];
  for (const e of now) {
    const old = byKey.get(id(e));
    if (old && old.sha256 !== e.sha256)
      out.push(
        `${e.kind} '${e.key}' v${e.version}: its definition changed but the version did not. Bump the version (production only registers missing versions and agents only follow newer ones)${update ? '; update mode never overwrites an existing version' : ', then regenerate with UPDATE_BUILTIN_SNAPSHOT=1'}.`,
      );
    if (!old && !update)
      out.push(
        `${e.kind} '${e.key}' v${e.version} is not in the snapshot. Regenerate with UPDATE_BUILTIN_SNAPSHOT=1 npx vitest run test/builtin-version-snapshot.test.ts and commit the snapshot.`,
      );
  }
  for (const e of snap)
    if (!cur.has(id(e)))
      out.push(
        `${e.kind} '${e.key}' v${e.version} is in the snapshot but no longer defined: a built-in version is never removed (agents may still follow it). Restore it.`,
      );
  return out;
}

describe('built-in definitions are pinned to their version', () => {
  it('no role or workflow changed content without a version bump', () => {
    const update = !!process.env.UPDATE_BUILTIN_SNAPSHOT;
    if (!existsSync(FILE)) {
      if (!update)
        expect.fail(
          `The snapshot ${FILE.pathname} is missing. Restore it from version control, or create it once with UPDATE_BUILTIN_SNAPSHOT=1.`,
        );
      writeFileSync(FILE, `${JSON.stringify(current(), null, 2)}\n`);
      return;
    }
    const snap = JSON.parse(readFileSync(FILE, 'utf8')) as Entry[];
    const found = problems(snap, current(), update);
    expect(found).toEqual([]);
    if (update) writeFileSync(FILE, `${JSON.stringify(current(), null, 2)}\n`);
  });

  it('flags changed, new and removed definitions', () => {
    const a: Entry = { kind: 'role', key: 'x', version: 1, sha256: 'a' };
    expect(problems([a], [{ ...a, sha256: 'b' }], false)).toHaveLength(1);
    expect(problems([a], [{ ...a, sha256: 'b' }], true)).toHaveLength(1);
    expect(problems([a], [a, { ...a, version: 2 }], false)).toHaveLength(1);
    expect(problems([a], [a, { ...a, version: 2 }], true)).toEqual([]);
    expect(problems([a], [], false)).toHaveLength(1);
    expect(problems([a], [], true)).toHaveLength(1);
  });

  it('detects a content change under an unchanged version', () => {
    const role = BUILTIN_ROLES[0]!;
    expect(sha({ ...role, instructions: `${role.instructions} x` })).not.toBe(sha(role));
    expect(sha(role)).toBe(sha(structuredClone(role)));
  });
});

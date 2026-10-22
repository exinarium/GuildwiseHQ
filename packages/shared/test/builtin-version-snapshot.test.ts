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
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, canonical(x)]),
    );
  return v;
}

const sha = (def: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(def)))
    .digest('hex');

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
  ].sort((a, b) => `${a.kind}/${a.key}/${a.version}`.localeCompare(`${b.kind}/${b.key}/${b.version}`));

describe('built-in definitions are pinned to their version', () => {
  it('no role or workflow changed content without a version bump', () => {
    if (process.env.UPDATE_BUILTIN_SNAPSHOT || !existsSync(FILE)) {
      writeFileSync(FILE, `${JSON.stringify(current(), null, 2)}\n`);
    }
    const snap = JSON.parse(readFileSync(FILE, 'utf8')) as Entry[];
    const byKey = new Map(snap.map((e) => [`${e.kind}/${e.key}/${e.version}`, e]));
    const changed: string[] = [];
    for (const e of current()) {
      const old = byKey.get(`${e.kind}/${e.key}/${e.version}`);
      if (old && old.sha256 !== e.sha256)
        changed.push(
          `${e.kind} '${e.key}' v${e.version}: its definition changed but the version did not. Bump the version (production only registers missing versions and agents only follow newer ones), then regenerate with UPDATE_BUILTIN_SNAPSHOT=1.`,
        );
      if (!old)
        changed.push(
          `${e.kind} '${e.key}' v${e.version} is not in the snapshot. Regenerate with UPDATE_BUILTIN_SNAPSHOT=1 npx vitest run test/builtin-version-snapshot.test.ts and commit the snapshot.`,
        );
    }
    expect(changed).toEqual([]);
  });

  it('detects a content change under an unchanged version', () => {
    const role = BUILTIN_ROLES[0]!;
    expect(sha({ ...role, instructions: `${role.instructions} x` })).not.toBe(sha(role));
    expect(sha(role)).toBe(sha(structuredClone(role)));
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ComponentRule, replaceComponentVersion } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { atOrAboveFloor, MIN_TRUSTED_RUNNER } from '../src/update/floor.ts';
import { compareVersions } from '../src/update/semver.ts';
import { RUNNER_VERSION } from '../src/version.ts';
import { admin } from './admin/fake-system.ts';

/**
 * The floor does not follow the releases (owner, 2026-11-21): "Not every release forces a new runner upgrade." One version
 * space stays (runner and product), but the floor is 1.10.0 now and is raised later only on purpose, by hand, in all
 * four places at once (docs/RUNNER.md, "Raising the floor"). A release (Ship release, the runner component bump) only
 * rewrites `RUNNER_VERSION` in version.ts.
 */
const ROOT = join(import.meta.dirname, '../../..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const literal = (file: string, name: string) =>
  new RegExp(`${name}\\s*=\\s*['"]([^'"]+)['"]`).exec(read(file))?.[1];

/** The runner rule of the GuildwiseHQ repository (apps/server/src/data-migrations/guildwisehq-runner-rule.ts). */
const RUNNER_RULE: ComponentRule = {
  name: 'runner',
  paths: ['apps/runner/**'],
  versionFile: 'apps/runner/src/version.ts',
  pattern: "RUNNER_VERSION = '(.*)'",
};

const floors = () => ({
  runner: MIN_TRUSTED_RUNNER,
  admin: admin.RUNNER_FLOOR as string,
  server: literal('apps/server/src/installer/release.ts', 'MIN_PAIRABLE_RUNNER'),
  installer: literal('apps/server/src/installer/templates/common.sh', 'SIGNED_RUNNER_FLOOR'),
});

describe('the runner floor stays put when the version moves on', () => {
  it('the four floors are equal to each other, 1.10.0, and at or below RUNNER_VERSION', () => {
    expect(floors()).toEqual({ runner: '1.10.0', admin: '1.10.0', server: '1.10.0', installer: '1.10.0' });
    expect(compareVersions(MIN_TRUSTED_RUNNER, RUNNER_VERSION)).toBeLessThanOrEqual(0);
  });

  it('each floor is a literal of its own: none is derived from RUNNER_VERSION or reads version.ts', () => {
    for (const f of [
      'apps/runner/src/update/floor.ts',
      'apps/runner/admin/guildwise-admin.cjs',
      'apps/server/src/installer/release.ts',
    ])
      expect(read(f), f).not.toMatch(/from ['"][./]*version(\.ts)?['"]|require\(['"][./]*version/);
    expect(read('apps/runner/src/update/floor.ts')).toMatch(/MIN_TRUSTED_RUNNER = '\d+\.\d+\.\d+';/);
    // the package's manifest floor comes from floor.ts, not from the version
    expect(read('scripts/package-runner.sh')).toMatch(/FLOOR=.*MIN_TRUSTED_RUNNER.*update\/floor\.ts/);
  });

  it.each(['patch', 'minor', 'major'] as const)(
    'a %s release bump rewrites only RUNNER_VERSION, and the floor still lets a runner roll back to 1.10.0',
    (level) => {
      const before = read(RUNNER_RULE.versionFile);
      const out = replaceComponentVersion(RUNNER_RULE, before, level);
      if (!out.ok) throw new Error(out.message);
      expect(compareVersions(out.to, RUNNER_VERSION)).toBe(1);
      // the bump touches the version file only, and nothing in it is a floor
      expect(out.text.replace(out.to, out.from)).toBe(before);
      expect(out.text).not.toMatch(/FLOOR|MIN_TRUSTED|MIN_PAIRABLE/);
      // the floors did not move: the release before stays a valid rollback target
      expect(Object.values(floors()).every((f) => f === '1.10.0')).toBe(true);
      expect(compareVersions(MIN_TRUSTED_RUNNER, out.to)).toBe(-1);
      expect(atOrAboveFloor('1.10.0')).toBe(true);
      expect(atOrAboveFloor(RUNNER_VERSION)).toBe(true);
    },
  );
});

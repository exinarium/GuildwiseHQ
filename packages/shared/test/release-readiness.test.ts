import { describe, expect, it } from 'vitest';
import { releaseDocsPrepEvents } from '../src/events/release-docs-prep.ts';
import {
  NO_CHECKED_REPO,
  type ReadinessRepoInput,
  ReleaseDocsPrepOverviewItemSchema,
  ReleaseDocsPrepRunDtoSchema,
  ReleaseDocsPrepSettingsDtoSchema,
  ReleaseDocsPrepSettingsSchema,
  releaseReadiness,
  sameCommit,
} from '../src/index.ts';

const HEAD = 'abcdef1234567890';
const OLD = '1234567deadbeef';
const R1 = '0192f3a0-0000-7000-8000-000000000001';
const R2 = '0192f3a0-0000-7000-8000-000000000002';
const ok = { satisfied: true, missing: [] };

type Env = ReadinessRepoInput['envs'][number];
const env = (over: Partial<Env> = {}): Env => ({
  name: 'test',
  label: 'Test copy',
  current: { commit: HEAD, healthy: true },
  updating: false,
  lastFailed: false,
  gate: ok,
  ...over,
});
const repo = (over: Partial<ReadinessRepoInput> = {}): ReadinessRepoInput => ({
  repoId: R1,
  repoName: 'app',
  head: HEAD,
  envs: [env()],
  live: [],
  ...over,
});

describe('releaseReadiness', () => {
  it('one repository deployed with the gate passing is ready, with a key', () => {
    const r = releaseReadiness([repo()]);
    expect(r.ready).toBe(true);
    expect(r.key).toBe(`${R1}@${HEAD}`);
    expect(r.heads).toEqual({ [R1]: HEAD });
    expect(r.reasons).toEqual([]);
    expect(r.repos[0]).toMatchObject({ state: 'ready', env: 'test', reason: null });
  });

  it('one of two repositories not deployed is not ready and names that repository', () => {
    const r = releaseReadiness([
      repo(),
      repo({ repoId: R2, repoName: 'api', envs: [env({ current: { commit: OLD, healthy: true } })] }),
    ]);
    expect(r.ready).toBe(false);
    expect(r.key).toBeNull();
    expect(r.reasons).toEqual(['api: head abcdef1 is not on Test copy yet (it runs 1234567)']);
  });

  it.each([
    [{ current: null }, 'app: head abcdef1 is not on Test copy yet (nothing deployed yet)'],
    [{ updating: true }, 'app: an update of Test copy is running'],
    [{ lastFailed: true }, 'app: the last update of Test copy failed'],
    [{ current: { commit: HEAD, healthy: false } }, 'app: Test copy is not healthy on abcdef1'],
    [{ gate: { satisfied: false, missing: ['checks passed', 'phase done'] } }, 'app: Test copy gate not met: checks passed; phase done'],
  ] as Array<[Partial<Env>, string]>)('not ready: %o', (over, reason) => {
    const r = releaseReadiness([repo({ envs: [env(over)] })]);
    expect(r.ready).toBe(false);
    expect(r.reasons).toEqual([reason]);
  });

  it('an unread release branch is not ready', () => {
    const r = releaseReadiness([repo({ head: null })]);
    expect(r.ready).toBe(false);
    expect(r.reasons).toEqual(['app: the release branch has not been read yet']);
  });

  it('a repository with no test site is not checked and does not block; with none checked it is not ready', () => {
    const lib = repo({ repoId: R2, repoName: 'lib', envs: [] });
    const both = releaseReadiness([repo(), lib]);
    expect(both.ready).toBe(true);
    expect(both.key).toBe(`${R1}@${HEAD}`);
    expect(both.repos[1]).toMatchObject({ state: 'not_checked', reason: 'lib: no test site deploys it, not checked' });
    const alone = releaseReadiness([lib]);
    expect(alone.ready).toBe(false);
    expect(alone.reasons).toEqual([NO_CHECKED_REPO]);
  });

  it('a live requirement missing, or not evaluated, is not ready to go out', () => {
    const missing = releaseReadiness([
      repo({
        live: [
          { name: 'prod', label: 'Live site', requires: ok },
          {
            name: 'prod2',
            label: 'Live EU',
            requires: { satisfied: false, missing: ['the test copy has been healthy on abcdef1 for 10 minutes'] },
          },
        ],
      }),
    ]);
    expect(missing.ready).toBe(false);
    expect(missing.reasons).toEqual([
      'app: not ready to go out on Live EU: the test copy has been healthy on abcdef1 for 10 minutes',
    ]);
    const unchecked = releaseReadiness([repo({ live: [{ name: 'prod', label: 'Live site', requires: null }] })]);
    expect(unchecked.ready).toBe(false);
    expect(releaseReadiness([repo({ live: [{ name: 'prod', label: 'Live site', requires: ok }] })]).ready).toBe(
      true,
    );
  });

  it('one ready test environment of several is enough; the key is sorted and stable', () => {
    const r = releaseReadiness([
      repo({ repoId: R2, repoName: 'b', envs: [env({ updating: true }), env({ name: 'uat', label: 'UAT' })] }),
      repo(),
    ]);
    expect(r.ready).toBe(true);
    expect(r.key).toBe(`${R1}@${HEAD},${R2}@${HEAD}`);
    expect(r.repos[0]?.env).toBe('uat');
  });

  it('compares commits by prefix of at least 7 characters', () => {
    expect(sameCommit('abcdef1', HEAD)).toBe(true);
    expect(sameCommit('abcdef', HEAD)).toBe(false);
    expect(sameCommit(null, HEAD)).toBe(false);
    expect(sameCommit('ABCDEF1234', HEAD)).toBe(true);
  });
});

const ev = (type: string) => releaseDocsPrepEvents.find((e) => e.shape.type.value === type);

describe('release prep automatic start: schemas', () => {
  it('the settings body accepts a missing autoStart; the DTO defaults it to off', () => {
    expect(ReleaseDocsPrepSettingsSchema.parse({ enabled: true, steps: {} }).autoStart).toBeUndefined();
    expect(ReleaseDocsPrepSettingsSchema.parse({ enabled: true, steps: {}, autoStart: true }).autoStart).toBe(true);
    expect(ReleaseDocsPrepSettingsDtoSchema.parse({ enabled: true, steps: [], canEdit: true }).autoStart).toBe(false);
  });

  it('old and new events parse', () => {
    const set = ev('ReleaseDocsPrepSettingsSet');
    expect(set?.safeParse({ type: 'ReleaseDocsPrepSettingsSet', payload: { projectId: R1, enabled: true, steps: {}, setBy: R2 } }).success).toBe(true);
    const started = ev('ReleaseDocsPrepStarted');
    const base = { runId: R1, projectId: R2, releaseBranch: 'release/1', steps: ['analyse'], repos: [] };
    expect(started?.safeParse({ type: 'ReleaseDocsPrepStarted', payload: { ...base, trigger: 'manual', startedBy: R1 } }).success).toBe(true);
    expect(
      started?.safeParse({
        type: 'ReleaseDocsPrepStarted',
        payload: { ...base, trigger: 'auto', startedBy: null, heads: { [R1]: HEAD }, readyKey: `${R1}@${HEAD}` },
      }).success,
    ).toBe(true);
  });

  it('the run DTO accepts an automatic run and the overview defaults the new fields', () => {
    const run = {
      id: R1,
      projectId: R2,
      releaseBranch: 'release/1',
      status: 'running',
      trigger: 'auto',
      retryOf: null,
      startedBy: null,
      startedAt: '2026-11-08T10:00:00.000Z',
      finishedAt: null,
      failed: null,
      skippedBy: null,
      skippedAt: null,
      steps: [],
      repos: [],
    };
    expect(ReleaseDocsPrepRunDtoSchema.parse(run).startedByName).toBeNull();
    const item = ReleaseDocsPrepOverviewItemSchema.parse({
      projectId: R2,
      key: 'K',
      name: 'n',
      enabled: true,
      releaseBranch: null,
      state: 'not_run',
      canAct: true,
      run: null,
    });
    expect(item).toMatchObject({ autoStart: false, readiness: null, autoStartBlocked: null });
  });
});

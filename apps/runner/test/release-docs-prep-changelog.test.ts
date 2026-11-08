import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReleaseDocsPrepPayload, ReleaseDocsPrepResult } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { runReleaseDocsPrep } from '../src/git/release-docs-prep.ts';
import { changelogStep } from '../src/git/release-docs-prep-changelog.ts';
import { DOCS_PREP_STEP_HANDLERS } from '../src/git/release-docs-prep-steps.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const RUN = '019e3f6a-7b1c-7a2d-8c3e-0123456789e1';
const ID = (n: number) => `019e3f6a-7b1c-7a2d-8c3e-01234567890${n}`;

const EXISTING = `# Changelog

All notable changes to Guildwise HQ are documented in this file.

## [Unreleased]

### Added

- Retire a workstation with agent handover. Pick a workstation and move its agents.

## [1.3.0] - 2026-10-01

### Fixed

- An old fix that stays as written.
`;

const UNDATED = EXISTING.replace(
  '## [1.3.0] - 2026-10-01',
  '## [1.4.0]\n\n### Added\n\n- Pending.\n\n## [1.3.0] - 2026-10-01',
);

const ENTRIES: { heading: 'Added' | 'Fixed'; text: string; sources: string[] }[] = [
  {
    heading: 'Added',
    text: 'Release prep on the Releases page writes the changelog before a release ships.',
    sources: ['s1'],
  },
  {
    heading: 'Fixed',
    text: 'The release page no longer drops entries written under an unknown heading.',
    sources: ['s2'],
  },
];

function commit(clone: string, path: string, text: string, message: string) {
  mkdirSync(dirname(join(clone, path)), { recursive: true });
  writeFileSync(join(clone, path), text);
  sh(clone, 'git', ['add', '-A']);
  sh(clone, 'git', ['commit', '-m', message]);
}

function setup(changelog: string | null) {
  const repo = makeRepo();
  commit(repo.clone, 'README.md', 'hello\n', 'chore: start');
  if (changelog !== null) commit(repo.clone, 'CHANGELOG.md', changelog, 'docs: changelog');
  sh(repo.clone, 'git', ['tag', '-a', 'v1.3.0', '-m', '1.3.0']);
  sh(repo.clone, 'git', ['push', 'origin', 'main', '--tags']);
  sh(repo.clone, 'git', ['checkout', '-b', 'release/1.4.0']);
  commit(repo.clone, 'apps/server/a.ts', 'a', 'feat: a');
  sh(repo.clone, 'git', ['push', '-u', 'origin', 'release/1.4.0']);
  return { repo, integrationDir: tmp('aom-integration-') };
}

type S = ReturnType<typeof setup>;
const payload = (s: S, over: Partial<ReleaseDocsPrepPayload> = {}): ReleaseDocsPrepPayload => ({
  runId: RUN,
  projectId: ID(2),
  repoId: ID(3),
  remoteUrlNormalized: s.repo.remoteNormalized,
  releaseBranch: 'release/1.4.0',
  mainBranch: 'main',
  step: 'analyse',
  components: [],
  projectKey: 'GWP',
  commitAs: { name: 'Release Owner', email: 'owner@example.test' },
  ...over,
});
const run = (s: S, over: Partial<ReleaseDocsPrepPayload> = {}): Promise<ReleaseDocsPrepResult> =>
  runReleaseDocsPrep({ payload: payload(s, over), repoPath: s.repo.clone, integrationDir: s.integrationDir });

/** analyse, changelog (with `entries`), commit prepare and push. Returns the changelog answer and the pushed file. */
async function prep(s: S, entries: typeof ENTRIES, runId = RUN, phase?: string) {
  const a = await run(s, { runId });
  const common = {
    runId,
    ...(a.summary ? { summary: a.summary } : {}),
    base: { sha: a.baseSha as string, tag: a.baseTag ?? null },
  };
  const c = await run(s, {
    ...common,
    step: 'changelog',
    ...(phase ? { phase } : {}),
    changelog: { projectName: 'Guildwise HQ', entries },
  });
  if (c.state === 'passed') {
    await run(s, { ...common, step: 'commit', phase: 'prepare' });
    await run(s, { ...common, step: 'commit', phase: 'push' });
  }
  let file = '';
  try {
    file = execFileSync('git', ['show', 'release/1.4.0:CHANGELOG.md'], {
      cwd: s.repo.origin,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    file = '';
  }
  return { c, file };
}

describe('release.docs_prep changelog', () => {
  it('is registered as the changelog step', () => {
    expect(DOCS_PREP_STEP_HANDLERS.changelog).toBe(changelogStep);
  });

  it('the apply phase behaves like the single phase: same file, same commit', async () => {
    const one = await prep(setup(EXISTING), ENTRIES);
    const apply = await prep(setup(EXISTING), ENTRIES, RUN, 'apply');
    expect(apply.c.state).toBe('passed');
    expect(apply.c.files).toEqual(one.c.files);
    expect(apply.file).toBe(one.file);
  });

  it('adds the entries under Unreleased, keeps the old ones and reports them', async () => {
    const s = setup(EXISTING);
    const { c, file } = await prep(s, ENTRIES);
    expect(c.state).toBe('passed');
    expect(c.files).toEqual(['CHANGELOG.md']);
    expect(c.output).toMatchObject({
      created: false,
      added: [
        { heading: 'Added', sources: ['s1'] },
        { heading: 'Fixed', sources: ['s2'] },
      ],
      duplicates: [],
    });
    expect(file).toContain('- Retire a workstation with agent handover.');
    expect(file).toContain('- Release prep on the Releases page');
    expect(file).toContain('### Fixed\n\n- The release page no longer drops');
    expect(file).toContain('## [1.3.0] - 2026-10-01\n\n### Fixed\n\n- An old fix that stays as written.');
  });

  it('is idempotent: a second run on the pushed branch changes nothing', async () => {
    const s = setup(EXISTING);
    const first = await prep(s, ENTRIES);
    const second = await prep(s, ENTRIES, '019e3f6a-7b1c-7a2d-8c3e-0123456789e2');
    expect(second.c.state).toBe('passed');
    expect(second.c.files).toEqual([]);
    expect((second.c.output as { duplicates: unknown[] }).duplicates).toHaveLength(2);
    expect(second.file).toBe(first.file);
  });

  it('creates CHANGELOG.md when the repository has none', async () => {
    const s = setup(null);
    const { c, file } = await prep(s, [ENTRIES[0] as (typeof ENTRIES)[number]]);
    expect(c.state).toBe('passed');
    expect(c.output).toMatchObject({ created: true });
    expect(file).toBe(
      `# Changelog\n\nAll notable changes to Guildwise HQ are documented in this file.\n\n## [Unreleased]\n\n### Added\n\n- ${ENTRIES[0]?.text}\n`,
    );
  });

  it('writes nothing and creates no file when there are no entries', async () => {
    const s = setup(null);
    const { c, file } = await prep(s, []);
    expect(c.state).toBe('passed');
    expect(c.files).toEqual([]);
    expect(file).toBe('');
  });

  it('fails a malformed file with the reason and leaves it untouched', async () => {
    const s = setup(UNDATED);
    const { c, file } = await prep(s, ENTRIES);
    expect(c.state).toBe('failed');
    expect(c.error).toContain('## [1.4.0] section without a date');
    expect(file).toBe(UNDATED);
  });

  /** The parts of the step context the changelog step does not use (no process). */
  const ctxStubs = () => ({
    outDir: tmp('aom-cl-out-'),
    exec: async () => ({ exitCode: 1, stdout: '', stderr: 'not used', timedOut: false }),
  });

  it('fails when the server sent no entries', async () => {
    const wt = tmp('aom-cl-');
    const r = await changelogStep({
      worktree: wt,
      payload: { step: 'changelog' } as never,
      summary: undefined,
      ...ctxStubs(),
      phase: '',
      input: undefined,
      repoPath: wt,
      dataDir: undefined,
      start: '',
    });
    expect(r).toEqual({ ok: false, error: 'the server sent no changelog entries: update the server' });
  });

  it('applies to a second repository independently', async () => {
    const wt = tmp('aom-cl-');
    const tight =
      '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-03\n\n### Changed\n\n- one\n- two\n';
    writeFileSync(join(wt, 'CHANGELOG.md'), tight);
    const r = await changelogStep({
      worktree: wt,
      payload: { step: 'changelog', changelog: { projectName: 'P', entries: ENTRIES } } as never,
      summary: undefined,
      ...ctxStubs(),
      phase: '',
      input: undefined,
      repoPath: wt,
      dataDir: undefined,
      start: '',
    });
    expect(r.ok).toBe(true);
    const md = readFileSync(join(wt, 'CHANGELOG.md'), 'utf8');
    expect(md).toContain(
      `### Added\n\n- ${ENTRIES[0]?.text}\n\n### Fixed\n\n- ${ENTRIES[1]?.text}\n\n## [0.1.0]`,
    );
  });
});

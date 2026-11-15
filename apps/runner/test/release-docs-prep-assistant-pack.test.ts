import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReleaseDocsPrepPayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { runReleaseDocsPrep } from '../src/git/release-docs-prep.ts';
import type { DocsPrepExec } from '../src/git/release-docs-prep-steps.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const RUN = '019e3f6a-7b1c-7a2d-8c3e-0123456789e2';
const ID = (n: number) => `019e3f6a-7b1c-7a2d-8c3e-01234567890${n}`;
const GENERATOR = 'apps/server/scripts/build-assistant-pack.ts';
const PACK = 'apps/server/src/assistant/pack/topics/desk.md';

function write(dir: string, path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** main (tagged), then release/1.5.0 with one commit; with the pack generator and a committed pack unless `pack: false`. */
function setup(opts: { pack?: boolean } = {}) {
  const repo = makeRepo();
  write(repo.clone, 'README.md', 'hello\n');
  if (opts.pack ?? true) {
    write(repo.clone, GENERATOR, '// builds the pack\n');
    write(repo.clone, PACK, '### Your desk\n- Desk items: old\n');
  }
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'chore: start']);
  sh(repo.clone, 'git', ['tag', '-a', 'v1.4.0', '-m', '1.4.0']);
  sh(repo.clone, 'git', ['push', 'origin', 'main', '--tags']);
  sh(repo.clone, 'git', ['checkout', '-b', 'release/1.5.0']);
  write(repo.clone, 'apps/web/src/help/articles/desk.md', '# desk\n');
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'docs: desk article']);
  sh(repo.clone, 'git', ['push', '-u', 'origin', 'release/1.5.0']);
  return { repo, integrationDir: tmp('aom-integration-') };
}

type S = ReturnType<typeof setup>;

const payload = (s: S, over: Partial<ReleaseDocsPrepPayload> = {}): ReleaseDocsPrepPayload => ({
  runId: RUN,
  projectId: ID(2),
  repoId: ID(3),
  remoteUrlNormalized: s.repo.remoteNormalized,
  releaseBranch: 'release/1.5.0',
  mainBranch: 'main',
  step: 'assistant-pack',
  components: [],
  projectKey: 'GWP',
  commitAs: { name: 'Release Owner', email: 'owner@example.test' },
  ...over,
});

/** A fake process: records the calls; the generator call runs `effect` in the worktree. */
function fakeExec(effect?: (cwd: string) => void, exitCode = 0) {
  const calls: string[][] = [];
  const exec: DocsPrepExec = async (cmd, args, { cwd }) => {
    calls.push([cmd, ...args]);
    if (args.includes('assistant:pack')) effect?.(cwd);
    return { exitCode, stdout: '', stderr: exitCode ? 'boom' : '', timedOut: false };
  };
  return { calls, exec };
}

const run = (s: S, e: ReturnType<typeof fakeExec>) =>
  runReleaseDocsPrep({
    payload: payload(s),
    repoPath: s.repo.clone,
    integrationDir: s.integrationDir,
    exec: e.exec,
  });

const workRef = `refs/guildwise/docs-prep/${RUN}/work`;

describe("release prep step 'assistant-pack'", () => {
  it('regenerates the pack through the runner process and keeps it as the step commit', async () => {
    const s = setup();
    const e = fakeExec((wt) => write(wt, PACK, '### Your desk\n- Desk items: new\n'));
    const r = await run(s, e);
    expect(r.state).toBe('passed');
    expect(r.files).toEqual([PACK]);
    expect(e.calls).toEqual([
      ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--prefer-offline'],
      ['corepack', 'pnpm', '--filter', '@aom/server', 'assistant:pack'],
    ]);
    expect(sh(s.repo.clone, 'git', ['show', `${workRef}:${PACK}`])).toContain('Desk items: new');
    expect(sh(s.repo.clone, 'git', ['log', '-1', '--format=%s', workRef])).toBe(
      'docs(release): assistant-pack',
    );
    // nothing on the release branch itself
    expect(sh(s.repo.clone, 'git', ['rev-parse', 'release/1.5.0'])).toBe(
      sh(s.repo.clone, 'git', ['rev-parse', 'origin/release/1.5.0']),
    );
  });

  it('a pack that already matches its Help changes nothing', async () => {
    const s = setup();
    const r = await run(s, fakeExec());
    expect(r.state).toBe('passed');
    expect(r.files).toEqual([]);
    expect(r.notices).toContain('no changes');
  });

  it('skips a repository without the generator, running nothing', async () => {
    const s = setup({ pack: false });
    const e = fakeExec();
    const r = await run(s, e);
    expect(r.state).toBe('skipped');
    expect(r.error).toBe('skipped: no assistant pack in this repository');
    expect(e.calls).toEqual([]);
  });

  it('fails when the generator changes a file outside the pack', async () => {
    const s = setup();
    const r = await run(
      s,
      fakeExec((wt) => {
        write(wt, PACK, '### Your desk\n- Desk items: new\n');
        write(wt, 'apps/server/src/other.ts', 'export {}\n');
      }),
    );
    expect(r.state).toBe('failed');
    expect(r.error).toContain('changed apps/server/src/other.ts');
  });

  it('fails with the output tail when the generator fails', async () => {
    const s = setup();
    const r = await run(s, fakeExec(undefined, 1));
    expect(r.state).toBe('failed');
    expect(r.error).toContain('the assistant knowledge pack could not be regenerated: boom');
  });
});

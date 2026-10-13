import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hygieneReportEvents, workingBranchQuestionEvents } from '../src/commands/hygiene.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const ctx = () => w.t.app.ctx;
const load = async () => ({
  project: (await q('SELECT * FROM projects WHERE id=$1', [w.projectId]))[0]!,
  repo: (await q('SELECT * FROM project_repos WHERE id=$1', [w.repoId]))[0]!,
});
const types = (events: Array<{ event: { type: string } }>) => events.map((e) => e.event.type);

describe('working branch without questions (simple mode)', () => {
  it('confirms the repository default branch itself, and asks only when no default can be told', async () => {
    await q('UPDATE project_repos SET working_branch=NULL, working_branch_set_at=NULL WHERE id=$1', [
      w.repoId,
    ]);
    const { project, repo } = await load();
    const ask = (branches: string[]) =>
      workingBranchQuestionEvents(ctx(), ctx().pool, project, repo, { reason: 'unconfirmed', branches });

    const auto = await ask(['develop', 'main']);
    expect(types(auto)).toEqual(['ProjectRepoWorkingBranchSet']);
    expect((auto[0]!.event as any).payload).toMatchObject({ workingBranch: 'main', reason: 'unconfirmed' });

    const onlyMaster = await ask(['master']);
    expect((onlyMaster[0]!.event as any).payload.workingBranch).toBe('master');

    expect(types(await ask(['develop', 'staging']))).toEqual(['QuestionRaised']);
  });

  it('does not ask "keep it?" for a new phase unless a manager turned expert mode on', async () => {
    await q('UPDATE project_repos SET working_branch=$2, working_branch_set_at=now() WHERE id=$1', [
      w.repoId,
      'main',
    ]);
    const { project, repo } = await load();
    const ask = () =>
      workingBranchQuestionEvents(ctx(), ctx().pool, project, repo, {
        reason: 'phase',
        because: 'the new phase',
      });
    await q('UPDATE users SET git_expert=false');
    expect(await ask()).toEqual([]);
    await q('UPDATE users SET git_expert=true WHERE id=$1', [w.owner.id]);
    expect(types(await ask())).toEqual(['QuestionRaised']);
  });
});

describe('working branch options', () => {
  it('never offers runner-owned or agent card branches', async () => {
    await q('UPDATE project_repos SET working_branch=$2, working_branch_set_at=now() WHERE id=$1', [
      w.repoId,
      'main',
    ]);
    await q('UPDATE users SET git_expert=true WHERE id=$1', [w.owner.id]);
    const { project, repo } = await load();
    const ev = await workingBranchQuestionEvents(ctx(), ctx().pool, project, repo, {
      reason: 'phase',
      because: 'the new phase',
      branches: [
        'main',
        'develop',
        'guildwise/saved-work/2026-10-10',
        'conflict/abc',
        'aom-integration/x',
        'aom/toy-1-thing',
      ],
    });
    const labels = ((ev[0]!.event as any).payload.options as Array<{ label: string }>).map((o) => o.label);
    expect(labels).toContain('develop');
    expect(labels.join(' ')).not.toMatch(/saved-work|conflict\/|aom-integration|aom\//);
  });
});

describe('the saved-work notice', () => {
  it('tells the managers where the unsaved edits went and which files were left alone', async () => {
    const { project, repo } = await load();
    const spec = {
      trigger: 'manual' as const,
      repos: [
        {
          repoId: repo.id as string,
          projectId: project.id as string,
          projectKey: 'TOY',
          projectName: 'Toy',
          name: 'toy',
          localPath: '/tmp/toy',
          remoteUrl: 'https://example.test/acme/toy.repo',
          workingBranch: 'main',
          branchSource: 'repo' as const,
          branchPrefix: 'aom/',
          finishedBranches: [],
        },
      ],
    };
    const report = {
      repos: [
        {
          repoId: repo.id as string,
          actions: [],
          problem: null,
          branches: ['main'],
          uncommitted: [],
          pushed: false,
          removedBranches: [],
          cleaned: [],
          savedWork: {
            branch: 'guildwise/saved-work/2026-10-10',
            files: ['a.txt', 'b.txt'],
            skipped: ['.env'],
            pushed: true,
          },
        },
      ],
    };
    const events = await hygieneReportEvents(
      ctx(),
      ctx().pool as never,
      { id: w.projectId, org_id: project.org_id, workstation_id: w.workstationId, hygiene: spec },
      '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      report,
    );
    const notice = events.find((e) => (e.event as any).payload?.subkind === 'saved_work');
    expect(notice).toBeTruthy();
    const p = (notice!.event as any).payload;
    expect(p).toMatchObject({ kind: 'alert', blocking: false, projectId: project.id });
    expect(p.title).toBe('Your unsaved work in toy was stored safely');
    expect(p.body).toContain('guildwise/saved-work/2026-10-10');
    expect(p.body).toContain('nothing reached the working branch');
    expect(p.body).toContain('.env');
  });
});

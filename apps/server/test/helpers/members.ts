import { uniqueEmail } from './app.ts';
import { FakeRunner } from './fake-runner.ts';
import { MOCK_RUNTIME, ok, pairWorkstation, REPO_SSH, type Session, type World } from './world.ts';

export interface Member extends Session {
  workstationId: string;
  runnerToken: string;
}

/** A second user that accepted a share of the world's project, with a paired workstation. */
export async function addMember(w: World, label = 'member'): Promise<Member> {
  const m = await w.t.userSession(uniqueEmail(label));
  await ok(
    w.t.req('POST', `/api/projects/${w.projectId}/members`, {
      cookie: w.owner.cookie,
      body: { email: m.email },
    }),
    201,
  );
  await ok(w.t.req('POST', `/api/projects/${w.projectId}/members/accept`, { cookie: m.cookie }));
  const ws = await pairWorkstation(w.t, m, `${label}-box`);
  return { ...m, ...ws };
}

/** Connects the member's runner (hello with the toy repo) and waits until it is reconciled. */
export async function connectMemberRunner(w: World, m: Member): Promise<FakeRunner> {
  const r = await FakeRunner.connect(w.baseUrl, m.runnerToken);
  r.hello({
    repos: [{ remoteUrl: REPO_SSH, localPath: '/tmp/toy-member', headBranch: 'main' }],
    runtimes: MOCK_RUNTIME,
  });
  await r.waitFor('welcome');
  await w.t.app.ctx.notifier.flush();
  return r;
}

export const hireFor = (
  w: World,
  m: Session & { workstationId: string },
  name: string,
  roleKey: string,
  seniority: 'junior' | 'senior',
  extra: Record<string, unknown> = {},
) =>
  ok<any>(
    w.t.req('POST', '/api/agents', {
      cookie: m.cookie,
      body: {
        name,
        roleKey,
        seniority,
        workstationId: m.workstationId,
        projectId: w.projectId,
        runtime: 'mock',
        model: 'mock',
        ...extra,
      },
    }),
    201,
  );

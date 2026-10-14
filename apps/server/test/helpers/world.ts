import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp, uniqueEmail } from './app.ts';
import { q } from './db.ts';
import { FakeRunner } from './fake-runner.ts';

export interface Session {
  id: string;
  email: string;
  cookie: string;
}

export const REPO_URL = 'https://github.com/acme/toy.git';
export const REPO_SSH = 'git@github.com:acme/toy.git';

export const MOCK_RUNTIME = [
  { id: 'mock', version: '1', available: true, capabilities: ['shell', 'edit', 'web'] },
];

export async function ok<T = any>(p: Promise<{ status: number; body: any }>, status = 200): Promise<T> {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

export async function pairWorkstation(t: TestApp, s: Session, name = 'Desk') {
  const { code } = await ok<{ code: string }>(
    t.req('POST', '/api/workstations/pairing-codes', { cookie: s.cookie }),
    201,
  );
  const r = await ok<{ workstationId: string; runnerToken: string }>(
    t.req('POST', '/api/runner/pair', {
      body: { code, name, platform: 'linux', hostname: `host-${name}`, runnerVersion: '0.0.0-test' },
    }),
  );
  return r;
}

/** Marks a workstation online in the DB without a socket (dispatcher tests). */
export async function markOnline(
  t: TestApp,
  workstationId: string,
  opts: { runtimes?: unknown; repoIds?: string[] } = {},
) {
  await q(`UPDATE workstations SET connected=true, last_seen_at=$2, runtimes=$3 WHERE id=$1`, [
    workstationId,
    t.clock.now(),
    JSON.stringify(opts.runtimes ?? MOCK_RUNTIME),
  ]);
  await q('DELETE FROM workstation_repos WHERE workstation_id=$1', [workstationId]);
  for (const repoId of opts.repoIds ?? []) {
    await q(
      `INSERT INTO workstation_repos (workstation_id, project_repo_id, local_path, reported_at) VALUES ($1,$2,'/tmp/x',$3)`,
      [workstationId, repoId, t.clock.now()],
    );
  }
}

export interface World {
  t: TestApp;
  owner: Session;
  projectId: string;
  repoId: string;
  workstationId: string;
  runnerToken: string;
  baseUrl: string;
  /** Connect a fake runner with hello (repos matching the toy repo) and wait for welcome + reconcile. */
  connectRunner(opts?: {
    hello?: boolean;
    capabilities?: string[];
    maxRunEnvironments?: number;
  }): Promise<FakeRunner>;
  hire(
    name: string,
    roleKey: string,
    seniority: 'junior' | 'senior',
    extra?: Record<string, unknown>,
  ): Promise<any>;
  card(over?: Record<string, unknown>): Promise<any>;
}

export const fullFields = (extra: Record<string, unknown> = {}) => ({
  context: 'ctx',
  requirements: 'reqs',
  acceptanceCriteria: ['it works'],
  affectedAreas: 'src/',
  constraints: 'none',
  testPlan: 'run tests',
  ...extra,
});

export async function createWorld(
  opts: { env?: Record<string, string>; project?: Record<string, unknown>; listen?: boolean } = {},
): Promise<World> {
  const t = await createTestApp({ env: opts.env, listen: opts.listen ?? true });
  const owner = await t.userSession(uniqueEmail('owner'));
  const proj = await ok<any>(
    t.req('POST', '/api/projects', {
      cookie: owner.cookie,
      body: { key: 'TOY', name: 'Toy', ...opts.project },
    }),
    201,
  );
  const added = await ok<any>(
    t.req('POST', `/api/projects/${proj.project.id}/repos`, {
      cookie: owner.cookie,
      body: { name: 'toy', remoteUrl: REPO_URL },
    }),
    201,
  );
  const repoId = added.repos[0].id as string;
  const { workstationId, runnerToken } = await pairWorkstation(t, owner);
  const addr = t.app.server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  const world: World = {
    t,
    owner,
    projectId: proj.project.id,
    repoId,
    workstationId,
    runnerToken,
    baseUrl,
    async connectRunner(o = {}) {
      const r = await FakeRunner.connect(baseUrl, runnerToken);
      if (o.hello !== false) {
        r.hello({
          repos: [{ remoteUrl: REPO_SSH, localPath: '/tmp/toy', headBranch: 'main' }],
          runtimes: MOCK_RUNTIME,
          ...(o.capabilities ? { capabilities: o.capabilities } : {}),
          ...(o.maxRunEnvironments ? { maxRunEnvironments: o.maxRunEnvironments } : {}),
        });
        await r.waitFor('welcome');
        await t.app.ctx.notifier.flush();
      }
      return r;
    },
    hire: (name, roleKey, seniority, extra = {}) =>
      ok(
        t.req('POST', '/api/agents', {
          cookie: owner.cookie,
          body: { name, roleKey, seniority, workstationId, runtime: 'mock', model: 'mock', ...extra },
        }),
        201,
      ),
    card: async (over = {}) => {
      const body = await ok<any>(
        t.req('POST', '/api/cards', {
          cookie: owner.cookie,
          body: {
            projectId: proj.project.id,
            title: `Card ${randomUUID().slice(0, 4)}`,
            cardType: 'feature',
            fields: fullFields(),
            completionAction: 'merge',
            specify: true,
            ...over,
          },
        }),
        201,
      );
      return body.card;
    },
  };
  return world;
}

/** Failure-only bound of every wait on an observable condition. */
export const MIN_WAIT_MS = 30_000;

export async function until<T>(
  fn: () => Promise<T | false | undefined | null>,
  timeoutMs = 5000,
  what = 'condition',
): Promise<T> {
  const start = Date.now();
  // The wait ends the moment the condition holds, so the bound only matters when something is really wrong. The
  // per-call guesses (3 s, 5 s) were tuned for an idle machine; the suites run side by side with the runner's.
  const bound = Math.max(timeoutMs, MIN_WAIT_MS);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > bound) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

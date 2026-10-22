import { execFileSync } from 'node:child_process';
import { type APIRequestContext, expect } from '@playwright/test';
import { apiAs } from '../support/api.ts';
import { waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, DATABASE_URL, paths, ROOT } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

/**
 * Shared seeding for the video specs. Every spec calls these from its own `beforeAll` (rule 2 of
 * docs/guide/VIDEO-PLAN.md): it never relies on another video's data. The demo stack always has the organization
 * "Acme" and its Owner "Alex Morgan" (created by the global setup, see defaults.ts) and only demo data is added:
 * invented names, `@demo.local` and `example.com` addresses, the mock agent runtime and a toy git repository.
 */

/** The Owner's API client (Alex Morgan, organization Acme). */
export async function demoApi(): Promise<APIRequestContext> {
  return apiAs(ADMIN.email, ADMIN.password);
}

/**
 * Pairs a mock runner (a workstation called `name`, serving the repositories under the toy repo root) and waits until
 * it is connected; returns the workstation id. The runner is stopped by the global teardown. `home` is its data dir
 * (one per workstation). `env` is extra environment for the runner process.
 */
export async function pairWorkstation(
  api: APIRequestContext,
  name = "Alex's laptop",
  home = paths.runnerHome('video'),
  env: Record<string, string> = {},
): Promise<string> {
  const before = ((await (await api.get('/api/workstations')).json()).workstations as unknown[]).length;
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, name, home);
  addRepoRoot(paths.repoRoot, home);
  startRunner(env, home);
  const list = await waitFor(
    `runner ${name} connected`,
    async () =>
      (await (await api.get('/api/workstations')).json()).workstations as Array<{
        id: string;
        name: string;
        connected: boolean;
      }>,
    (w) => w.length > before && w.find((x) => x.name === name)?.connected === true,
    30_000,
  );
  return (list.find((w) => w.name === name) as { id: string }).id;
}

/** A project, and (unless `repo: false`) the toy repository from the global setup as its repository, called `repo`. */
export async function createProject(
  api: APIRequestContext,
  key: string,
  name: string,
  opts: { repo?: string | false; workflowKey?: string } = {},
): Promise<{ projectId: string; repoId?: string }> {
  const proj = await api.post('/api/projects', {
    data: { key, name, ...(opts.workflowKey ? { workflowKey: opts.workflowKey } : {}) },
  });
  expect(proj.status(), await proj.text()).toBe(201);
  const projectId = (await proj.json()).project.id as string;
  if (opts.repo === false) return { projectId };
  const add = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: opts.repo ?? 'shop', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status(), await add.text()).toBe(201);
  return { projectId, repoId: (await add.json()).repos[0].id as string };
}

/**
 * Hires a mock-runtime agent and returns its id. `roleKey` is a role of the catalogue (ba, planner, architect, builder,
 * pre_reviewer, reviewer, tester, researcher, ...). Without `seniority` it hires a junior when the role has juniors,
 * else the role's first level (the BA, the architect, the reviewer and DevOps are senior only).
 */
export async function hireAgent(
  api: APIRequestContext,
  a: { name: string; roleKey: string; seniority?: string; workstationId: string; projectId?: string },
): Promise<string> {
  let seniority = a.seniority;
  if (!seniority) {
    const roles = (await (await api.get('/api/roles')).json()).roles as Array<{
      definition: { key: string; seniorityLevels: string[] };
    }>;
    const levels = roles.find((r) => r.definition.key === a.roleKey)?.definition.seniorityLevels ?? [];
    seniority = levels.includes('junior') ? 'junior' : (levels[0] ?? 'senior');
  }
  const r = await api.post('/api/agents', { data: { runtime: 'mock', ...a, seniority } });
  expect(r.status(), `${a.name}: ${await r.text()}`).toBe(201);
  const id = ((await r.json()) as { id?: string }).id; // the route answers with the agent itself
  expect(id, `${a.name}: the hire returns the agent id`).toBeTruthy();
  return id as string;
}

/** A feature card with a complete brief (queued for the team unless `specify: false`). */
export async function createCard(
  api: APIRequestContext,
  c: { projectId: string; repoId: string; title: string; specify?: boolean },
): Promise<void> {
  const r = await api.post('/api/cards', {
    data: {
      projectId: c.projectId,
      title: c.title,
      cardType: 'feature',
      repoId: c.repoId,
      completionAction: 'merge',
      fields: {
        context: 'Demo context.',
        requirements: c.title,
        acceptanceCriteria: ['It works', 'It is visible'],
        affectedAreas: 'index.js',
        constraints: 'None',
        testPlan: 'Open the page',
      },
      specify: c.specify ?? true,
    },
  });
  expect(r.status(), await r.text()).toBe(201);
}

/**
 * Gives Acme its built-in CEO (the global setup's organization is created before the role catalogue, so it has none
 * yet). Call it before `pairWorkstation`: the Owner's first workstation becomes the CEO's home. With `mock` (the
 * default) the CEO runs on the mock runtime, so the recording never needs a real model.
 */
export async function provisionCeo(
  api: APIRequestContext,
  mock = true,
): Promise<{ id: string; name: string }> {
  execFileSync('pnpm', ['--filter', '@aom/server', 'exec', 'tsx', `${ROOT}/e2e/support/provision-ceo.ts`], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL },
    stdio: 'pipe',
  });
  const agents = (await (await api.get('/api/agents')).json()).agents as Array<{
    id: string;
    name: string;
    roleKey: string;
  }>;
  const ceo = agents.find((a) => a.roleKey === 'ceo');
  expect(ceo, 'the built-in CEO exists').toBeTruthy();
  if (mock) {
    const r = await api.patch(`/api/agents/${ceo?.id}`, { data: { runtime: 'mock', model: 'mock' } });
    expect(r.ok(), await r.text()).toBe(true);
  }
  return ceo as { id: string; name: string };
}

/** Real CEO decisions through the server's action engine (see ceo-act.ts). Returns one result per action. */
export function ceoAct(
  acts: Array<{ action: string; params: Record<string, unknown>; reason: string; confidence?: number }>,
): Array<{ action: string; status: string; mode?: string; message: string }> {
  const out = execFileSync(
    'pnpm',
    [
      '--silent',
      '--filter',
      '@aom/server',
      'exec',
      'tsx',
      `${ROOT}/e2e/video/ceo-act.ts`,
      JSON.stringify(acts.map((a) => ({ confidence: 0.9, ...a }))),
    ],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL }, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .filter((l) => l.startsWith('{"action"'))
    .map((l) => JSON.parse(l));
}

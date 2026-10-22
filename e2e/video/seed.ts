import { type APIRequestContext, expect } from '@playwright/test';
import { apiAs } from '../support/api.ts';
import { waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, paths } from '../support/env.ts';
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

/** Hires a mock-runtime agent. `roleKey` is one of ba, planner, architect, builder, pre_reviewer, reviewer, tester. */
export async function hireAgent(
  api: APIRequestContext,
  a: { name: string; roleKey: string; seniority?: string; workstationId: string; projectId?: string },
): Promise<string> {
  const r = await api.post('/api/agents', { data: { seniority: 'junior', runtime: 'mock', ...a } });
  expect(r.status(), `${a.name}: ${await r.text()}`).toBe(201);
  return (await r.json()).agent?.id as string;
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
      completionAction: 'push_branch',
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

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, type Browser, expect } from '@playwright/test';
import { apiAs } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, DATABASE_URL, E2E_DIR, paths, ROOT } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

/**
 * Shared seeding for the video specs. Every spec calls these from its own `beforeAll` (rule 2 of
 * docs/guide/VIDEO-PLAN.md): it never relies on another video's data. The demo stack always has the organization
 * "Acme" and its Owner "Alex Morgan" (created by the global setup, see defaults.ts) and only demo data is added:
 * invented names, `@demo.local` and `example.com` addresses, the mock agent runtime and a toy git repository.
 */

/** The Owner's demo address. The stack signs the Owner up as `admin@e2e.test`; the video shows this one instead. */
export const OWNER_EMAIL = 'alex.morgan@demo.local';

/**
 * The Owner's API client (Alex Morgan, organization Acme). Call it first in every spec, before `pairWorkstation`.
 * - It renames the Owner's sign-in address from the stack's e2e address to the demo one in the database, so every
 *   screen that shows it (the user menu, members, project members, the activity) shows only demo data.
 * - It gives Acme its built-in CEO on the mock runtime, as every new organization has in production (the stack creates
 *   Acme with `admin:create` before the role catalogue exists, so it starts without one). `ceo: false` skips it.
 */
export async function demoApi(opts: { ceo?: boolean } = {}): Promise<APIRequestContext> {
  await q('UPDATE users SET email=$1 WHERE lower(email)=lower($2)', [OWNER_EMAIL, ADMIN.email]);
  const api = await apiAs(OWNER_EMAIL, ADMIN.password);
  if (opts.ceo ?? true) await provisionCeo(api);
  return api;
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
 * default) the CEO runs on the mock runtime, so the recording never needs a real model. `demoApi` already calls it;
 * calling it again is harmless (it returns the same CEO).
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

/**
 * A connected local-folder storage ("Organization settings > Storage"), added off camera through the real add and connect
 * dialogs (steps of e2e/tests/storage.spec.ts), and the id of its connection. A form cannot be published without one.
 * The workstation must be paired and online. The folder `folder` is created under the stack's e2e directory.
 */
export async function addLocalStorage(
  browser: Browser,
  api: APIRequestContext,
  workstationId: string,
  label: string,
  folder = join(E2E_DIR, 'storage-local'),
): Promise<string> {
  await waitFor(
    'the workstation announced storage:1',
    () =>
      q<{ capabilities: string[] }>(
        'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1',
        [workstationId],
      ),
    (rows) => rows.some((r) => r.capabilities.includes('storage:1')),
    30_000,
  );
  mkdirSync(folder, { recursive: true });
  const context = await browser.newContext({ storageState: await api.storageState() });
  const page = await context.newPage();
  // The server's test clock can be ahead of real time (a run late in the evening) while the runner checks the sealed
  // values' expiry against the workstation's real clock: seal with the real time, as a live server would give.
  await page.route('**/api/workstations/*/integrations', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (typeof body?.serverTime === 'string') body.serverTime = new Date().toISOString();
    await route.fulfill({ response: res, json: body });
  });
  try {
    await page.goto('/settings/org?tab=storage');
    await page.getByTestId('storage-new').click();
    const add = page.getByTestId('storage-add-dialog');
    await add.getByLabel('Type').selectOption('local');
    await add.getByLabel('Display name').fill(label);
    await expect(add.getByLabel('Workstation')).toHaveValue(workstationId);
    await page.getByTestId('storage-add-next').click();
    const dialog = page.getByTestId('storage-connect-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Folder on the workstation').fill(folder);
    await expect(page.getByTestId('storage-seal-connect')).toBeEnabled();
    await page.getByTestId('storage-seal-connect').click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const list = (await (await api.get('/api/org/storage/connections')).json()).connections as Array<{
      id: string;
      label: string;
    }>;
    const id = list.find((c) => c.label === label)?.id as string;
    expect(id, `the connection "${label}" is listed`).toBeTruthy();
    await expect(page.getByTestId(`storage-state-${id}`)).toHaveText('Connected', { timeout: 20_000 });
    return id;
  } finally {
    await context.close();
  }
}

/**
 * The demo "Rental application" form (six fields, answers and the ID copy go to the storage connection `storageId`),
 * saved and published. Returns its ids and the public address. Used by the forms and journeys videos.
 */
export async function createRentalForm(
  api: APIRequestContext,
  storageId: string,
): Promise<{ formId: string; publicId: string; url: string }> {
  const to = (folder: string, name: string) => ({ connectionId: storageId, folder, name });
  const definition = {
    schemaVersion: 1,
    settings: {
      title: 'Rental application',
      description: 'Tell us about the home you would like to rent.',
      logo: null,
      answersDestination: to('Forms/{form}', '{date}-{submission}'),
      confirmationText: 'Thank you. We have received your application.',
    },
    fields: [
      { type: 'short_text', id: 'full_name', label: 'Full name', required: true },
      { type: 'email', id: 'email_addr', label: 'Email', required: true },
      { type: 'phone', id: 'phone_no', label: 'Phone number', required: false },
      { type: 'date', id: 'move_in', label: 'Preferred move-in date', required: false },
      {
        type: 'dropdown',
        id: 'unit_type',
        label: 'Home type',
        required: false,
        options: ['Studio', 'One bedroom', 'Two bedrooms'],
      },
      {
        type: 'file',
        id: 'id_copy',
        label: 'Copy of your ID',
        required: false,
        allowedTypes: ['.pdf', '.jpg', '.jpeg', '.png'],
        maxSizeBytes: 5 * 1024 * 1024,
        destination: to('Forms/{form}/{submission}', '{field}-{original}'),
      },
    ],
  };
  const created = await api.post('/api/forms', { data: { definition } });
  expect(created.status(), await created.text()).toBe(201);
  const formId = (await created.json()).id as string;
  const pub = await api.post(`/api/forms/${formId}/publish`);
  expect(pub.ok(), await pub.text()).toBeTruthy();
  const p = (await pub.json()) as { publicId: string; url: string };
  return { formId, publicId: p.publicId, url: p.url };
}

/** A personal link of a published form; returns the address the client opens. */
export async function createClientLink(
  api: APIRequestContext,
  formId: string,
  reference: string,
  expiresInDays = 14,
): Promise<string> {
  const r = await api.post(`/api/forms/${formId}/client-links`, { data: { reference, expiresInDays } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).url as string;
}

/** Fills and sends a public form (a client's answers) in a fresh browser context, off camera. */
export async function submitPublicForm(
  browser: Browser,
  address: string,
  answers: { name: string; email: string; phone?: string; moveIn?: string; home?: string },
): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(address);
    const form = page.getByTestId('form-renderer');
    await expect(form).toBeVisible();
    await form.getByLabel('Full name').fill(answers.name);
    await form.getByLabel('Email').fill(answers.email);
    if (answers.phone) await form.getByLabel('Phone number').fill(answers.phone);
    if (answers.moveIn) await form.getByLabel('Preferred move-in date').fill(answers.moveIn);
    if (answers.home) await form.getByLabel('Home type').selectOption(answers.home);
    await page.waitForTimeout(3500); // the page refuses a form filled in under three seconds (anti-bot check)
    await page.getByTestId('form-submit').click();
    await expect(page.getByTestId('form-done')).toBeVisible({ timeout: 60_000 });
  } finally {
    await context.close();
  }
}

import { type APIRequestContext, expect, test } from '@playwright/test';
import { pool, q } from '../support/db.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/roles-and-workflows.ts';
import { createProject, demoApi, pairWorkstation } from './seed.ts';

/**
 * The Roles & workflows video (sidebar section 12, the page titled "Organization"): the Roles tab, the Workflows tab
 * (view, compare), the workflow builder (add a step, save), Create department and Design with the BA.
 * Output: media/videos/roles-and-workflows.{webm,mp4,vtt,json}
 *   e2e/video/record.sh roles-and-workflows
 */
const SLUG = 'roles-and-workflows';

test.afterAll(async () => {
  await pool.end();
});

/** Approves the open desk approval whose title starts with `title` (a definition waits for the Owner). */
async function approve(api: APIRequestContext, title: string): Promise<void> {
  const item = (
    await q<{ id: string }>(`SELECT id FROM desk_items WHERE status='open' AND title LIKE $1`, [`${title}%`])
  )[0];
  expect(item, `desk item ${title}`).toBeTruthy();
  const r = await api.post(`/api/desk/${item?.id}/resolve`, { data: { resolution: 'approved' } });
  expect(r.ok(), await r.text()).toBe(true);
}

test('record the roles-and-workflows video', async ({ browser }) => {
  // ---- seed (demo data only): the default workflows, one custom workflow with its role, a BA ----------------------
  const api = await demoApi();
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Roles and workflows',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  await createProject(api, 'SHOP', 'Web shop');
  const workstationId = await pairWorkstation(api);
  const ba = await api.post('/api/agents', {
    data: {
      name: 'Bea',
      roleKey: 'ba',
      seniority: 'senior',
      runtime: 'mock',
      workstationId,
      allowedProjectIds: null,
    },
  });
  expect(ba.status(), await ba.text()).toBe(201);

  const dep = await api.post('/api/departments', { data: { name: 'marketing' } });
  expect(dep.ok(), await dep.text()).toBe(true);
  const role = await api.post('/api/roles', {
    data: {
      key: 'copywriter',
      name: 'Copywriter',
      purpose: 'Writes press notes and product texts.',
      department: 'marketing',
      instructions: 'Write the text the card asks for, in plain words, and report.',
      coreRules: ['Never publish anything yourself.'],
      seniorityLevels: ['junior', 'senior'],
      defaultModel: { runtime: 'mock', model: 'mock' },
      permissions: {
        allowedTools: ['read', 'edit'],
        deniedShellPatterns: [],
        writableGlobs: null,
        mayCommit: false,
        browser: false,
        riskTiers: ['small', 'large'],
        repoIds: null,
      },
      skills: [],
      claimableStages: [{ workflowKey: 'press_note', stageId: '*' }],
    },
  });
  expect(role.status(), await role.text()).toBe(201);
  const roleId = (await role.json()).id as string;
  const rs = await api.post(`/api/roles/${roleId}/submit`, { data: {} });
  expect(rs.ok(), await rs.text()).toBe(true);
  await approve(api, 'Approve role "Copywriter"');

  const outcome = (id: string, to: string, extra: Record<string, unknown> = {}) => ({
    id,
    label: id,
    kind: 'success',
    to,
    event: 'StageCompleted',
    ...extra,
  });
  const wf = await api.post('/api/workflows', {
    data: {
      key: 'press_note',
      name: 'Press note',
      department: 'marketing',
      fieldSet: 'custom',
      customFields: [{ key: 'topic', label: 'Topic', type: 'text', required: true }],
      cardTypes: ['docs'],
      initialStage: 'intake',
      stages: [
        {
          id: 'intake',
          label: 'Intake',
          column: 'Intake',
          kind: 'manual',
          claimRole: null,
          doneCriteria: '',
          outcomes: [outcome('ready', 'draft', { event: 'CardSpecified' })],
        },
        {
          id: 'draft',
          label: 'Draft',
          column: 'Draft',
          kind: 'agent',
          claimRole: 'copywriter',
          requiredFields: ['topic'],
          doneCriteria: 'The press note is written.',
          outcomes: [outcome('drafted', 'done')],
        },
        {
          id: 'done',
          label: 'Done',
          column: 'Done',
          kind: 'terminal',
          claimRole: null,
          doneCriteria: '',
          outcomes: [],
        },
      ],
    },
  });
  expect(wf.status(), await wf.text()).toBe(201);
  const wfId = (await wf.json()).id as string;
  const sub = await api.post(`/api/workflows/${wfId}/submit`, { data: {} });
  expect(sub.ok(), await sub.text()).toBe(true);
  await approve(api, 'Approve workflow "Press note"');

  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through ----------------------------------------------------------------------------------------------
  const nav = page.locator('[data-tour="nav-org"]');
  await page.goto('/p/SHOP/board');
  await expect(nav).toBeVisible();
  await narrate('intro-1');

  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, nav);
    await expect(page.getByTestId('role-copywriter')).toBeVisible();
    await pause(1500);
  });
  await narrate('c1-b', async () => {
    const builtin = page.getByTestId('builtin-roles');
    await builtin.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await pause(1200);
    await page.getByRole('button', { name: 'Extend builder' }).hover();
  });

  await chapter(2);
  const code = page.getByTestId('workflow-code');
  await narrate('c2-a', async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await click(page, tab('Workflows'));
    await expect(code).toBeVisible();
    await click(page, code.getByRole('button', { name: /^View code v\d+$/ }).first());
    await expect(code.getByTestId('workflow-graph')).toBeVisible();
    await code
      .getByTestId('workflow-graph')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  });
  await narrate('c2-b', async () => {
    // hide the diagram again (the View button toggles), then open the newest version's changes
    await click(page, code.getByRole('button', { name: /^View code v\d+$/ }).first());
    await expect(code.getByTestId('workflow-graph')).toHaveCount(0);
    await click(page, code.getByRole('button', { name: /^Compare code v\d+ with previous$/ }).first());
    const diff = code.locator('[data-testid^="compare-code-"]').first();
    await expect(diff).toBeVisible();
    await diff.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(1500);
  });

  await chapter(3);
  const press = page.getByTestId('workflow-press_note');
  await narrate('c3-a', async () => {
    await press.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(800);
    await click(page, press.getByRole('link', { name: 'New version of press_note v1' }));
    await expect(page.getByTestId('workflow-builder-page')).toBeVisible();
  });
  await narrate('c3-b', async () => {
    await click(page, page.getByRole('button', { name: 'Add a step after Draft' }));
    const step = page.getByRole('region', { name: 'New step', exact: true });
    const nameBox = step.getByLabel('Step name');
    await click(page, nameBox, 150);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Proofread', { delay: 70 }); // the step (and its region) is renamed as you type
    await pause(400);
    const proof = page.getByRole('region', { name: 'Proofread', exact: true });
    await proof.getByLabel('Who does it').selectOption('copywriter');
    await pause(800);
    await click(page, page.getByRole('button', { name: 'Save draft' }));
    await expect(page.getByTestId('builder-status')).toContainText('Draft');
  });
  await narrate('c3-c', async () => {
    await click(page, page.getByRole('link', { name: 'Back to workflows' }));
    await expect(press.getByTestId('version-2')).toBeVisible();
    await press.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await click(page, press.getByRole('button', { name: 'Compare press_note v2 with previous' }));
    await expect(press.getByTestId('compare-press_note-v2')).toBeVisible();
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await click(page, tab('Departments'));
    await type(page, page.getByRole('textbox', { name: 'New department' }), 'Support');
    await click(page, page.getByRole('button', { name: 'Create department' }));
    await expect(page.getByTestId('department-Support')).toBeVisible();
  });

  await chapter(5);
  await narrate('c5-a', async () => {
    await click(page, tab('Design with the BA'));
    await pause(800);
    await click(page, page.getByRole('button', { name: 'Start a design chat' }));
    await expect(page.getByTestId('design-chat')).toBeVisible();
  });
  await narrate('outro-1');

  await finish();
});

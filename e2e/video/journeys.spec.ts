import { expect, test } from '@playwright/test';
import { pool, q, waitFor } from '../support/db.ts';
import { saveJourneyInDesigner } from '../support/ui.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/journeys.ts';
import { addLocalStorage, createProject, createRentalForm, demoApi, pairWorkstation } from './seed.ts';

/**
 * The Journeys video (sidebar section 31): the list, New journey from the Rentals template, steps and handoffs, a wait for a
 * form and a gate, the Webhooks panel, and an instance waiting for documents (history, waits panel, references).
 * Output: media/videos/journeys.{webm,mp4,vtt,json}
 *   e2e/video/record.sh journeys
 */
const SLUG = 'journeys';

test.afterAll(async () => {
  await pool.end();
});

test('record the journeys video', async ({ browser }) => {
  // ---- seed (demo data only): storage, a published form, a "Tenant rentals" journey and one tenant waiting for documents ----
  const api = await demoApi();
  const { projectId } = await createProject(api, 'LET', 'Lettings', { repo: false });
  const workstationId = await pairWorkstation(api);
  const storageId = await addLocalStorage(browser, api, workstationId, 'Client documents');
  const form = await createRentalForm(api, storageId);
  const workflowKey = (
    await q<{ workflow_key: string }>(
      'SELECT workflow_key FROM project_workflows WHERE project_id=$1 AND is_primary',
      [projectId],
    )
  )[0]?.workflow_key as string;
  expect(workflowKey).toBeTruthy();
  const wf = (id: string, label: string) => ({ kind: 'workflow', id, label, workflowKey });
  const order = ['lead', 'viewing', 'application', 'wait_documents', 'approval', 'lease_signed'];
  const created = await api.post('/api/journeys', {
    data: {
      projectId,
      definition: {
        name: 'Tenant rentals',
        description: 'From first enquiry to a signed lease.',
        recordType: 'client',
        firstStepId: 'lead',
        steps: [
          wf('lead', 'Lead'),
          wf('viewing', 'Viewing'),
          wf('application', 'Application'),
          {
            kind: 'wait',
            id: 'wait_documents',
            label: 'Wait for forms and documents',
            waitFor: { kind: 'form', formId: form.formId, purpose: 'upload', send: { via: 'desk' } },
            duration: { amount: 5, unit: 'days' },
            onTimeout: { action: 'remind', maxReminders: 2, afterLast: 'escalate' },
          },
          {
            kind: 'gate',
            id: 'approval',
            label: 'Approval',
            approver: { kind: 'project_owner' },
            question: 'Approve this application?',
          },
          wf('lease_signed', 'Lease signed'),
        ],
        handoffs: order
          .slice(0, -1)
          .map((from, i) => ({ id: `h${i + 1}`, from, on: 'done', to: order[i + 1] })),
      },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const journeyId = (await created.json()).id as string;
  const started = await api.post('/api/journey-instances', {
    data: { journeyId, record: { type: 'client', displayName: 'Unit 4B, Demo Tenant', externalId: 'T-4B' } },
  });
  expect(started.status(), await started.text()).toBe(201);
  const instanceId = (await started.json()).id as string;
  const tick = async () => {
    const r = await api.post('/api/test/clock', { data: { advanceMs: 0 } });
    expect(r.ok(), await r.text()).toBeTruthy();
  };
  type Inst = {
    status: string;
    currentStepId: string;
    currentVisit: number;
    record: { id: string };
    history: Array<{ visit: number; stepId: string; status: string; cardId: string | null }>;
  };
  const get = async (): Promise<Inst> => (await api.get(`/api/journey-instances/${instanceId}`)).json();
  // the step cards stay drafts, so each is ended in the database; the journey sweep reads the card state
  for (const step of ['lead', 'viewing', 'application']) {
    const at = await waitFor(
      `the instance reached ${step}`,
      async () => {
        await tick();
        return get();
      },
      (v) => v.currentStepId === step && v.history.find((h) => h.visit === v.currentVisit)?.status === 'open',
      60_000,
    );
    const cardId = at.history.find((h) => h.visit === at.currentVisit)?.cardId as string;
    await q("UPDATE cards SET status='done' WHERE id=$1", [cardId]);
  }
  const waiting = await waitFor(
    'the instance waits for documents',
    async () => {
      await tick();
      return get();
    },
    (v) =>
      v.currentStepId === 'wait_documents' &&
      v.history.find((h) => h.visit === v.currentVisit)?.status === 'waiting',
    60_000,
  );
  const ref = await api.post(`/api/journey-records/${waiting.record.id}/references`, {
    data: { kind: 'form_submission', ref: `form:${form.formId}`, label: 'Rental application' },
  });
  expect(ref.ok(), await ref.text()).toBeTruthy();

  // ---- voice and camera ----------------------------------------------------------------------------------------------
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Journeys: design a journey',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const nav = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Journeys' });

  await page.goto('/desk');
  await expect(nav).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, nav);
    await expect(
      page.getByTestId('journey-list').getByRole('link', { name: 'Tenant rentals' }),
    ).toBeVisible();
    await pause(1800);
  });
  await narrate('c1-b', async () => {
    await click(page, page.getByRole('button', { name: 'New journey' }));
    const dialog = page.getByRole('dialog', { name: 'New journey' });
    await expect(dialog.getByText('Rentals: lead to monthly rent')).toBeVisible();
    await pause(1500);
    await click(page, dialog.getByRole('button', { name: 'Use this template' }));
    await expect(page).toHaveURL(/\/journeys\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('journey-steps')).toBeVisible();
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    const steps = page.getByTestId('journey-steps');
    await expect(steps.locator(':scope > li')).toHaveCount(10);
    await pause(1500);
    await steps.getByTestId('step-application').scrollIntoViewIfNeeded();
    await pause(1500);
  });
  await narrate('c2-b', async () => {
    const step = page.getByTestId('step-application');
    await step.scrollIntoViewIfNeeded();
    const handoff = step.locator('[data-testid^="handoff-"]').first();
    await expect(handoff).toBeVisible();
    await handoff.hover();
    await pause(2500);
  });

  await chapter(3);
  const wait = page.getByTestId('wait-settings-wait_documents');
  await narrate('c3-a', async () => {
    await wait.scrollIntoViewIfNeeded();
    await pause(800);
    await wait.getByLabel('Form to send').selectOption({ label: 'Rental application' });
    await pause(1200);
    await wait.getByLabel('Wait at most').hover();
    await pause(1500);
    await wait.getByLabel('When time runs out').hover();
    await pause(1500);
  });
  await narrate('c3-b', async () => {
    const gate = page.getByTestId('gate-settings-approval');
    await gate.scrollIntoViewIfNeeded();
    await gate.getByLabel('Who decides', { exact: true }).hover();
    await pause(2500);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    const hooks = page.getByRole('heading', { name: 'Webhooks' });
    await hooks.scrollIntoViewIfNeeded();
    await type(page, page.getByLabel('Name', { exact: true }).last(), 'Website enquiry', 70);
    await page.getByLabel('What it does').selectOption('start');
    await pause(700);
    await type(
      page,
      page.getByLabel('Where the record id is in the message (for example /client/id)'),
      '/client/id',
      70,
    );
    await type(page, page.getByLabel('Where the name is (optional)'), '/client/name', 70);
    await pause(500);
  });
  await narrate('c4-b', async () => {
    await click(page, page.getByRole('button', { name: 'Add a webhook', exact: true }));
    await expect(page.getByTestId('hook-secret')).toBeVisible();
    await pause(2500);
    await page.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded();
    await saveJourneyInDesigner(page, () =>
      click(page, page.getByRole('button', { name: 'Save', exact: true })),
    );
    await pause(800);
  });

  await chapter(5);
  await narrate('c5-a', async () => {
    await click(page, nav);
    await click(page, page.getByRole('tab', { name: 'Running' }));
    const link = page.getByTestId('instance-list').getByRole('link', { name: /Unit 4B, Demo Tenant/ });
    await expect(link).toBeVisible();
    await pause(1200);
    await click(page, link);
    await expect(page.getByRole('heading', { name: 'Unit 4B, Demo Tenant' })).toBeVisible();
    await expect(page.getByTestId('journey-history')).toBeVisible();
    await pause(1500);
  });
  await narrate('c5-b', async () => {
    const waits = page.getByTestId('instance-waits');
    await waits.scrollIntoViewIfNeeded();
    await expect(waits.getByTestId('wait-deadline')).toBeVisible();
    await pause(2500);
    await page.getByText('References', { exact: true }).scrollIntoViewIfNeeded();
    await pause(2000);
  });
  await narrate('outro-1');

  await finish();
});

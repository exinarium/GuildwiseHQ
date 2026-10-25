import { expect, test } from '@playwright/test';
import { pool, waitFor } from '../support/db.ts';
import { click } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/documents.ts';
import { createProject, demoApi, pairWorkstation } from './seed.ts';

/**
 * The Documents video: the list with its kind and status filters, reading a PRD and an earlier version, approving it.
 * Output: media/videos/documents.{webm,mp4,vtt,json}
 *   e2e/video/record.sh documents
 */
const SLUG = 'documents';

test.afterAll(async () => {
  await pool.end();
});

const BRIEF = `# Product brief: Gift wrapping

## Problem
Customers buy presents and ask for wrapping, but the shop cannot offer it.

## Goal
Offer gift wrapping at checkout for a small fee.

## Not in scope
Personalised cards and international shipping.
`;
const PRD_V1 = `# PRD: Order confirmation email

## Summary
Send an order confirmation email after every order.

## Requirements
- R1. The email lists every item and the total.
`;
const PRD_V2 = `${PRD_V1}- R2. The email comes from orders@example.com.
- R3. The email links to the order status page.

## Open questions
- Should the email also be sent for returns?
`;
const MINUTES = `# Minutes: Launch a pilot with our first customer?

## Positions
- Optimist: a pilot teaches us more than another month of planning.
- Devil's Advocate: one customer is not a market.

## Decisions
- Prove demand first, with ten paying users.
`;

test('record the documents video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const api = await demoApi();
  const { projectId } = await createProject(api, 'SHOP', 'Web shop');
  await pairWorkstation(api, "Alex's laptop"); // the project vault the approved documents are copied to
  const make = async (kind: string, title: string, content: string) => {
    const r = await api.post('/api/documents', { data: { kind, title, content, projectId } });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()).document.id as string;
  };
  const status = async (id: string, s: string) => {
    const r = await api.post(`/api/documents/${id}/status`, { data: { status: s } });
    expect(r.ok(), await r.text()).toBe(true);
  };
  const brief = await make('brief', 'Product brief: Gift wrapping', BRIEF);
  await status(brief, 'in_review');
  await status(brief, 'approved');
  const prd = await make('prd', 'PRD: Order confirmation email', PRD_V1);
  const v2 = await api.post(`/api/documents/${prd}/versions`, {
    data: { content: PRD_V2, note: 'Added the sender and the status link', baseVersion: 1 },
  });
  expect(v2.status(), await v2.text()).toBe(201);
  await status(prd, 'in_review');
  await make('minutes', 'Minutes: Launch a pilot with our first customer?', MINUTES);

  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Documents',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const chip = (name: string) => page.getByRole('button', { name, exact: true });

  // ---- the walk-through: starts on the board, opens Documents from the sidebar ----------------------------------------
  await page.goto('/p/SHOP/board');
  await expect(page.getByTestId('nav-documents')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-documents'));
    await expect(page.getByTestId('document-row')).toHaveCount(3);
    await pause(1500);
  });
  await narrate('c1-b', async () => {
    await click(page, chip('PRD'));
    await expect(page.getByTestId('document-row')).toHaveCount(1);
    await pause(1200);
    await click(page, chip('PRD')); // off again
    await expect(page.getByTestId('document-row')).toHaveCount(3);
  });
  await narrate('c1-c', async () => {
    for (const s of ['Draft', 'In review', 'Approved']) {
      await click(page, chip(s));
      await pause(900);
    }
    await click(page, chip('Approved')); // off again
    await expect(page.getByTestId('document-row')).toHaveCount(3);
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await click(page, page.getByTestId('document-row').filter({ hasText: 'Order confirmation email' }));
    await expect(page.getByTestId('document-view')).toBeVisible();
    await pause(1500);
    await page.getByTestId('version-picker').selectOption('1');
    await pause(2200);
    await page.getByTestId('version-picker').selectOption('2');
    await pause(1000);
  });
  await narrate('c2-b', async () => {
    await click(page, page.getByRole('button', { name: 'Approve', exact: true }));
    await expect(page.getByTestId('document-status')).toHaveText('Approved');
    await waitFor(
      'the vault copy',
      async () => (await (await api.get(`/api/documents/${prd}`)).json()).document.vaultPath as string | null,
      (v) => !!v,
      60_000,
    ).catch(() => undefined);
    await pause(1500);
  });
  await narrate('c2-c', async () => {
    await click(page, page.getByRole('button', { name: 'Reopen', exact: true }));
    await expect(page.getByTestId('document-status')).toHaveText('Draft');
    await pause(1200);
  });
  await narrate('outro-1', async () => {
    await click(page, page.getByRole('link', { name: /All documents/ }));
    await expect(page.getByTestId('document-row')).toHaveCount(3);
  });

  await finish();
});

import { expect, test } from '@playwright/test';
import { pool } from '../support/db.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/ledger.ts';
import { createProject, demoApi } from './seed.ts';

/**
 * The Ledger video (sidebar section 19): search, the scope and Project filters, Add entry (a standing order), edit and
 * history, retire and Show retired.
 * Output: apps/web/public/videos/ledger.{webm,mp4,vtt,json}
 *   e2e/video/record.sh ledger
 */
const SLUG = 'ledger';

test.afterAll(async () => {
  await pool.end();
});

test('record the ledger video', async ({ browser }) => {
  // ---- seed (demo data only): twelve entries, one of them retired and one edited once --------------------------------
  const api = await demoApi();
  const { projectId: shop } = await createProject(api, 'SHOP', 'Web shop', { repo: false });
  const { projectId: blog } = await createProject(api, 'BLOG', 'Company blog', { repo: false });
  const add = async (scope: string, title: string, body: string, projectId?: string) => {
    const r = await api.post('/api/ledger', {
      data: { scope, title, body, tags: [], ...(projectId ? { projectId } : {}) },
    });
    expect([200, 201], `${title}: ${await r.text()}`).toContain(r.status());
    return (await r.json()).entry.id as string;
  };
  const english = await add(
    'standing_order',
    'Use British English in customer texts',
    'Write colour, centre and organise in everything a customer reads.',
  );
  await add(
    'standing_order',
    'Never store card numbers',
    'Payments go through the payment provider. No card number is written to our database or our logs.',
  );
  await add(
    'standing_order',
    'Ask before adding a paid service',
    'Any new service that costs money needs a yes from Alex Morgan first.',
  );
  await add(
    'standing_order',
    'Keep pages fast on a phone',
    'Every shop page loads in under two seconds on a mid-range phone.',
    shop,
  );
  const retired = await add(
    'standing_order',
    'Release only on Tuesdays',
    'New versions of the shop go live on Tuesday mornings only.',
    shop,
  );
  await add(
    'decision',
    'Only necessary cookies by default',
    'The cookie banner starts with only the necessary cookies switched on. Analytics waits for a yes.',
    shop,
  );
  await add('decision', 'Prices include VAT', 'Every price on the shop is shown including VAT.', shop);
  await add(
    'decision',
    'Free delivery from 50 euros',
    'Orders of 50 euros or more are delivered free of charge.',
    shop,
  );
  await add(
    'decision',
    'Comments are moderated',
    'A comment appears on the blog after someone has approved it.',
    blog,
  );
  await add(
    'feature',
    'Guest checkout',
    'A customer can order without creating an account. Email and address are enough.',
    shop,
  );
  await add(
    'feature',
    'Order confirmation within a minute',
    'The order confirmation email arrives within one minute of paying.',
    shop,
  );
  await add(
    'feature',
    'Reading time on articles',
    'Every article shows an estimated reading time under its title.',
    blog,
  );
  const edit = await api.patch(`/api/ledger/${english}`, {
    data: {
      title: 'Use British English in customer texts',
      body: 'Write colour, centre and organise in everything a customer reads, including emails.',
    },
  });
  expect(edit.ok(), await edit.text()).toBeTruthy();
  const ret = await api.post(`/api/ledger/${retired}/retire`, {
    data: { reason: 'The release settings decide when the shop goes live now.' },
  });
  expect(ret.ok(), await ret.text()).toBeTruthy();

  // ---- voice and camera ----------------------------------------------------------------------------------------------
  const prepared = prepareVideo({ slug: SLUG, title: 'The Ledger', cues: allCues(), chapters: CHAPTERS });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const entries = page.getByTestId('ledger-entry');

  await page.goto('/desk');
  await expect(page.getByTestId('nav-ledger')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-ledger'));
    await expect(entries).toHaveCount(11);
    await pause(600);
    await type(page, page.getByLabel('Search', { exact: true }), 'cookies');
    await expect(entries).toHaveCount(1);
    await pause(600);
  });
  await narrate('c1-b', async () => {
    await page.getByLabel('Search', { exact: true }).fill('');
    await expect(entries).toHaveCount(11);
    await click(page, page.getByRole('button', { name: 'Standing orders' }));
    await expect(entries).toHaveCount(4);
    await pause(900);
    await click(page, page.getByRole('button', { name: 'Decisions' }));
    await expect(entries).toHaveCount(4);
    await pause(700);
    await click(page, page.getByLabel('Project'), 200);
    await page.getByLabel('Project').selectOption({ label: 'BLOG' });
    await expect(entries).toHaveCount(1); // the decisions of the blog
    await pause(900);
    await page.getByLabel('Project').selectOption({ label: 'All projects' });
    await click(page, page.getByRole('button', { name: 'All', exact: true }));
    await expect(entries).toHaveCount(11);
  });

  await chapter(2);
  const form = page.getByRole('form', { name: 'Add to ledger' });
  await narrate('c2-a', async () => {
    await click(page, page.getByRole('button', { name: 'Add entry' }));
    await expect(form).toBeVisible();
    await pause(800);
    await click(page, form.getByLabel('Kind'), 200);
    await form.getByLabel('Kind').selectOption({ label: 'Standing order (every agent loads it)' });
    await pause(1500);
    await form.getByLabel('Project (blank = every project)').hover();
    await pause(1500);
  });
  await narrate('c2-b', async () => {
    await type(page, form.getByLabel('Title'), 'Reply within a day', 100);
    await type(page, form.getByLabel('Text'), 'Answer every customer email within one working day.', 150);
    await click(page, form.getByRole('button', { name: 'Add to ledger' }));
    await expect(form).toHaveCount(0);
    await expect(entries).toHaveCount(12);
  });

  await chapter(3);
  const askEntry = entries.filter({ hasText: 'Ask before adding a paid service' });
  await narrate('c3-a', async () => {
    await askEntry.scrollIntoViewIfNeeded();
    await click(page, page.getByRole('button', { name: 'Edit Ask before adding a paid service' }));
    const editForm = page.getByRole('form', { name: 'Edit standing order' });
    await click(page, editForm.getByLabel('Text'), 100);
    await page.keyboard.press('Control+End');
    await editForm
      .getByLabel('Text')
      .pressSequentially(' Tools under 20 euros a month are fine.', { delay: 60 });
    await pause(300);
    await click(page, editForm.getByRole('button', { name: 'Save changes' }));
    await expect(editForm).toHaveCount(0);
    await click(page, page.getByRole('button', { name: 'History of Ask before adding a paid service' }));
    await expect(askEntry.getByTestId('ledger-history')).toContainText('Version 1');
    await pause(1000);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    const free = entries.filter({ hasText: 'Free delivery from 50 euros' });
    await free.scrollIntoViewIfNeeded();
    await click(page, page.getByRole('button', { name: 'Retire Free delivery from 50 euros' }));
    const retireForm = page.getByRole('form', { name: 'Retire entry' });
    await type(page, retireForm.getByLabel('Reason'), 'The offer ended in September.', 150);
    await click(page, retireForm.getByRole('button', { name: 'Retire' }));
    await expect(entries.filter({ hasText: 'Free delivery from 50 euros' })).toHaveCount(0);
  });
  await narrate('c4-b', async () => {
    await page.evaluate('window.scrollTo(0, 0)');
    await click(page, page.getByRole('button', { name: 'Show retired' }));
    await expect(page.getByTestId('ledger-retired')).toHaveCount(2);
    await pause(600);
    await page.locator('[data-retired="true"]').first().scrollIntoViewIfNeeded();
    await pause(1200);
  });
  await narrate('outro-1', async () => {
    await page.evaluate('window.scrollTo({ top: 0, behavior: "smooth" })');
  });

  await finish();
});

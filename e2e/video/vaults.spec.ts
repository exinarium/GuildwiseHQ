import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { pool, waitFor } from '../support/db.ts';
import { paths } from '../support/env.ts';
import { makeVault, originHas, pushFromOther, writeVaultFile } from '../support/vault.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/vaults.ts';
import { createProject, demoApi, pairWorkstation } from './seed.ts';

/**
 * The Vaults video (sidebar section 20): the vault cards, Register a vault (a git repository for a project that has a
 * local folder), the sync interval and Edit, and a paused sync with "I resolved it, resume".
 * Output: media/videos/vaults.{webm,mp4,vtt,json}
 *   e2e/video/record.sh vaults
 */
const SLUG = 'vaults';
const HOME = paths.runnerHome('video');

test.afterAll(async () => {
  await pool.end();
});

interface Vault {
  id: string;
  kind: string;
  projectId: string | null;
  storage?: string;
  workstations: Array<{ paused: boolean; localPath: string | null }>;
}

test('record the vaults video', async ({ browser }) => {
  // ---- seed (demo data only): Acme and its Owner Alex Morgan exist already -----------------------------------------
  const api = await demoApi();
  const vaults = async () => (await (await api.get('/api/vaults')).json()).vaults as Vault[];
  await createProject(api, 'SHOP', 'Web shop', { repo: false });
  await createProject(api, 'BLOG', 'Company blog', { repo: false });
  // the organization vault: a throwaway bare repository on the stack's scratch directory
  const org = makeVault('acme-knowledge', {
    'README.md': '# Acme knowledge\n',
    'notes/opening-hours.md': '# Opening hours\n\nMonday to Friday, 9 to 5.\n',
  });
  const reg = await api.post('/api/vaults', {
    data: { kind: 'org', remoteUrl: org.origin, syncIntervalSec: 2 },
  });
  expect(reg.status(), await reg.text()).toBe(201);
  const orgId = (await vaults()).find((v) => v.kind === 'org')?.id as string;
  // the workstation clones the organization vault, and gets a local folder vault for each project
  await pairWorkstation(api, "Alex's laptop");
  await waitFor(
    'the organization vault is cloned and both projects have a local folder',
    vaults,
    (vs) =>
      !!vs.find((v) => v.kind === 'org')?.workstations[0]?.localPath &&
      vs.filter((v) => v.projectId && v.storage === 'local').length === 2,
    60_000,
  );
  // a conflict: the same file changed on the workstation and elsewhere
  const clone = join(HOME, 'vaults', orgId);
  writeVaultFile(clone, 'notes/opening-hours.md', '# Opening hours\n\nMonday to Friday, 9 to 6.\n');
  await waitFor(
    'the local edit reached the repository',
    async () =>
      originHas(org, 'notes/opening-hours.md') &&
      execFileSync('git', ['-C', org.origin, 'show', 'main:notes/opening-hours.md'], { encoding: 'utf8' }),
    (t) => typeof t === 'string' && t.includes('9 to 6'),
    30_000,
  );
  pushFromOther(org, 'notes/opening-hours.md', '# Opening hours\n\nMonday to Saturday, 9 to 5.\n');
  writeVaultFile(clone, 'notes/opening-hours.md', '# Opening hours\n\nMonday to Friday, 8 to 6.\n');
  await waitFor(
    'sync paused on a conflict',
    vaults,
    (vs) => vs.find((v) => v.kind === 'org')?.workstations[0]?.paused === true,
    60_000,
  );
  const shopRepo = makeVault('web-shop-notes', { 'README.md': '# Web shop notes\n' });

  // ---- voice and camera ----------------------------------------------------------------------------------------------
  const prepared = prepareVideo({ slug: SLUG, title: 'Vaults', cues: allCues(), chapters: CHAPTERS });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const orgCard = page.getByTestId('vault-org');
  const shopCard = page.getByTestId('vaults').getByRole('listitem').filter({ hasText: '(SHOP)' }).first();

  await page.goto('/desk');
  await expect(page.getByTestId('nav-vaults')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-vaults'));
    await expect(orgCard).toBeVisible();
    await pause(1500);
    await shopCard.scrollIntoViewIfNeeded();
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await expect(shopCard).toContainText('local folder');
    await shopCard.getByText('local folder').hover();
    await pause(1000);
  });
  const form = page.getByRole('form', { name: 'Register vault' });
  await narrate('c2-b', async () => {
    await page.evaluate('window.scrollTo(0, 0)');
    await click(page, page.getByRole('button', { name: 'Register a vault' }));
    await expect(form).toBeVisible();
    await form.getByLabel('Project').selectOption({ label: 'SHOP Web shop' });
    await type(page, form.getByLabel('Git URL'), shopRepo.origin, 100);
    await form.getByLabel('Sync interval (seconds)').fill('');
    await type(page, form.getByLabel('Sync interval (seconds)'), '60', 100);
    await click(page, form.getByRole('button', { name: 'Register vault' }));
    await expect(form).toHaveCount(0);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await expect(shopCard).not.toContainText('local folder');
    await shopCard.scrollIntoViewIfNeeded();
    await expect(shopCard).toContainText('every 60s');
    await pause(1500);
    await page.evaluate('window.scrollTo(0, 0)');
    await click(page, orgCard.getByRole('button', { name: /^Edit / }));
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Sync interval (s)').fill('');
    await type(page, dialog.getByLabel('Sync interval (s)'), '300', 200);
    await click(page, dialog.getByRole('button', { name: 'Save' }));
    await expect(orgCard).toContainText('every 300s');
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    const row = orgCard.getByTestId("vault-ws-Alex's laptop");
    await expect(row).toContainText('Sync paused: conflict');
    await row.getByText('Sync paused: conflict').hover();
    await pause(3000);
    // resolved in the clone (take the repository's side), off camera
    execFileSync('git', ['-C', clone, 'fetch', 'origin'], { stdio: 'ignore' });
    execFileSync('git', ['-C', clone, 'reset', '--hard', 'origin/main'], { stdio: 'ignore' });
    await click(page, row.getByRole('button', { name: "Resume sync on Alex's laptop" }));
    await expect(row).toHaveAttribute('data-paused', 'false');
  });
  await narrate('outro-1', async () => {
    await pause(1000);
  });

  await finish();
});

import { expect, type Locator, test } from '@playwright/test';
import { inviteAndAccept } from '../support/api.ts';
import { pool } from '../support/db.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/projects.ts';
import { createProject, demoApi } from './seed.ts';

/**
 * The Projects video (sidebar section 8): New project, the priority order, project settings and its jump chips, adding
 * a repository, the monthly budget and Send invitation.
 * Output: media/videos/projects.{webm,mp4,vtt,json}
 *   e2e/video/record.sh projects
 */
const SLUG = 'projects';

test.afterAll(async () => {
  await pool.end();
});

async function scrollTo(target: Locator, ms = 900): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await pause(ms);
}

test('record the projects video', async ({ browser }) => {
  // ---- seed (demo data only): three projects ------------------------------------------------------------------------
  const api = await demoApi();
  await createProject(api, 'SHOP', 'Web shop');
  await createProject(api, 'BLOG', 'Company blog', { repo: false });
  await createProject(api, 'APP', 'Mobile app', { repo: false });
  // the person invited to a project needs a Guildwise account of their own (here: their own organization)
  await inviteAndAccept(api, {
    email: 'guest@demo.local',
    name: 'Sam Lee',
    password: 'sam-lee-demo-password-1',
  });

  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Projects and their settings',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const sidebarProjects = page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' });

  // ---- the walk-through ----------------------------------------------------------------------------------------------
  await page.goto('/p/SHOP/board');
  await expect(sidebarProjects).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, sidebarProjects);
    await expect(page.getByTestId('project-rank-list')).toBeVisible();
  });
  await narrate('c1-b', async () => {
    await click(page, page.getByRole('button', { name: 'New project' }).first());
    const form = page.getByRole('form', { name: 'New project' });
    await type(page, form.getByLabel('Name'), 'Help centre');
    await expect(form.getByLabel('Key')).toHaveValue('HELP');
    await pause(1200);
    await click(page, form.getByRole('button', { name: 'Create project' }));
    await expect(page.getByTestId('rank-row-HELP')).toBeVisible();
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await pause(2500);
    await click(page, page.getByTestId('rank-up-HELP'));
    await pause(900);
    await click(page, page.getByTestId('rank-up-HELP'));
    await pause(900);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await click(page, page.getByTestId('rank-row-HELP').getByRole('link', { name: 'Settings for HELP' }));
    await expect(page.getByRole('heading', { name: 'Help centre settings' })).toBeVisible();
    await pause(1500);
    await page.getByRole('navigation', { name: 'Settings sections' }).hover();
  });
  await narrate('c3-b', async () => {
    await click(
      page,
      page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('link', { name: 'Repos', exact: true }),
    );
    await pause(800);
    const form = page.getByRole('form', { name: 'Add repository' });
    await type(page, form.getByLabel('Remote URL'), 'https://example.com/acme/help-centre.git');
    await type(page, form.getByLabel('Repository name'), 'help-centre');
    await click(page, form.getByRole('button', { name: 'Add repository' }));
    await expect(page.getByTestId('repos')).toContainText('example.com/acme/help-centre');
    await scrollTo(page.getByTestId('repos'), 800);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await click(
      page,
      page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('link', { name: 'Budget', exact: true }),
    );
    await pause(600);
    await type(page, page.getByTestId('budget-input'), '200');
    await click(page, page.getByTestId('budget-save'));
    await expect(page.getByTestId('budget-clear')).toBeVisible();
    await pause(800);
  });
  await narrate('c4-b', async () => {
    await click(
      page,
      page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('link', { name: 'Team', exact: true }),
    );
    await pause(600);
    const form = page.getByRole('form', { name: 'Invite member' });
    await type(page, form.getByLabel('Invite by email'), 'guest@demo.local');
    await click(page, form.getByRole('button', { name: 'Send invitation' }));
    await expect(page.getByTestId('member-guest@demo.local')).toBeVisible();
    await scrollTo(page.getByTestId('members'), 1200);
  });
  await narrate('outro-1', async () => {
    await click(page, sidebarProjects);
    await expect(page.getByTestId('rank-row-HELP')).toBeVisible();
  });

  await finish();
});

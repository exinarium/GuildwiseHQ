import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { pool, waitFor } from '../support/db.ts';
import { E2E_DIR, paths } from '../support/env.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/capabilities.ts';
import { createCard, createProject, demoApi, hireAgent, pairWorkstation } from './seed.ts';

/**
 * The Capabilities video: the registry and its filters, the starter gallery, a git pack (added, reviewed, approved), a
 * private pack written in the editor, the project skills review and the skill grants.
 * The pack is a local git repository that the recorded runner's git config maps from a public https URL
 * (AOM_PACKS_ALLOW_LOCAL=1 lets the runner fetch it); no network is used.
 * Output: media/videos/capabilities.{webm,mp4,vtt,json}
 *   e2e/video/record.sh capabilities
 */
const SLUG = 'capabilities';
const PACK_URL = 'https://github.com/acme/release-skills.git';

test.afterAll(async () => {
  await pool.end();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Alex Morgan',
      GIT_AUTHOR_EMAIL: 'alex.morgan@demo.local',
      GIT_COMMITTER_NAME: 'Alex Morgan',
      GIT_COMMITTER_EMAIL: 'alex.morgan@demo.local',
    },
  }).trim();

function writeTree(root: string, tree: Record<string, string>) {
  for (const [p, text] of Object.entries(tree)) {
    const abs = join(root, p);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
}

const SKILL = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

test('record the capabilities video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Capabilities and packs',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const api = await demoApi();
  // a git pack in the Agent Skills format: a skill with a script, two personas and a playbook
  const scratch = mkdtempSync(join(E2E_DIR, 'capvideo-'));
  const bare = join(scratch, 'release-skills.git');
  const work = join(scratch, 'work');
  mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', bare);
  writeTree(work, {
    'README.md': '# Release skills\n\nHelpers for shipping a release.\n',
    'pack.yaml': `agents:
  - file: agents/release-manager.md
    name: Rita
    title: Release manager
    icon: "🚀"
  - file: agents/support-triage.md
    name: Sam
    title: Support triage
    icon: "🎧"
playbooks:
  - dir: playbooks/release-day
`,
    'agents/release-manager.md': SKILL(
      'release-manager',
      'Plans a release and chases what is still open. Use when the user asks to talk to Rita',
      'You are Rita, the release manager. You list what is left, who owns it and what could block the release.',
    ),
    'agents/support-triage.md': SKILL(
      'support-triage',
      'Sorts incoming support requests by urgency. Use when the user asks to talk to Sam',
      'You are Sam. You read each request, name the product area and say how urgent it is.',
    ),
    'skills/write-changelog/SKILL.md': SKILL(
      'write-changelog',
      'Writes a customer-friendly changelog from merged pull requests',
      '# Write a changelog\n\nGroup the changes under Added, Changed and Fixed. Use plain words and one line each.',
    ),
    'skills/write-changelog/scripts/format.sh':
      '#!/bin/sh\n# turns a list of titles into a markdown list\nsed "s/^/- /"\n',
    'playbooks/release-day/workflow.md': SKILL(
      'release-day',
      'A checklist for the day a release goes out',
      '# Release day\n\nWalk through the checklist one item at a time and note what is done.',
    ),
  });
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'Release skills');
  git(work, 'tag', 'v1.0.0');
  git(work, 'push', '-q', 'origin', 'main', '--tags');
  // the runner clones packs in an isolated git environment, so a `git` wrapper first on its PATH maps the public URL to the
  // local repository (nothing leaves the machine; the pack text is the only thing fetched)
  const bin = join(scratch, 'bin');
  mkdirSync(bin, { recursive: true });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nexec "${realGit}" -c "url.file://${bare}.insteadOf=${PACK_URL}" "$@"\n`,
    { mode: 0o755 },
  );
  // a skill that lives in the project repository (the review under Project skills)
  const clone = join(scratch, 'toy');
  execFileSync('git', ['clone', '-q', paths.origin, clone]);
  writeTree(clone, {
    '.claude/skills/release-checklist/SKILL.md': SKILL(
      'release-checklist',
      'The steps our web shop follows before every release',
      '# Release checklist\n\n1. Run the tests.\n2. Check the order flow by hand.\n3. Tag the release.',
    ),
  });
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'Add the release checklist skill');
  git(clone, 'push', '-q', 'origin', 'HEAD:main');

  const ws = await pairWorkstation(api, "Alex's laptop", undefined, {
    PATH: `${bin}:${process.env.PATH}`,
    AOM_PACKS_ALLOW_LOCAL: '1',
  });
  const { projectId, repoId } = await createProject(api, 'SHOP', 'Web shop');
  for (const [name, roleKey, seniority] of [
    ['Arno', 'architect', 'senior'],
    ['Max', 'builder', 'senior'],
    ['Bea', 'ba', 'senior'],
  ] as const)
    await hireAgent(api, { name, roleKey, seniority, workstationId: ws, projectId });
  // a card's first shift makes the runner read the project's own skills, which then wait for a review
  await createCard(api, { projectId, repoId: repoId as string, title: 'Show a welcome banner' });
  await waitFor(
    'the project skill is found',
    async () => (await (await api.get('/api/capabilities/project-skills')).json()).items as unknown[],
    (items) => items.length > 0,
    120_000,
  );

  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });

  await page.goto('/p/SHOP/board');
  await expect(page.getByTestId('board')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-capabilities'));
    await expect(page.getByTestId('registry-list')).toBeVisible();
    await pause(2500);
  });
  await narrate('c1-b', async () => {
    const reg = page.getByTestId('registry-tab');
    await type(page, reg.getByLabel('Search'), 'brief');
    await pause(1500);
    await reg.getByLabel('Search').fill('');
    await reg.getByLabel('Kind').selectOption('playbook');
    await pause(1500);
    await reg.getByLabel('Kind').selectOption('');
  });
  await narrate('c1-c', async () => {
    await click(page, tab('Starter gallery'));
    await expect(page.getByTestId('starter-gallery')).toBeVisible();
    await pause(3500);
  });

  await chapter(2);
  const dialog = page.getByRole('dialog');
  await narrate('c2-a', async () => {
    await click(page, tab('Packs'));
    await click(page, page.getByRole('button', { name: 'Add a pack by git URL' }));
    await type(page, dialog.getByLabel('Git URL'), PACK_URL);
    await type(page, dialog.getByLabel('Tag, branch or commit'), 'v1.0.0');
    await type(page, dialog.getByLabel('Name (optional)'), 'acme');
    await pause(800);
    await click(page, dialog.getByTestId('private-repo'));
    await pause(2000);
    await click(page, dialog.getByTestId('private-repo'));
    await click(page, dialog.getByRole('button', { name: 'Add pack' }));
    await expect(dialog).toBeHidden();
  });
  await narrate('c2-b', async () => {
    const pack = page.getByTestId('pack-acme');
    await expect(pack.getByRole('button', { name: 'Review and approve' })).toBeVisible({ timeout: 90_000 });
    await click(page, pack.getByRole('button', { name: 'Review and approve' }));
    await expect(page.getByTestId('trust-review')).toBeVisible();
    await expect(page.getByTestId('review-has-scripts')).toBeVisible({ timeout: 30_000 });
    await pause(2500);
    await page.getByTestId('review-has-scripts').scrollIntoViewIfNeeded();
    await pause(2500);
  });
  await narrate('c2-c', async () => {
    const approve = page.getByRole('button', { name: 'Approve this exact commit and content' });
    await click(page, approve);
    const pack = page.getByTestId('pack-acme');
    await expect(pack.getByTestId('trusted')).toBeVisible({ timeout: 30_000 });
    await pack.getByTestId('hire-from-pack').scrollIntoViewIfNeeded();
    await pause(3500);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await click(page, tab('My capabilities'));
    await click(page, page.getByTestId('new-pack'));
    await type(page, dialog.getByLabel('Name', { exact: true }), 'helpers');
    await type(page, dialog.getByLabel('Description (optional)'), 'Small helpers for my own work');
    await pause(1500);
    await click(page, dialog.getByRole('button', { name: 'Create pack' }));
  });
  await narrate('c3-b', async () => {
    await click(page, page.getByTestId('edit-pack'));
    await expect(page.getByTestId('pack-editor')).toBeVisible({ timeout: 30_000 });
    await click(page, page.getByTestId('add-skill'));
    await type(page, page.getByLabel('Key of the new skill'), 'polite-replies');
    await click(page, page.getByRole('button', { name: 'Add', exact: true }));
    await expect(page.getByTestId('editor-blocked')).toBeVisible();
    await pause(1500);
    await type(page, page.getByLabel('Description'), 'Rewrites a reply so it is short and friendly');
    await type(
      page,
      page.getByLabel('Instructions (SKILL.md)'),
      'Keep it under four sentences. Thank the person first.',
    );
    await expect(page.getByTestId('editor-blocked')).toBeHidden();
    await click(page, page.getByTestId('save-pack'));
    await expect(page.getByTestId('pack-state')).toContainText('private to my workstation', {
      timeout: 60_000,
    });
    await pause(1500);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await click(page, tab('Project skills'));
    await expect(page.getByTestId('project-skill').first()).toBeVisible({ timeout: 60_000 });
    await pause(3500);
  });
  await narrate('c4-b', async () => {
    await click(page, tab('Skill grants'));
    await expect(page.getByTestId('grants')).toBeVisible();
    await pause(3500);
  });
  await narrate('outro-1', async () => {
    await click(page, tab('Registry'));
    await waitFor(
      'registry',
      async () => true,
      (x) => x,
      1000,
    );
  });

  await finish();
});

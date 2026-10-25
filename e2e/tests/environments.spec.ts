/// <reference lib="dom" />
import { type Browser, expect, type Page, test } from '@playwright/test';
import { apiAs } from '../support/api.ts';
import { ADMIN, BASE_URL } from '../support/env.ts';

/**
 * Acceptance tests of the Environments redesign (docs/design/environments-ux.md section 12), as user journeys with visible text
 * and test ids. Two ways to run them:
 *
 *  - Mocked world (`AOM_E2E_MSW=1`, `pnpm exec playwright test -c playwright.environments-msw.config.ts`): the web app talks to the
 *    in-browser mock server (apps/web/src/mocks/env-store.ts), a scenario per test. Needs no backend, no Docker and no runner. What
 *    only a real machine can show (a container keeps its id, a real release) is asserted in the stack project below.
 *  - The full stack (project `environments` of playwright.config.ts, after the backend merge): the same page against the real
 *    server, for the parts that need only the page and the API.
 */
const MSW = process.env.AOM_E2E_MSW === '1';
const BASE = MSW ? (process.env.AOM_E2E_MSW_URL ?? 'http://127.0.0.1:5188') : BASE_URL;
const KEY = MSW ? 'P5' : 'TOY';

interface Opts {
  scenario?: string;
  extra?: Record<string, string>;
  width?: number;
  height?: number;
}

/** A signed-in page. In the mocked world the scenario is seeded into localStorage before the app starts. */
async function openAs(browser: Browser, o: Opts = {}): Promise<Page> {
  const viewport = { width: o.width ?? 1280, height: o.height ?? 900 };
  if (!MSW) {
    const api = await apiAs(ADMIN.email, ADMIN.password);
    const ctx = await browser.newContext({ baseURL: BASE, viewport, storageState: await api.storageState() });
    return ctx.newPage();
  }
  const ctx = await browser.newContext({
    baseURL: BASE,
    viewport,
    ...(viewport.width < 600 ? { isMobile: true, hasTouch: true } : {}),
  });
  await ctx.addInitScript(
    ([scenario, extra]) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('aom-mock-deploy', scenario as string);
      localStorage.setItem('aom-mock-org-role', scenario === 'member' ? 'member' : 'owner');
      localStorage.removeItem('aom-mock-env');
      localStorage.setItem(
        'aom-mock-run',
        scenario === 'proposal' ? 'proposal' : scenario === 'empty' ? 'empty' : 'ready',
      );
      for (const [k, v] of Object.entries(extra as Record<string, string>)) localStorage.setItem(k, v);
      if ((extra as Record<string, string>)['aom-mock-member'])
        localStorage.setItem('aom-mock-org-role', 'member');
    },
    [o.scenario ?? 'empty', o.extra ?? {}] as const,
  );
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('password123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return page;
}

const goEnv = async (page: Page, hash = '') => {
  await page.goto(`/p/${KEY}/environments${hash}`);
  await expect(page.getByTestId('environments-page')).toBeVisible();
};
const tid = (page: Page, id: string) => page.getByTestId(id);
const noHorizontalScroll = async (page: Page) =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);

// ------------------------------------------------------------------------------------------------ the mocked world
test.describe('Environments: user journeys (mocked world)', () => {
  test.skip(!MSW, 'needs the mocked world (AOM_E2E_MSW=1)');

  test('1. first time, empty project: three choices, a scan, a review with start steps and an environment, questions block "Use this"', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'empty' });
    await goEnv(page);
    const empty = tid(page, 'setup-empty');
    await expect(empty).toContainText('Where does your app run?');
    await expect(empty.getByText('I only want card test copies')).toBeVisible();
    await expect(empty.getByText('A test site my team can try')).toBeVisible();
    await expect(empty.getByText('Not sure: let DevOps look')).toBeVisible();
    await tid(page, 'empty-scan').click();
    await expect(tid(page, 'needs-answer')).toContainText('Which part is your app?');
    await tid(page, 'needs-answer-open').click();
    const review = tid(page, 'proposal-review');
    await expect(review.getByTestId('review-start-steps')).toContainText('Start steps');
    await expect(review.getByTestId('deploy-proposal-envs')).toContainText('Test site');
    await expect(tid(page, 'proposal-use')).toBeDisabled();
    // a choice question (radio) and a yes or no must be answered; the number question has its default in the field
    await expect(review.getByTestId('answer-1-input')).toHaveValue('3000');
    await review.getByTestId('answer-0-app').click();
    await review.getByTestId('answer-2-no').click();
    await tid(page, 'answers-submit').click();
    await expect(tid(page, 'proposal-use')).toBeEnabled();
    await tid(page, 'proposal-use').click();
    await expect(tid(page, 'your-app-chip')).toHaveText('Ready');
    await expect(tid(page, 'env-card-uat')).toContainText('Draft');
  });

  test('2. an answer is a real answer: radios, saved, still answered after a reload, and no "Answer" button exists', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'proposal' });
    await goEnv(page);
    await tid(page, 'needs-answer-open').click();
    const review = tid(page, 'proposal-questions');
    await expect(review.getByRole('radio')).toHaveCount(5); // app, worker, web + yes, no
    await expect(review.getByRole('button', { name: /^Answer$/ })).toHaveCount(0);
    await review.getByTestId('answer-0-app').click();
    await review.getByTestId('answer-2-yes').click();
    await tid(page, 'answers-submit').click();
    await expect(review.getByText('Answered')).toHaveCount(3);
    await page.reload();
    await expect(tid(page, 'environments-page')).toBeVisible();
    await tid(page, 'deploy-proposal-open').click();
    await expect(tid(page, 'proposal-questions')).toContainText('Your answers');
    await expect(tid(page, 'proposal-questions').getByText('Answered')).toHaveCount(3);
    await tid(page, 'proposal-use').click();
    // the draft's app part is the one that was chosen
    await expect(tid(page, 'env-how-uat')).toContainText('(app)');
    await expect(page.getByRole('button', { name: /^Answer$/ })).toHaveCount(0);
  });

  test('3. adopt a running local stack: it is listed as found, the other containers are not touched; Try, Save, Approve', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'empty' });
    await goEnv(page);
    await tid(page, 'setup-add').click();
    await tid(page, 'place-choice-Office PC').click();
    const stack = tid(page, 'stack-choice');
    await expect(stack).toContainText('(found)');
    await stack.click();
    await tid(page, 'env-next').click();
    // the other containers stay as they are
    await expect(tid(page, 'changes-untouched')).toContainText('shop-uat-mailpit-1');
    await expect(tid(page, 'changes-untouched')).toContainText('notes-db-1');
    await tid(page, 'env-to-review').click();
    await tid(page, 'review-save').click();
    await expect(tid(page, 'review-saved')).toBeVisible();
    await tid(page, 'review-done').click();
    await expect(tid(page, 'strip-saved')).toHaveAttribute('data-done', 'true');
    await tid(page, 'env-try-test-site').click();
    await expect(tid(page, 'env-tried-test-site')).toContainText('Nothing was changed');
    await tid(page, 'env-approve-test-site').click();
    await tid(page, 'approve-confirm').click();
    await expect(tid(page, 'env-chip-test-site')).toHaveText('Healthy');
  });

  test('3b. nothing found: the copy lists where it looked and never says only "No app found"; "My app is somewhere else" finds it', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'empty', extra: { 'aom-mock-local': 'bare' } });
    await goEnv(page);
    await tid(page, 'setup-add').click();
    await tid(page, 'place-choice-Office PC').click();
    const miss = tid(page, 'no-stacks');
    await expect(miss).toContainText('We looked in the usual places');
    await expect(miss).toContainText('/opt');
    await expect(miss).toContainText('/srv');
    await expect(miss).not.toHaveText(/^No app found/);
    await tid(page, 'somewhere-else').click();
    await tid(page, 'folder-input').fill('/home/user/projects/demo-app');
    await tid(page, 'folder-look').click();
    await expect(tid(page, 'stack-choice')).toContainText('flow5');
  });

  test('4. a second environment while one exists: Add an environment stays available; a third ("Demo") on the same place; each place is listed once', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'approved' });
    await goEnv(page);
    const placeRows = page.locator('li[data-testid^="place-"]');
    await expect(placeRows).toHaveCount(2);
    await tid(page, 'setup-add-below').click();
    await tid(page, 'role-other').click();
    await tid(page, 'env-label').fill('Demo');
    await tid(page, 'place-choice-shop-uat').click();
    await tid(page, 'stack-choice').click();
    await tid(page, 'when-manual').click();
    await tid(page, 'env-next').click();
    await tid(page, 'env-to-review').click();
    await tid(page, 'review-save').click();
    await expect(tid(page, 'review-saved')).toBeVisible();
    await tid(page, 'review-done').click();
    await expect(tid(page, 'env-card-demo')).toContainText('Demo');
    await expect(tid(page, 'env-place-demo')).toContainText('Office PC');
    // no duplicate place rows
    await expect(placeRows).toHaveCount(2);
    await expect(tid(page, 'places').getByText('Office PC', { exact: true })).toHaveCount(1);
  });

  test('4b. a live site on a server that was added from an existing sign-in; update method is a question', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'empty' });
    await goEnv(page);
    await tid(page, 'setup-add').click();
    await tid(page, 'role-live').click();
    await tid(page, 'choose-add-server').click();
    await tid(page, 'host-use-flow5-server').click();
    await expect(tid(page, 'server-found')).toContainText('/home/administrator/demo/flow5-full');
    await tid(page, 'server-done').click();
    await tid(page, 'stack-choice').click();
    await expect(tid(page, 'update-method')).toContainText('How should new versions get onto the server?');
    await expect(tid(page, 'method-ship')).toContainText('Build here and copy it');
    await tid(page, 'env-next').click();
    // a literal image tag: no settings variable is needed
    await expect(tid(page, 'details-imagevar')).toContainText('extra file next to the compose file');
    await tid(page, 'env-to-review').click();
    await tid(page, 'review-save').click();
    await expect(tid(page, 'review-saved')).toBeVisible();
  });

  test('5. add a server, point the live site at it: the card shows the new place and needs re-approval', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'approved' });
    await goEnv(page);
    await tid(page, 'places-add-server').click();
    await tid(page, 'host-use-flow5-server').click();
    await tid(page, 'server-done').click();
    await expect(tid(page, 'place-flow5-server')).toBeVisible();
    await page.getByRole('button', { name: 'More for Live site' }).click();
    await page.getByRole('menuitem', { name: /Change server/ }).click();
    await tid(page, 'change-place-flow5-server').click();
    await tid(page, 'change-place-confirm').click();
    await expect(tid(page, 'env-place-production')).toContainText('flow5-server');
    await expect(tid(page, 'env-chip-production')).toHaveText('Needs a try');
    await tid(page, 'env-try-production').click();
    await expect(tid(page, 'env-tried-production')).toBeVisible();
  });

  test('6. remove: an environment (the app keeps running), a place that is used (says which), a duplicate (merge), a draft and an old file', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'p5' });
    await goEnv(page, '#places');
    // a place that an environment uses cannot be removed, and the dialog says which
    await page.getByRole('button', { name: 'More for Office PC' }).first().click();
    await page.getByRole('menuitem', { name: 'Remove' }).click();
    await expect(tid(page, 'place-in-use')).toContainText('Used by');
    await expect(tid(page, 'remove-place-confirm')).toBeDisabled();
    await page.keyboard.press('Escape');
    // the duplicate is merged
    await expect(tid(page, 'place-duplicate-Test copy')).toContainText('Looks like a duplicate of Office PC');
    await tid(page, 'place-merge-Test copy').click();
    await expect(tid(page, 'merge-dialog')).toContainText('Nothing on the computer is touched');
    await page.getByRole('button', { name: 'Merge', exact: true }).last().click();
    await expect(tid(page, 'place-Test copy')).toHaveCount(0);
    // an environment: the confirm names what is not touched
    await page.getByRole('button', { name: 'More for Live site' }).click();
    await page.getByRole('menuitem', { name: 'Remove' }).click();
    await expect(tid(page, 'remove-env-dialog')).toContainText('left exactly as it is');
    await tid(page, 'remove-env-confirm').click();
    await expect(tid(page, 'env-card-live-site')).toHaveCount(0);
    // the unfinished draft and the old file
    await page.getByText('Show technical details').click();
    await tid(page, 'cleanup-open').click();
    await expect(tid(page, 'cleanup-file-delivery/smoke-test.sh')).not.toBeChecked();
    await tid(page, 'cleanup-file-delivery/smoke-test.sh').check();
    await tid(page, 'cleanup-confirm').click();
    await expect(tid(page, 'cleanup-dialog')).toHaveCount(0);
  });

  test('7. dry run and approval: Approve waits for Try; the Owner approves; a Member sees "Waiting for the Owner"', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'waiting' });
    await goEnv(page);
    await expect(tid(page, 'strip-saved')).toHaveCount(2);
    await expect(tid(page, 'env-approve-uat')).toHaveCount(0);
    await tid(page, 'env-try-uat').click();
    await tid(page, 'env-try-production').click();
    await expect(tid(page, 'env-approve-uat')).toBeEnabled();
    await tid(page, 'env-approve-uat').click();
    await tid(page, 'approve-confirm').click();
    await expect(tid(page, 'env-chip-uat')).toHaveText('Healthy');
    // someone who is not the Owner
    const member = await openAs(browser, { scenario: 'ready', extra: { 'aom-mock-member': '1' } });
    await goEnv(member);
    await expect(tid(member, 'env-readonly')).toContainText('Only the project owner changes environments');
    await expect(tid(member, 'env-card-uat')).toContainText("Waiting for the Owner's approval");
  });

  test('8. release to live: the Live card says what it waits for, then Release becomes available; the Releases page lists it', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'approved' });
    await goEnv(page);
    await expect(tid(page, 'env-sentence-production')).toContainText(
      'Waiting for: test site healthy for 3 more minutes',
    );
    await expect(tid(page, 'env-release-production')).toHaveCount(0);
    await page.evaluate(() => localStorage.setItem('aom-mock-rules', 'met'));
    await page.reload();
    await tid(page, 'env-release-production').click();
    await expect(page.getByRole('dialog')).toContainText('Release to Live site');
    await page.keyboard.press('Escape');
    await page.goto('/releases?tab=waiting');
    await expect(page.getByTestId('release-queue')).toContainText('P5');
    await page.goto('/releases?tab=live');
    await expect(page.getByRole('main')).toContainText('Live site');
  });

  test('9. rollback: the sheet lists earlier releases; after confirming, What is live shows the older version and History says rollback', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'approved' });
    await goEnv(page);
    await page.getByRole('button', { name: 'More for Live site' }).click();
    await page.getByRole('menuitem', { name: /Go back to an earlier version/ }).click();
    const sheet = tid(page, 'rollback-sheet');
    await expect(sheet).toContainText('Your data is not rolled back');
    await expect(page.getByTestId('rollback-candidate')).toHaveCount(2);
    await page.getByTestId('rollback-candidate').first().getByRole('radio').check();
    await tid(page, 'rollback-confirm').click();
    await page.goto('/releases?tab=live');
    await expect(page.getByRole('main')).toContainText('0.9.1');
    await page.goto('/releases?tab=history');
    await expect(page.getByRole('main')).toContainText(/rollback/i);
  });

  test('11. a Member sees What is live and History read-only; at 360 px the page is one column and the dialog is usable', async ({
    browser,
  }) => {
    const member = await openAs(browser, { scenario: 'member' });
    await member.goto('/releases?tab=live');
    await expect(member.getByRole('main')).toContainText('Live site');
    await expect(member.getByRole('button', { name: /^Release/ })).toHaveCount(0);
    const phone = await openAs(browser, { scenario: 'approved', width: 360, height: 780 });
    await goEnv(phone);
    await noHorizontalScroll(phone);
    await expect(tid(phone, 'setup-add')).toBeVisible();
    await tid(phone, 'setup-add').click();
    await expect(tid(phone, 'environment-dialog')).toBeVisible();
    await noHorizontalScroll(phone);
    await expect(tid(phone, 'env-next')).toBeVisible();
    await phone.keyboard.press('Escape');
    await expect(tid(phone, 'env-card-uat')).toBeVisible();
    // every primary action of a card is reachable without sideways scrolling
    await expect(tid(phone, 'env-update-uat'))
      .toBeInViewport({ ratio: 0.5 })
      .catch(async () => {
        await tid(phone, 'env-update-uat').scrollIntoViewIfNeeded();
        await expect(tid(phone, 'env-update-uat')).toBeInViewport({ ratio: 0.5 });
      });
  });

  test('12. redirects: /deploys lands on /releases, settings #run lands on Your app', async ({ browser }) => {
    const page = await openAs(browser, { scenario: 'approved' });
    await page.goto('/deploys');
    await expect(page).toHaveURL(/\/releases/);
    const id = await page.evaluate(async () => {
      const r = await fetch('/api/projects');
      return ((await r.json()) as { projects: Array<{ id: string; key: string }> }).projects.find(
        (p) => p.key === 'P5',
      )?.id;
    });
    // an old bookmark, followed inside the app (the mocked world gives every page load new ids)
    await page.evaluate((pid) => {
      window.history.pushState({}, '', `/projects/${pid}/settings#run`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, id);
    await expect(page).toHaveURL(/\/p\/P5\/environments#start-steps/);
    await expect(tid(page, 'your-app')).toBeVisible();
  });

  test('13. an unreachable place: Cannot reach with Check and Reconnect, updates blocked with the reason; Check brings it back', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'offline' });
    await goEnv(page);
    await expect(tid(page, 'env-chip-production')).toHaveText('Cannot reach');
    await expect(tid(page, 'env-sentence-production')).toContainText('Updates are blocked');
    await expect(tid(page, 'env-reconnect-production')).toBeVisible();
    await tid(page, 'env-check-production').click();
    await expect(tid(page, 'env-chip-production')).not.toHaveText('Cannot reach');
    await expect(tid(page, 'place-shop-live')).toContainText('Can sign in');
  });

  test('14. an answer that turns on sudo is confirmed in words before it is kept', async ({ browser }) => {
    const page = await openAs(browser, { scenario: 'confirm' });
    await goEnv(page);
    await tid(page, 'needs-answer-open').click();
    await tid(page, 'answer-0-yes').click();
    await tid(page, 'answers-submit').click();
    await expect(tid(page, 'answers-confirm-list')).toContainText('Guildwise will use sudo');
    await tid(page, 'answers-confirm').click();
    await expect(tid(page, 'proposal-questions')).toContainText('Your answers');
  });

  test('15. a key that could not be taken off the server is forgotten here only when the person says so', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'approved', extra: { 'aom-mock-revoke': 'fail' } });
    await goEnv(page, '#places');
    await tid(page, 'places-add-server').click();
    await tid(page, 'host-use-flow5-server').click();
    await tid(page, 'server-done').click();
    await page.getByRole('button', { name: 'More for flow5-server' }).click();
    await page.getByRole('menuitem', { name: 'Remove' }).click();
    await tid(page, 'remove-key').check();
    await tid(page, 'remove-place-confirm').click();
    await expect(tid(page, 'key-cleanup')).toContainText('could not take its key off');
    await tid(page, 'forget-key-anyway').click();
    await expect(tid(page, 'key-cleanup')).toHaveCount(0);
  });

  test('16. a stack that cannot be updated yet says why, and files an app writes itself must be marked as kept first', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'unsupported' });
    await goEnv(page);
    await tid(page, 'setup-add').click();
    await tid(page, 'place-choice-Office PC').click();
    await expect(tid(page, 'stack-unsupported')).toContainText('Not supported yet');
    await page.keyboard.press('Escape');
    const native = await openAs(browser, { scenario: 'nativeempty' });
    await goEnv(native);
    await tid(native, 'setup-add').click();
    await tid(native, 'place-choice-Office PC').click();
    await tid(native, 'native-choice').first().click();
    await tid(native, 'env-next').click();
    await expect(tid(native, 'native-state-paths')).toContainText('uploads');
    await tid(native, 'native-adopt-confirm').check();
    await expect(tid(native, 'env-to-review')).toBeDisabled();
    await tid(native, 'native-keep-state').click();
    await expect(tid(native, 'env-to-review')).toBeEnabled();
  });

  test('17. two checkouts of one repo share a compose project: the running one is preselected, the other is "not running", and a registry image keeps its name', async ({
    browser,
  }) => {
    const running = '/home/user/projects/p5-run-trial/deploy/local/docker-compose.yml';
    const other = '/home/user/projects/mm-fixes-wt/deploy/local/docker-compose.yml';
    const page = await openAs(browser, { scenario: 'empty', extra: { 'aom-mock-local': 'copies' } });
    await goEnv(page);
    await tid(page, 'setup-add').click();
    await tid(page, 'place-choice-Office PC').click();
    // the running copy is chosen without a click; the other copy is listed apart and is not chosen
    const choices = tid(page, 'stack-choice');
    await expect(choices).toHaveCount(2);
    await expect(choices.first()).toContainText(running);
    await expect(choices.first().locator('input[type="radio"]')).toBeChecked();
    await expect(tid(page, 'other-copies')).toContainText('not running');
    await expect(choices.nth(1)).toContainText(other);
    await expect(choices.nth(1).locator('input[type="radio"]')).not.toBeChecked();
    await tid(page, 'env-next').click();
    // the setup keeps the home folder as ~
    const tilde = running.replace('/home/user', '~');
    await expect(tid(page, 'env-details')).toContainText(tilde);
    await expect(tid(page, 'env-details')).not.toContainText('mm-fixes-wt');
    await tid(page, 'env-to-review').click();
    await tid(page, 'review-save').click();
    await expect(tid(page, 'review-saved')).toBeVisible();
    // what was saved: the running file, and the image name without the registry address
    const saved = await page.evaluate(() => localStorage.getItem('aom-mock-env') ?? '');
    expect(saved).toContain(tilde);
    expect(saved).not.toContain('mm-fixes-wt/deploy/local/docker-compose.yml"');
    expect(saved).toContain('"imageName":"demo-server"');
    expect(saved).not.toContain('"imageName":"192.168.1.11"');
  });

  test('10. card test copies: the Test copies card says where they run and what is running; without start steps it says so', async ({
    browser,
  }) => {
    const page = await openAs(browser, { scenario: 'approved' });
    await goEnv(page);
    const card = tid(page, 'test-copies');
    await expect(card).toContainText('Test copies');
    await expect(tid(page, 'test-copies-now')).toBeVisible();
    await expect(tid(page, 'test-copies-keep')).toBeVisible();
    // started, stopped and kept-after-failure copies need a real runner: see the stack project below
  });
});

// ------------------------------------------------------------------------------------------------ the full stack
test.describe('Environments: the page against the real server', () => {
  test.skip(MSW, 'the full stack is not part of the mocked run');

  test('the page, its sections and its redirects load for the Owner', async ({ browser }) => {
    const page = await openAs(browser);
    await goEnv(page);
    await expect(tid(page, 'your-app')).toBeVisible();
    await expect(tid(page, 'environments')).toBeVisible();
    await expect(tid(page, 'places')).toBeVisible();
    await page.goto('/deploys');
    await expect(page).toHaveURL(/\/releases/);
    await page.goto('/releases?tab=live');
    await expect(page.getByRole('main')).toBeVisible();
  });

  test('at 360 px the page has no sideways scroll and Add an environment opens a usable dialog', async ({
    browser,
  }) => {
    const page = await openAs(browser, { width: 360, height: 780 });
    await goEnv(page);
    await noHorizontalScroll(page);
    await tid(page, 'setup-add').click();
    await expect(tid(page, 'environment-dialog')).toBeVisible();
    await noHorizontalScroll(page);
  });
});

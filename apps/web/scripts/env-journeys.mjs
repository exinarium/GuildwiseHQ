// The journeys of docs/design/environments-ux.md as screenshot scripts. `run({ p, size, name, shot })` walks one journey.
const BASE = process.env.BASE ?? 'http://127.0.0.1:5188';
export const goEnv = async (p, key = 'P5', hash = '') => {
  await p.goto(`${BASE}/p/${key}/environments${hash}`);
  await p.getByTestId('environments-page').waitFor();
};
const tid = (p, id) => p.getByTestId(id);
const click = async (p, id) => {
  const l = tid(p, id).first();
  await l.scrollIntoViewIfNeeded();
  await l.click();
};
const dialogShot = async (p, shot, n) => {
  await p.waitForTimeout(500);
  await shot(n, { full: false });
};

export const journeys = [
  {
    id: 'main',
    scenario: 'approved',
    dark: true,
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await tid(p, 'env-card-uat').waitFor();
      await shot(name('page'));
    },
  },
  {
    id: 'a-empty',
    scenario: 'empty',
    dark: true,
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await tid(p, 'setup-empty').waitFor();
      await shot(name('empty'));
    },
  },
  {
    id: 'a-scan',
    scenario: 'empty',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await click(p, 'empty-scan');
      await tid(p, 'needs-answer').waitFor();
      await shot(name('1-banner'));
      await click(p, 'needs-answer-open');
      await tid(p, 'proposal-review').waitFor();
      await dialogShot(p, shot, name('2-review-questions'));
      // the Use button is blocked until the question without a default is answered
      await p.getByTestId('proposal-use').scrollIntoViewIfNeeded();
      await shot(name('2b-review-bottom'), { full: false });
      await p.getByTestId('answer-0-app').click();
      await p.getByTestId('answer-2-No, it is a test site').click();
      await click(p, 'answers-submit');
      await p.waitForTimeout(600);
      await dialogShot(p, shot, name('3-answered'));
      await click(p, 'proposal-use');
      await tid(p, 'env-card-uat').waitFor();
      await shot(name('4-draft-cards'));
    },
  },

  {
    id: 'b-local',
    scenario: 'empty',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await click(p, 'setup-add');
      await tid(p, 'environment-dialog').waitFor();
      await dialogShot(p, shot, name('1-form'));
      await click(p, 'place-choice-Office PC');
      await tid(p, 'stack-choice').first().waitFor();
      await dialogShot(p, shot, name('2-found'));
      await click(p, 'stack-choice');
      await p.waitForTimeout(300);
      await tid(p, 'when-update').scrollIntoViewIfNeeded();
      await dialogShot(p, shot, name('3-when'));
      await click(p, 'env-next');
      await tid(p, 'env-details').waitFor();
      await dialogShot(p, shot, name('4-details'));
      await click(p, 'env-to-review');
      await tid(p, 'env-review').waitFor();
      await p.getByTestId('review-save').waitFor();
      await dialogShot(p, shot, name('5-review'));
      await click(p, 'review-save');
      await tid(p, 'review-saved').waitFor();
      await dialogShot(p, shot, name('6-saved'));
      await click(p, 'review-done');
      await tid(p, 'env-card-test-site').waitFor();
      await shot(name('7-card-saved'));
      await click(p, 'env-try-test-site');
      await tid(p, 'env-tried-test-site').waitFor();
      await shot(name('8-tried'));
      await click(p, 'env-approve-test-site');
      await tid(p, 'approve-dialog').waitFor();
      await dialogShot(p, shot, name('9-approve'));
      await click(p, 'approve-confirm');
      await p.waitForTimeout(700);
      await shot(name('10-approved'));
    },
  },
  {
    id: 'b-elsewhere',
    scenario: 'empty',
    extra: { 'aom-mock-local': 'bare' },
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await click(p, 'setup-add');
      await click(p, 'place-choice-Office PC');
      await tid(p, 'no-stacks').waitFor();
      await dialogShot(p, shot, name('1-miss'));
      await click(p, 'somewhere-else');
      await tid(p, 'folder-input').fill('/home/user/projects/demo-app');
      await dialogShot(p, shot, name('2-folder'));
      await click(p, 'folder-look');
      await tid(p, 'stack-choice').first().waitFor();
      await dialogShot(p, shot, name('3-found'));
    },
  },
  {
    id: 'c-server',
    scenario: 'empty',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await click(p, 'setup-add');
      await click(p, 'role-live');
      await click(p, 'choose-add-server');
      await tid(p, 'ssh-hosts').waitFor();
      await dialogShot(p, shot, name('1-add-server'));
      await click(p, 'host-use-flow5-server');
      await tid(p, 'server-look').waitFor();
      await tid(p, 'server-found').waitFor();
      await dialogShot(p, shot, name('2-looked'));
      await click(p, 'server-done');
      await tid(p, 'stack-choice').first().waitFor();
      await click(p, 'stack-choice');
      await tid(p, 'update-method').waitFor();
      await tid(p, 'update-method').scrollIntoViewIfNeeded();
      await dialogShot(p, shot, name('3-method'));
      await click(p, 'env-next');
      await tid(p, 'env-details').waitFor();
      await dialogShot(p, shot, name('4-details'));
      await click(p, 'env-to-review');
      await tid(p, 'review-save').waitFor();
      await dialogShot(p, shot, name('5-review'));
    },
  },
  {
    id: 'd-p5',
    scenario: 'p5',
    dark: true,
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await tid(p, 'env-card-test-site').waitFor();
      await shot(name('page'));
    },
  },
  {
    id: 'd-second',
    scenario: 'p5',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await click(p, 'setup-add');
      await click(p, 'role-other');
      await tid(p, 'env-label').fill('Demo');
      await click(p, 'place-choice-flow5-local');
      await tid(p, 'stack-choice').first().waitFor();
      await dialogShot(p, shot, name('1-other'));
    },
  },

  {
    id: 'h-states',
    scenario: 'waiting',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await tid(p, 'env-card-uat').waitFor();
      await shot(name('1-needs-try'));
      await click(p, 'env-try-uat');
      await click(p, 'env-try-production');
      await p.waitForTimeout(600);
      await shot(name('2-waiting-approval'));
    },
  },
  {
    id: 'i-release',
    scenario: 'approved',
    extra: { 'aom-mock-rules': 'met' },
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await click(p, 'env-release-production');
      await tid(p, 'release-sheet').waitFor();
      await dialogShot(p, shot, name('1-release-sheet'));
    },
  },
  {
    id: 'k-rollback',
    scenario: 'approved',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await p.getByRole('button', { name: 'More for Live site' }).click();
      await p.getByRole('menuitem', { name: /Go back to an earlier version/ }).click();
      await tid(p, 'rollback-sheet').waitFor();
      await dialogShot(p, shot, name('1-rollback-sheet'));
    },
  },
  {
    id: 'l-failed',
    scenario: 'failed',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await tid(p, 'env-card-production').waitFor();
      await shot(name('page'));
    },
  },
  {
    id: 'm-offline',
    scenario: 'offline',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await tid(p, 'env-card-production').waitFor();
      await shot(name('page'));
    },
  },
  {
    id: 'n-member',
    scenario: 'member',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await tid(p, 'env-readonly').waitFor();
      await shot(name('page'));
    },
  },
  {
    id: 'o-remove',
    scenario: 'p5',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await p.getByRole('button', { name: 'More for Test site' }).click();
      await p.getByRole('menuitem', { name: /Remove/ }).click();
      await tid(p, 'remove-env-dialog').waitFor();
      await dialogShot(p, shot, name('1-remove-env'));
      await click(p, 'remove-env-confirm');
      await p.waitForTimeout(700);
      await shot(name('2-after'));
    },
  },
  {
    id: 'o-place',
    scenario: 'p5',
    run: async ({ p, name, shot }) => {
      await goEnv(p, 'P5', '#places');
      await tid(p, 'places').waitFor();
      await shot(name('1-places-duplicate'));
      await p.getByRole('button', { name: 'More for Office PC' }).first().click();
      await p.getByRole('menuitem', { name: /Remove/ }).click();
      await tid(p, 'place-in-use').waitFor();
      await dialogShot(p, shot, name('2-in-use'));
      await p.keyboard.press('Escape');
      await click(p, 'place-merge-Test copy');
      await tid(p, 'merge-dialog').waitFor();
      await dialogShot(p, shot, name('3-merge'));
      await p.getByRole('button', { name: 'Merge', exact: true }).last().click();
      await p.waitForTimeout(700);
      await shot(name('4-merged'));
    },
  },
  {
    id: 'o-cleanup',
    scenario: 'p5',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await p.getByText('Show technical details').click();
      await click(p, 'cleanup-open');
      await tid(p, 'cleanup-dialog').waitFor();
      await dialogShot(p, shot, name('1-cleanup'));
    },
  },
  {
    id: 'e-change-place',
    scenario: 'approved',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await p.getByRole('button', { name: 'More for Live site' }).click();
      await p.getByRole('menuitem', { name: /Change server/ }).click();
      await tid(p, 'change-place-dialog').waitFor();
      await dialogShot(p, shot, name('1-change-server'));
    },
  },
  {
    id: 'p-native',
    scenario: 'native',
    dark: true,
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await tid(p, 'env-card-test-site').waitFor();
      await shot(name('page'));
    },
  },
  {
    id: 'p-native-local',
    scenario: 'nativeempty',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await click(p, 'setup-add');
      await click(p, 'place-choice-Office PC');
      await tid(p, 'native-choice').first().waitFor();
      await dialogShot(p, shot, name('1-found-pm2'));
      await click(p, 'native-choice');
      await click(p, 'env-next');
      await tid(p, 'native-details').waitFor();
      await dialogShot(p, shot, name('2-details'));
      await click(p, 'env-to-review');
      await tid(p, 'review-save').waitFor();
      await dialogShot(p, shot, name('3-review'));
    },
  },
  {
    id: 'p-native-server',
    scenario: 'nativeempty',
    run: async ({ p, name, shot }) => {
      await goEnv(p);
      await click(p, 'setup-add');
      await click(p, 'role-live');
      await click(p, 'choose-add-server');
      await click(p, 'host-use-billing-vps');
      await tid(p, 'server-look').waitFor();
      await dialogShot(p, shot, name('1-looked'));
      await click(p, 'server-done');
      await tid(p, 'native-choice').first().waitFor();
      await click(p, 'native-choice');
      await click(p, 'env-next');
      await tid(p, 'native-details').waitFor();
      await dialogShot(p, shot, name('2-details'));
    },
  },
  {
    id: 'q-settings',
    scenario: 'approved',
    run: async ({ p, name, shot }) => {
      await p.goto(`${BASE}/projects`);
      await p.waitForTimeout(800);
      await p
        .getByText('Flow5')
        .first()
        .click()
        .catch(() => undefined);
    },
    sizes: [],
  },
];

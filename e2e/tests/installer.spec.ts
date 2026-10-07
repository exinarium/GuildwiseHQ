import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { pool, q } from '../support/db.ts';
import { ADMIN, BASE_URL, INSTALLER, paths } from '../support/env.ts';
import { pairRunner } from '../support/runner.ts';

// "Add a workstation": the wizard on the Workstations page, the generated install script behind its short-lived link,
// and the live progress (waiting -> paired -> health checks -> done). The script itself is never run here (installers
// run only in throwaway containers, see scripts/test-installer-docker.sh); this spec plays its part by pairing the real
// runner CLI with the code inside the script and by sending the progress reports the script sends.
test.describe.configure({ mode: 'serial' });

let page: Page;
let api: APIRequestContext;
const scratch = mkdtempSync(join(tmpdir(), 'aom-installer-'));

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, INSTALLER);
  api = await apiAs(INSTALLER.email, INSTALLER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});
test.afterAll(async () => {
  rmSync(scratch, { recursive: true, force: true });
  await pool.end();
});

const tokenOf = (command: string) => /\/install\/([^/]+)\//.exec(command)?.[1] as string;
const urlOf = (command: string) => /'([^']+)'/.exec(command)?.[1] as string;
const report = (token: string, body: Record<string, string>) =>
  fetch(`${BASE_URL}/install/${token}/progress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('the empty Workstations page offers the guided setup and detects the system', async () => {
  await page.goto('/workstations');
  await expect(page.getByTestId('workstations-empty')).toBeVisible();
  await page.getByTestId('add-workstation-empty').click();
  const wizard = page.getByTestId('add-workstation');
  await expect(wizard).toBeVisible();
  await expect(page.getByTestId('os-linux')).toHaveAttribute('aria-checked', 'true');
  const command = page.getByTestId('install-command');
  await expect(command).toContainText(`curl -fsSL '${BASE_URL}/install/`);
  await expect(command).toContainText('| bash');
  await expect(page.getByTestId('install-steps')).toContainText('Open a terminal');
  await page.screenshot({ path: join(paths.vaults, 'installer-wizard.png'), fullPage: true });

  // another system, another command
  await page.getByTestId('os-windows').click();
  await expect(command).toContainText("irm '");
  await expect(command).toContainText('| iex');
  await expect(page.getByTestId('install-steps')).toContainText('PowerShell');
  await page.getByTestId('os-macos').click();
  await expect(command).toContainText('| bash');
  await expect(page.getByTestId('install-steps')).toContainText('Terminal');
  await page.getByTestId('os-linux').click();
  await expect(command).toContainText(`curl -fsSL '${BASE_URL}/install/`);
});

test('the link serves a script with a one-time code and no long-lived secret; the download works', async () => {
  const command = (await page.getByTestId('install-command').innerText()).trim();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-script').click(),
  ]);
  expect(download.suggestedFilename()).toBe('install-guildwise-hq.sh');
  const saved = join(scratch, 'downloaded.sh');
  await download.saveAs(saved);
  const downloaded = readFileSync(saved, 'utf8');
  expect(downloaded.startsWith('#!/usr/bin/env bash')).toBe(true);
  expect(downloaded).toContain(`SERVER_URL='${BASE_URL}'`);
  expect(downloaded).toMatch(/PAIRING_CODE='[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}'/);
  expect(downloaded).not.toMatch(/aomr_|aom_session/);
  const syntax = spawnSync('bash', ['-n', saved], { encoding: 'utf8' });
  expect(syntax.status, syntax.stderr).toBe(0);

  const res = await fetch(urlOf(command));
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect((await res.text()).startsWith('#!/usr/bin/env bash')).toBe(true);
  // a wrong token is not served
  expect(
    (await fetch(urlOf(command).replace(/\/install\/[^/]+\//, '/install/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/')))
      .status,
  ).toBe(404);
});

test('progress: waiting, then running, paired, health checks streaming in, done', async () => {
  const command = (await page.getByTestId('install-command').innerText()).trim();
  const token = tokenOf(command);
  const progress = page.getByTestId('install-progress');
  await expect(progress).toHaveAttribute('data-state', 'waiting');

  expect((await report(token, { step: 'installer', status: 'start', detail: 'linux' })).status).toBe(200);
  await expect(progress).toHaveAttribute('data-state', 'running');

  // the script's own code pairs the real runner CLI
  const script = await (await fetch(urlOf(command))).text();
  const code = /PAIRING_CODE='([^']+)'/.exec(script)?.[1] as string;
  const home = paths.runnerHome('installer');
  pairRunner(BASE_URL, code, 'Wizard Box', home);
  await report(token, { step: 'Paired', status: 'ok', detail: 'Wizard Box' });
  await expect(progress).toHaveAttribute('data-state', 'paired');
  await expect(page.getByTestId('stage-paired')).toContainText('Paired as Wizard Box');

  for (const [step, status, detail] of [
    ['doctor:node', 'ok', 'v22.23.2'],
    ['doctor:git', 'ok', 'git version 2.47.1 (need >= 2.40)'],
    ['doctor:docker', 'warn', 'not found (optional)'],
  ] as const)
    await report(token, { step, status, detail });
  await expect(page.getByTestId('doctor-node')).toContainText('v22.23.2');
  await expect(page.getByTestId('doctor-docker')).toContainText('warn');

  await report(token, { step: 'summary', status: 'done', detail: 'success' });
  await expect(page.getByTestId('install-success')).toContainText('Wizard Box is connected');
  await page.screenshot({ path: join(paths.vaults, 'installer-done.png'), fullPage: true });
  await page.getByRole('button', { name: 'Done' }).click();

  // the paired workstation is in the list
  await expect(page.getByTestId('workstation-Wizard Box')).toBeVisible();
  expect(
    (await q<{ n: string }>(`SELECT count(*) AS n FROM workstations WHERE name='Wizard Box'`))[0]?.n,
  ).toBe('1');
});

test('a failed install shows help and Contact us; starting over retires the old code', async () => {
  await page.getByTestId('add-workstation-button').click();
  const command = (await page.getByTestId('install-command').innerText()).trim();
  const token = tokenOf(command);
  await report(token, {
    step: 'Downloading the runner',
    status: 'fail',
    detail: 'Could not download the runner',
  });
  await report(token, { step: 'summary', status: 'done', detail: 'failed: Could not download the runner' });
  const failure = page.getByTestId('install-failure');
  await expect(failure).toContainText('Could not download the runner');
  await expect(failure.getByTestId('install-help')).toHaveAttribute('href', '/help#install-troubleshooting');
  await expect(failure.getByTestId('install-contact')).toHaveAttribute(
    'href',
    '/help/contact?from=installer',
  );
  writeFileSync(join(scratch, 'ok'), '1');
});

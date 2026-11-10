import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { killProcsUnder, removeTree, useTmp } from './tmp-root.ts';

/*
 * Every temp dir a test file makes (its `tmpdir()` dirs, agent temp dirs, run tmp dirs, its HOME) lives in one dir of its
 * own inside the run's temp root (test/global-setup.ts). The `afterAll` below runs after the file's own hooks (hooks
 * stack): it stops what the file left running there (a service, a fake web server) and removes the dir, also when a test
 * failed or timed out.
 */
const fileTmp = mkdtempSync(join(tmpdir(), 'aom-f-'));
useTmp(fileTmp);
afterAll(async () => {
  await killProcsUnder(fileTmp);
  removeTree(fileTmp);
}, 60_000);

/*
 * Tests never read the real config of the machine they run on (backlog #65: the runner resolves the commit identity from
 * the project, the repository and the workstation's global config). Each test process gets its own HOME and global
 * config that holds a fixed "workstation owner"; a test that needs no identity or another one overrides
 * GIT_CONFIG_GLOBAL itself.
 */
export const TEST_OWNER = { name: 'Workstation Owner', email: 'owner@example.test' };

const home = mkdtempSync(join(fileTmp, 'aom-test-home-'));
const global = join(home, '.gitconfig');
writeFileSync(global, `[user]\n\tname = ${TEST_OWNER.name}\n\temail = ${TEST_OWNER.email}\n`);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.GIT_CONFIG_GLOBAL = global;
process.env.GIT_CONFIG_NOSYSTEM = '1';

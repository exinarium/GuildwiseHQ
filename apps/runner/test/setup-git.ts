import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { FILE_PREFIX, killProcsUnder, removeTree, useTmp } from './tmp-root.ts';

/*
 * Every `tmpdir()` dir a test file makes (and its HOME) lives in one dir of its own inside the run's temp root
 * (test/global-setup.ts); agent temp dirs and run tmp dirs stay in the run root itself (short socket paths, see
 * tmp-root.ts). The `afterAll` below runs after the file's own hooks (hooks stack): it stops what the file left running
 * (a service, a fake web server: their command lines name the file's dir) and removes the dir, also when a test failed or
 * timed out. Without the global setup (another config) the file's dir is the agent temp root too.
 */
const runRoot = tmpdir();
const fileTmp = mkdtempSync(join(runRoot, FILE_PREFIX));
useTmp(fileTmp, process.env.AOM_AGENT_TMP_ROOT === runRoot ? runRoot : fileTmp);
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

const home = mkdtempSync(join(fileTmp, 'home-'));
const global = join(home, '.gitconfig');
writeFileSync(global, `[user]\n\tname = ${TEST_OWNER.name}\n\temail = ${TEST_OWNER.email}\n`);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.GIT_CONFIG_GLOBAL = global;
process.env.GIT_CONFIG_NOSYSTEM = '1';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Tests never read the real config of the machine they run on (backlog #65: the runner resolves the commit identity from
 * the project, the repository and the workstation's global config). Each test process gets its own HOME and global
 * config that holds a fixed "workstation owner"; a test that needs no identity or another one overrides
 * GIT_CONFIG_GLOBAL itself.
 */
export const TEST_OWNER = { name: 'Workstation Owner', email: 'owner@example.test' };

const home = mkdtempSync(join(tmpdir(), 'aom-test-home-'));
const global = join(home, '.gitconfig');
writeFileSync(global, `[user]\n\tname = ${TEST_OWNER.name}\n\temail = ${TEST_OWNER.email}\n`);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.GIT_CONFIG_GLOBAL = global;
process.env.GIT_CONFIG_NOSYSTEM = '1';

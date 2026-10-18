import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SIMULATION_GIT_IDENTITY, simulationGitEnv } from '../src/simulation/host.ts';

const dir = mkdtempSync(join(tmpdir(), 'aom-sim-id-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the simulated workstation has a commit identity', () => {
  it('its runner environment gives the VCS a global user.name and user.email (no no_commit_identity refusal)', () => {
    const env = simulationGitEnv(dir);
    const read = (key: string) =>
      execFileSync('git', ['config', '--global', '--get', key], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      }).trim();
    expect(read('user.name')).toBe(SIMULATION_GIT_IDENTITY.name);
    expect(read('user.email')).toBe(SIMULATION_GIT_IDENTITY.email);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Release-readiness O7: the CI fails a pull request that brings in a dependency with a known advisory (`pnpm audit`), on
 * the existing triggers only (pull requests and pushes to main: "CI only on PRs and main"), and Dependabot proposes the
 * updates for every ecosystem the repository uses. A text check: the workflow itself runs on GitHub.
 */
const root = join(import.meta.dirname, '../../..');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const dependabot = readFileSync(join(root, '.github/dependabot.yml'), 'utf8');

const jobBlock = (name: string): string => {
  const start = ci.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(0);
  const rest = ci.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 3);
};

describe('O7: dependency audit in CI', () => {
  it('runs on pull requests and pushes to main only: no new trigger', () => {
    const on = ci.slice(ci.indexOf('\non:\n'), ci.indexOf('\npermissions:'));
    expect(on.trim()).toBe('on:\n  push:\n    branches: [main]\n  pull_request:');
    // no other trigger anywhere below either (comments aside)
    const code = ci.replace(/^\s*#.*$/gm, '');
    expect(code).not.toMatch(/schedule:|workflow_dispatch|pull_request_target|workflow_run/);
  });

  it('has an audit job that fails on any advisory, with pinned actions and no secrets', () => {
    const job = jobBlock('audit');
    expect(job).toContain('run: pnpm audit --audit-level low');
    expect(job).toContain('persist-credentials: false');
    for (const uses of job.match(/uses: \S+/g) ?? []) expect(uses).toMatch(/@[0-9a-f]{40}$/);
    expect(job).not.toContain('secrets.');
  });

  it('pins the mail sink of the server tests instead of :latest', () => {
    expect(ci).toContain('image: axllent/mailpit:v1.31.3');
    expect(ci).not.toContain(':latest');
  });
});

describe('O7: Dependabot', () => {
  it.each(['npm', 'github-actions', 'docker', 'docker-compose'])('updates the %s ecosystem', (eco) => {
    expect(dependabot).toContain(`- package-ecosystem: ${eco}\n`);
  });

  it('targets development with a cooldown, weekly', () => {
    const entries = dependabot.split('- package-ecosystem:').slice(1);
    expect(entries).toHaveLength(4);
    for (const e of entries) {
      expect(e).toContain('target-branch: development');
      expect(e).toContain('interval: weekly');
      expect(e).toContain('default-days: 3');
    }
  });
});

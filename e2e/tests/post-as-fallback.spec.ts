import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { apiAs } from '../support/api.ts';
import { pool, q } from '../support/db.ts';
import { MEMBER, paths } from '../support/env.ts';

/**
 * Projects with no "post as" app keep today's identity and credentials. Runs after core-loop: TOY has no app
 * selected, and its builder shifts committed in a card worktree of the toy clone through the real runner (mock agent).
 * Checks the commit identity of those commits and that no token or credential lands in any git config, remote URL or
 * runner log on the way.
 */

test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
let projectId: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** Token shapes that must never be written anywhere: GitHub tokens, a basic-auth URL, the runner's helper variables. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['GitHub installation/user token', /\b(ghs|ghp|gho|ghu|ghr)_[A-Za-z0-9]{10,}/],
  ['fine-grained token', /github_pat_[A-Za-z0-9_]{10,}/],
  ['x-access-token user', /x-access-token/i],
  ['credentials in an http(s) URL', /https?:\/\/[^/\s:@]+:[^/\s@]+@/i],
  ['runner token variable', /AOM_GIT_TOKEN/],
];

function secretsIn(text: string): string[] {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Every git config file under a directory: `.git/config`, worktree `config.worktree` and bare repository configs. */
function gitConfigs(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || !existsSync(dir)) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'objects') continue;
      gitConfigs(p, depth + 1, out);
    } else if (
      (name === 'config' || name === 'config.worktree') &&
      /(\.git|worktrees\/[^/]+|\.git\/modules)/.test(dir)
    ) {
      out.push(p);
    }
  }
  return out;
}

test.beforeAll(async () => {
  api = await apiAs(MEMBER.email, MEMBER.password);
  const projects = (await (await api.get('/api/projects')).json()).projects;
  projectId = projects.find((p: { key: string }) => p.key === 'TOY').id;
});

test.afterAll(async () => {
  await pool.end();
});

test('TOY has no post-as app: the settings show none selected and every repository resolves to today’s identity', async () => {
  const res = await api.get(`/api/projects/${projectId}/commit-as`);
  expect(res.ok(), await res.text()).toBe(true);
  const body = await res.json();
  expect(body.postAs?.selected ?? []).toEqual([]);
  for (const row of body.repos ?? []) expect(row.resolved?.source, JSON.stringify(row)).not.toBe('app');
});

test('builder commits in the card worktree carry the same non-bot author and committer, as before', async () => {
  const card = (
    await q<{ worktree_path: string | null }>('SELECT worktree_path FROM cards WHERE ref=$1', ['TOY-1'])
  )[0];
  const wt = card?.worktree_path ?? '';
  expect(existsSync(wt), `TOY-1 worktree ${wt}`).toBe(true);
  const lines = git(wt, 'log', '--format=%an|%ae|%cn|%ce|%s', 'main..HEAD').split('\n').filter(Boolean);
  const builds = lines.filter((l) => l.includes('mock build round'));
  expect(builds.length, lines.join('\n')).toBeGreaterThanOrEqual(2);

  const res = await (await api.get(`/api/projects/${projectId}/commit-as`)).json();
  const expected: { name: string; email: string } | null =
    res.commitAs ?? res.clones?.find((c: { identity: unknown }) => c.identity)?.identity ?? null;

  for (const line of lines) {
    const [an, ae, cn, ce] = line.split('|');
    expect(`${an} <${ae}>`, line).toBe(`${cn} <${ce}>`);
    expect(an, line).not.toMatch(/\[bot\]/);
    expect(ae, line).not.toMatch(/users\.noreply\.|\[bot\]/);
    expect(ae, line).not.toBe('');
    if (expected)
      expect({ name: an, email: ae }, line).toEqual({ name: expected.name, email: expected.email });
  }
});

test('no git config, remote URL or runner log holds a token or credential', async () => {
  const card = (
    await q<{ worktree_path: string | null }>('SELECT worktree_path FROM cards WHERE ref=$1', ['TOY-1'])
  )[0];
  const wt = card?.worktree_path ?? '';

  // the remotes stay the plain local origin the clone was made from: no user, token or helper in the URL
  for (const dir of [paths.toyClone, wt]) {
    const remotes = git(dir, 'remote', '-v');
    expect(remotes).toContain(paths.origin);
    expect(secretsIn(remotes), remotes).toEqual([]);
    // no credential helper was written into the repository's config (the app helper is passed per process only)
    const helpers = spawnSync('git', ['-C', dir, 'config', '--get-all', 'credential.helper'], {
      encoding: 'utf8',
    });
    // exit 1: the key is not set anywhere git looks
    expect(helpers.status, `credential.helper in ${dir}: ${helpers.stdout}`).toBe(1);
  }

  const configs = [
    ...gitConfigs(paths.repoRoot),
    ...gitConfigs(paths.runnerData),
    join(paths.origin, 'config'),
  ];
  expect(configs.length).toBeGreaterThan(0);
  for (const file of configs) {
    const text = readFileSync(file, 'utf8');
    expect(secretsIn(text), file).toEqual([]);
    expect(text, file).not.toMatch(/^\s*\[credential/m);
  }

  // the runner never refused a push on this project (no app tripwire) and never asked for an app identity
  const log = existsSync(paths.runnerLog) ? readFileSync(paths.runnerLog, 'utf8') : '';
  expect(log).not.toContain('refusing to push');
  expect(log).not.toContain('app_identity_failed');
  expect(secretsIn(log)).toEqual([]);
  const shiftLogs = join(paths.runnerData, 'logs', 'shifts');
  if (existsSync(shiftLogs))
    for (const f of readdirSync(shiftLogs)) {
      const text = readFileSync(join(shiftLogs, f), 'utf8');
      expect(text, f).not.toContain('refusing to push');
      expect(secretsIn(text), f).toEqual([]);
    }
});

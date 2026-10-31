import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GUILDWISEHQ_RUNNER_RULE_MIGRATION,
  migrateGuildwiseRunnerRule,
} from '../src/data-migrations/guildwisehq-runner-rule.ts';
import { DATA_MIGRATIONS } from '../src/data-migrations/index.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const repoUrl = (id = w.repoId) => `/api/projects/${w.projectId}/repos/${id}`;
const rulesOf = async (id = w.repoId) => {
  const p = await ok<any>(owner('GET', `/api/projects/${w.projectId}`));
  return p.repos.find((x: any) => x.id === id).componentRules;
};
const runner = {
  name: 'runner',
  paths: ['apps/runner/**'],
  versionFile: 'apps/runner/src/version.ts',
  pattern: "RUNNER_VERSION = '(.*)'",
};
const env = () => ({
  pool: w.t.app.ctx.pool,
  store: w.t.app.ctx.store,
  clock: w.t.app.ctx.clock,
  log: () => {},
});

describe('component version rules of a repository', () => {
  it('start empty, save, come back after a reload, and clear', async () => {
    expect(await rulesOf()).toEqual([]);
    const res = await owner('PATCH', repoUrl(), {
      componentRules: [{ ...runner, name: ' runner ', paths: [' apps/runner/** ', ''] }],
    });
    expect(res.status).toBe(200);
    expect(await rulesOf()).toEqual([runner]);
    const events = await q(`SELECT payload FROM events WHERE type='ProjectRepoComponentRulesSet'`);
    expect(events.at(-1)?.payload).toMatchObject({ repoId: w.repoId, rules: [runner] });
    // the same list again appends nothing
    const before = events.length;
    await owner('PATCH', repoUrl(), { componentRules: [runner] });
    expect((await q(`SELECT 1 FROM events WHERE type='ProjectRepoComponentRulesSet'`)).length).toBe(before);
    const cleared = await owner('PATCH', repoUrl(), { componentRules: [] });
    expect(cleared.status).toBe(200);
    expect(await rulesOf()).toEqual([]);
  });

  it.each([
    ['no capture group', { pattern: 'RUNNER_VERSION' }, 'exactly one capture group'],
    ['two capture groups', { pattern: '(a)(b)' }, 'it has 2'],
    ['an invalid regex', { pattern: '(' }, 'not a valid regular expression'],
    ['no globs', { paths: [] }, 'at least one path glob'],
    ['a version file with ..', { versionFile: '../version.ts' }, 'cannot contain ".."'],
    ['an empty name', { name: ' ' }, 'give the rule a name'],
  ])('refuses %s with a message that names the problem', async (_n, over, text) => {
    const res = await owner('PATCH', repoUrl(), { componentRules: [{ ...runner, ...over }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_component_rules');
    expect(res.body.error.message).toContain(text);
    expect(await rulesOf()).toEqual([]);
  });

  it('refuses a duplicate name', async () => {
    const res = await owner('PATCH', repoUrl(), { componentRules: [runner, { ...runner, name: 'Runner' }] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('another rule already has this name');
    expect(await rulesOf()).toEqual([]);
  });

  it('is owner only', async () => {
    const stranger = await w.t.userSession(`stranger-${Date.now()}@example.test`);
    const denied = await w.t.req('PATCH', repoUrl(), {
      cookie: stranger.cookie,
      body: { componentRules: [runner] },
    });
    expect(denied.status).toBeGreaterThanOrEqual(403);
    expect(await rulesOf()).toEqual([]);
  });
});

describe('guildwisehq-runner-rule data migration', () => {
  it('is registered', () => {
    expect(DATA_MIGRATIONS.map((m) => m.name)).toContain(GUILDWISEHQ_RUNNER_RULE_MIGRATION);
  });

  it('gives only the GuildwiseHQ repository the runner rule, keeps owner rules, and runs once', async () => {
    const add = (name: string, remoteUrl: string) =>
      owner('POST', `/api/projects/${w.projectId}/repos`, { name, remoteUrl, workingBranch: 'develop' });
    const find = async (name: string) =>
      (await ok<any>(owner('GET', `/api/projects/${w.projectId}`))).repos.find((x: any) => x.name === name);
    expect((await add('hq', 'git@github.com:exinarium/GuildwiseHQ.git')).status).toBeLessThan(300);
    expect((await add('other', 'https://github.com/acme/other.git')).status).toBeLessThan(300);
    const hq = await find('hq');
    const other = await find('other');
    expect(hq.componentRules).toEqual([]);

    const report = await migrateGuildwiseRunnerRule(env());
    expect(report?.changed).toContain(hq.id);
    expect(report?.changed).not.toContain(other.id);
    expect((await find('hq')).componentRules).toEqual([runner]);
    expect((await find('other')).componentRules).toEqual([]);

    // a second run changes nothing
    expect(await migrateGuildwiseRunnerRule(env())).toBeNull();
  });
});

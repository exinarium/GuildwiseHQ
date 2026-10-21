import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  type ChangeItem,
  DeliverySetupSchema,
  DeployProbeResultSchema,
  hasBlockers,
  type ProbeReport,
  ProbeReportSchema,
  planChanges,
  probeErrorText,
  samePath,
} from '../src/index.ts';
import { FIRST_ADOPTER } from './setup-fixtures.ts';

const setup = () => DeliverySetupSchema.parse(FIRST_ADOPTER());
const at = '2026-10-20T10:00:00.000Z';
const report = (over: Partial<z.input<typeof ProbeReportSchema>> = {}): ProbeReport =>
  ProbeReportSchema.parse({
    scope: 'local',
    at,
    docker: { installed: true, usable: true, version: '29.1', composeVersion: '2.40.0' },
    ...over,
  });

const texts = (items: ChangeItem[], group: ChangeItem['group'], env?: string) =>
  items.filter((i) => i.group === group && (!env || i.env === env)).map((i) => i.text);

const uatReport = () =>
  report({
    containers: [
      {
        name: 'aom-uat-app-1',
        project: 'aom-uat',
        service: 'app',
        image: 'aom-uat-app',
        state: 'running',
        status: 'Up 3 days',
        ports: [],
      },
      {
        name: 'aom-uat-postgres-1',
        project: 'aom-uat',
        service: 'postgres',
        image: 'postgres:18',
        state: 'running',
        ports: [],
      },
      {
        name: 'aom-uat-mailpit-1',
        project: 'aom-uat',
        service: 'mailpit',
        image: 'axllent/mailpit',
        state: 'running',
        ports: [],
      },
      {
        name: 'dcode-flow-local-postgres-1',
        project: 'dcode',
        service: 'postgres',
        image: 'postgres:16',
        state: 'running',
        ports: [],
      },
    ],
    composeFiles: [
      {
        path: '/home/user/.config/aom-uat/docker-compose.yml',
        project: 'aom-uat',
        services: [
          { name: 'postgres', image: 'postgres:18', database: 'postgres' },
          { name: 'app', build: '/path/to/guildwise' },
          { name: 'mailpit', image: 'axllent/mailpit:latest' },
        ],
        volumes: ['pgdata', 'simulation'],
      },
    ],
    volumes: ['aom-uat_pgdata', 'aom-uat_simulation', 'other_data'],
    backups: [{ dir: '/home/user/.config/aom-uat/backups', count: 4, newestName: 'uat-2026.sql.gz' }],
    urls: [{ url: 'http://localhost:4700/api/health', status: 200 }],
  });

describe('planChanges', () => {
  it('an adopted stack: what is found, what each update does, and everything else is not touched', () => {
    const items = planChanges(setup(), { uat: uatReport() }, 'uat');
    const reuse = texts(items, 'reuse');
    expect(reuse.join('\n')).toContain(
      'Compose file ~/.config/aom-uat/docker-compose.yml (project aom-uat) with 3 parts',
    );
    expect(reuse.join('\n')).toContain('The app part "app" (built from your code)');
    expect(reuse.join('\n')).toContain('Running now: aom-uat-app-1');
    expect(reuse.join('\n')).toContain('Backups folder /home/user/.config/aom-uat/backups: 4 files');
    const untouched = texts(items, 'untouched').join('\n');
    expect(untouched).toContain('Part "postgres"');
    expect(untouched).toContain('Part "mailpit"');
    expect(untouched).toContain('Container aom-uat-postgres-1');
    expect(untouched).toContain('Container dcode-flow-local-postgres-1');
    expect(untouched).toContain('Volume "pgdata"');
    expect(untouched).toContain('Volume "other_data"');
    expect(untouched).not.toContain('aom-uat-app-1');
    const each = texts(items, 'each_deploy');
    expect(each[0]).toMatch(/^Skip everything if this version is already running/);
    expect(each.join('\n')).toContain('Back up the database (postgres)');
    expect(each.join('\n')).toContain('Rebuild and restart only "app" on this computer');
    expect(each.at(-1)).toContain('put the previous version back');
    expect(hasBlockers(items)).toBe(false);
  });

  it('only the chosen environment is planned; every environment is planned without a filter', () => {
    const all = planChanges(setup(), { uat: uatReport() });
    expect(new Set(all.map((i) => i.env))).toEqual(new Set(['uat', 'production']));
    expect(planChanges(setup(), {}, 'production').every((i) => i.env === 'production')).toBe(true);
  });

  it('not checked yet is a question, not a guess', () => {
    const items = planChanges(setup(), {}, 'uat');
    expect(texts(items, 'question')[0]).toContain('has not been checked yet');
  });

  it('missing Docker and a missing compose file block the save', () => {
    const none = planChanges(
      setup(),
      { uat: report({ docker: { installed: false, usable: false } }) },
      'uat',
    );
    expect(texts(none, 'setup_once').join('\n')).toContain('Docker is not installed');
    expect(hasBlockers(none)).toBe(true);
    const noPerm = planChanges(
      setup(),
      { uat: report({ docker: { installed: true, usable: false } }) },
      'uat',
    );
    expect(texts(noPerm, 'setup_once').join('\n')).toContain('docker group');
    expect(texts(noPerm, 'setup_once').join('\n')).toContain(
      'compose file ~/.config/aom-uat/docker-compose.yml was not found',
    );
  });

  it('an unknown service is a question with the parts that exist', () => {
    const s = setup();
    (s.environments[0] as { app: { service: string } }).app.service = 'web';
    const items = planChanges(s, { uat: uatReport() }, 'uat');
    const q = texts(items, 'question').join('\n');
    expect(q).toContain(
      'Which part is your app? "web" is not in the compose file. Parts: postgres, app, mailpit.',
    );
  });

  it('the database service must exist in the compose file', () => {
    const s = setup();
    const step = (s.environments[0] as { steps: Array<{ kind: string; service?: string }> }).steps[0] as {
      service: string;
    };
    step.service = 'db';
    expect(texts(planChanges(s, { uat: uatReport() }, 'uat'), 'question').join('\n')).toContain(
      'Which part is the database? "db"',
    );
  });

  it('a server: the app folder, the image setting and the proxy are found; the proxy and other containers stay untouched', () => {
    const r = report({
      scope: 'ssh_target',
      host: 'prod-server',
      containers: [
        {
          name: 'guildwise-app-1',
          project: 'guildwise',
          service: 'app',
          image: 'guildwise-hq:4f2c1ab',
          state: 'running',
          ports: [],
        },
        {
          name: 'guildwise-postgres-1',
          project: 'guildwise',
          service: 'postgres',
          image: 'postgres:18',
          state: 'running',
          ports: [],
        },
        { name: 'caddy', image: 'caddy:2', state: 'running', ports: [] },
      ],
      composeFiles: [
        {
          path: '/opt/app/docker-compose.yml',
          project: 'guildwise',
          services: [
            { name: 'app', image: '${GUILDWISE_IMAGE}' },
            { name: 'postgres', image: 'postgres:18', database: 'postgres' },
          ],
          volumes: ['pgdata'],
        },
      ],
      folders: [
        {
          path: '/opt/app',
          exists: true,
          entries: ['docker-compose.yml', '.env', 'backups'],
          envKeys: ['GUILDWISE_IMAGE', 'DATABASE_URL'],
          imageVars: [{ name: 'GUILDWISE_IMAGE', value: 'guildwise-hq:4f2c1ab' }],
        },
      ],
      proxies: [{ kind: 'caddy', via: 'container', name: 'caddy', sites: ['hq.example.com'] }],
      backups: [{ dir: '/opt/app/backups', count: 9 }],
      urls: [{ url: 'https://hq.example.com/ready', status: 200 }],
      listeners: [80, 443],
    });
    const items = planChanges(setup(), { production: r }, 'production');
    const reuse = texts(items, 'reuse').join('\n');
    expect(reuse).toContain('Folder /opt/app on the server');
    expect(reuse).toContain('GUILDWISE_IMAGE now points at guildwise-hq:4f2c1ab');
    expect(reuse).toContain('https://hq.example.com/ready answers (200)');
    const untouched = texts(items, 'untouched').join('\n');
    expect(untouched).toContain('Caddy proxy (caddy) for hq.example.com is not touched');
    expect(untouched).toContain('Container caddy');
    expect(untouched).toContain('Container guildwise-postgres-1');
    expect(untouched).toContain('Ports 80 and 443');
    expect(texts(items, 'each_deploy').join('\n')).toContain('Copy the new app image to the server');
    expect(hasBlockers(items)).toBe(false);
  });

  it('a server folder or .env that does not exist is a blocker, not something Guildwise creates in v1', () => {
    const r = report({
      scope: 'ssh_target',
      folders: [{ path: '/opt/app', exists: false, entries: [] }],
    });
    expect(texts(planChanges(setup(), { production: r }, 'production'), 'setup_once').join('\n')).toContain(
      'The folder /opt/app does not exist',
    );
    const noEnv = report({
      scope: 'ssh_target',
      folders: [{ path: '/opt/app', exists: true, entries: [] }],
    });
    expect(
      texts(planChanges(setup(), { production: noEnv }, 'production'), 'setup_once').join('\n'),
    ).toContain('There is no settings file');
  });
});

describe('paths and probe schemas', () => {
  it('~ matches the probed home directory', () => {
    expect(samePath('/home/u/.config/x.yml', '~/.config/x.yml')).toBe(true);
    expect(samePath('/home/u/.config/x.yml', '/home/u/.config/x.yml')).toBe(true);
    expect(samePath('/home/u/.config/y.yml', '~/.config/x.yml')).toBe(false);
  });

  it('a probe result is a report or one of the fixed errors', () => {
    expect(DeployProbeResultSchema.safeParse({ ok: true, report: report() }).success).toBe(true);
    expect(DeployProbeResultSchema.safeParse({ ok: false, error: 'ssh_auth' }).success).toBe(true);
    expect(DeployProbeResultSchema.safeParse({ ok: false, error: 'whatever' }).success).toBe(false);
    expect(probeErrorText('ssh_host_key_changed', 'srv')).toContain('ssh-keygen -R srv');
    expect(probeErrorText('docker_permission')).toContain('docker group');
  });
});

describe('docker compose on the server (version 1 or 2)', () => {
  const run = (docker: object) => {
    const items = planChanges(
      { version: 1, generator: 'x', environments: [FIRST_ADOPTER().environments[1] as never] } as never,
      { production: report({ docker } as never) },
    );
    return items;
  };
  it('blocks when neither docker compose nor docker-compose exists', () => {
    const items = run({ installed: true, usable: true, version: '24' });
    expect(items.some((i) => i.group === 'setup_once' && i.ref === 'compose_tool')).toBe(true);
  });
  it('accepts the older docker-compose program and says so', () => {
    const items = run({ installed: true, usable: true, version: '24', composeVersion: '1.29.2' });
    expect(items.some((i) => i.group === 'setup_once' && i.ref === 'compose_tool')).toBe(false);
    expect(items.some((i) => i.ref === 'compose_tool' && i.text.includes('older docker-compose'))).toBe(true);
  });
});

describe('several checkouts with the same compose project', () => {
  const copy = (dir: string) => ({
    path: `/home/user/projects/${dir}/deploy/local/docker-compose.yml`,
    project: 'aom-uat',
    services: [{ name: 'app', build: '.' }],
    volumes: [],
  });
  const withRunning = (composeFile: string) =>
    report({
      containers: [
        {
          name: 'aom-uat-app-1',
          project: 'aom-uat',
          service: 'app',
          image: 'x',
          state: 'running',
          ports: [],
          composeFile,
        },
      ],
      composeFiles: [copy('p5-run-trial'), copy('mm-fixes-wt')],
    });
  const forFile = (file: string) => {
    const s = setup();
    const env = s.environments.find((e) => e.name === 'uat');
    if (!env) throw new Error('no uat');
    env.app.composeFile = file;
    env.app.service = 'app';
    env.app.composeProject = 'aom-uat';
    return s;
  };

  it('blocks a setup that points at another copy than the one that runs, naming the running file', () => {
    const running = copy('p5-run-trial').path;
    const items = planChanges(forFile(copy('mm-fixes-wt').path), { uat: withRunning(running) }, 'uat');
    const q = texts(items, 'question', 'uat').join('\n');
    expect(q).toContain(`running from ${running}`);
    expect(q).toContain(copy('mm-fixes-wt').path);
  });

  it('is quiet when the setup points at the running copy (also written with ~)', () => {
    const running = copy('p5-run-trial').path;
    for (const file of [running, running.replace('/home/user', '~')]) {
      const items = planChanges(forFile(file), { uat: withRunning(running) }, 'uat');
      expect(texts(items, 'question', 'uat').join('\n')).not.toContain('running from');
    }
  });
});

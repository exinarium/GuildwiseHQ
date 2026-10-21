import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compileSetup,
  directEnv,
  localAdoptEnv,
  type ProbeReport,
  parseSetup,
  planChanges,
} from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(here, 'fixtures', 'setup', 'direct');

function golden(name: string, actual: string): void {
  const file = join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
  }
  expect(existsSync(file), `missing golden file ${name}`).toBe(true);
  expect(actual).toBe(readFileSync(file, 'utf8'));
}

const common = { name: 'live', label: 'Live site', target: 'shop-box', appDir: '/home/shop/app' };
const cases = {
  'systemd-sudo-local': () =>
    directEnv({
      ...common,
      appDir: '~/app',
      manager: { kind: 'systemd', unit: 'shop.service', scope: 'system', sudo: true },
      build: [
        { label: 'Install', argv: ['npm', 'ci'] },
        { label: 'Build', argv: ['npm', 'run', 'build'] },
      ],
      shared: ['.env', 'uploads'],
      database: { engine: 'postgres', database: 'shop', dir: '~/app/backups' },
      healthUrl: 'http://127.0.0.1:3000/health',
    }),
  'systemd-user-ssh-adopt': () =>
    directEnv(
      {
        ...common,
        host: 'shop-box',
        currentLink: '/home/shop/shop',
        appDir: '/home/shop/shop-app',
        adoptFolder: true,
        manager: { kind: 'systemd', unit: 'shop', scope: 'user', sudo: false },
        build: [{ label: 'Install', argv: ['pip', 'install', '-r', 'requirements.txt'] }],
        shared: ['.env'],
        database: { engine: 'sqlite', sqliteFile: '/home/shop/shop/db.sqlite3', dir: '/home/shop/backups' },
        live: true,
        healthUrl: 'http://192.168.1.14:8000/ready',
      },
      'test',
    ),
  'pm2-ssh': () =>
    directEnv(
      {
        ...common,
        host: 'shop-box',
        manager: { kind: 'pm2', name: 'shop-api' },
        build: [{ label: 'Install', argv: ['npm', 'ci', '--omit=dev'] }],
        appUrl: 'http://shop.example.com',
        live: true,
      },
      'test',
    ),
  'command-local': () =>
    directEnv({
      ...common,
      appDir: '~/app',
      manager: { kind: 'command', restart: ['/usr/local/bin/restart-shop', '--quick'], sudo: false },
      healthUrl: 'http://127.0.0.1:3000/health',
    }),
} as const;

const compile = (env: unknown) => {
  const r = compileSetup({ environments: [env] });
  if (!r.ok) throw new Error(r.issues.join('; '));
  return (r.files.find((f) => f.path === 'scripts/live.sh') as { content: string }).content;
};

describe('apps that run directly on the machine (golden files)', () => {
  it.each(Object.keys(cases))(
    '%s: byte-exact, valid bash, only the app is restarted, nothing is deleted but old releases',
    (k) => {
      const c = compile(cases[k as keyof typeof cases]());
      golden(`${k}.sh`, c);
      expect(spawnSync('bash', ['-n'], { input: c, encoding: 'utf8' }).status).toBe(0);
      expect(c).not.toMatch(
        /\b(systemctl|pm2)\b[^\n]*\b(stop|kill|delete|disable|mask)\b|--remove-orphans|docker (rm|stop|kill)\b/,
      );
      // every deletion: the temporary link, a failed backup's partial file, old backups, old releases
      for (const line of c.split('\n').filter((l) => /\brm\b/.test(l)))
        expect(line).toMatch(
          /rm -f -- "\$tmp"|rm -f -- "\$out\.part"|rm -f -- "\$old"|rm -rf -- "\$app\/releases\/\$old"|rm -rf -- "\$\{rel:\?\}\/\$p"|rm -f -- "\$link"|rm -f -- "\$2\.aom-part"|rm -f -- "\$app\/shared\/\$p/,
        );
      expect(c).toContain('trap on_exit EXIT');
      expect(c).toContain('AOM_DEPLOY_DRY_RUN');
      for (const part of c.split(/\n# step \d+: /).slice(1))
        expect(part.split('\n# the end')[0], part.slice(0, 60)).toMatch(/DRY_RUN|dry/);
    },
  );

  it('sudo is used only when confirmed, and only without a prompt', () => {
    const sudo = compile(cases['systemd-sudo-local']());
    expect(sudo).toContain('USE_SUDO=1');
    expect(sudo).toContain('sudo -n');
    expect(compile(cases['systemd-user-ssh-adopt']())).toContain('USE_SUDO=0');
    expect(compile(cases['pm2-ssh']())).toContain('USE_SUDO=0');
  });

  it('rollback points the link back at the previous folder and restarts, and says the database was not rolled back', () => {
    const c = compile(cases['pm2-ssh']());
    expect(c).toContain('set_link "$PREVIOUS_TARGET" || return 1');
    expect(c).toContain('restart_app 0 || return 1');
    expect(c).toContain('the database was NOT rolled back');
  });

  it('wrong shapes are refused in plain words', () => {
    const e = cases['pm2-ssh']();
    const noSwitch = { ...e, steps: e.steps.filter((s) => s.kind !== 'direct_switch') };
    const r = compileSetup({ environments: [noSwitch] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toContain('direct_switch');
    const docker = { ...e, steps: [{ kind: 'compose_up_remote' }, ...e.steps] };
    expect(compileSetup({ environments: [docker] }).ok).toBe(false);
    const relative = { ...e, direct: { ...(e.direct as object), appDir: '~/app' } };
    expect(parseSetup({ environments: [relative] }).ok).toBe(false);
    const userSudo = {
      ...e,
      direct: { ...(e.direct as object), manager: { kind: 'systemd', unit: 'x', scope: 'user', sudo: true } },
    };
    expect(parseSetup({ environments: [userSudo] }).ok).toBe(false);
    const missing = { ...e, direct: undefined };
    expect(parseSetup({ environments: [missing] }).ok).toBe(false);
  });

  it('M1: pm2 names that would restart everything or mean a process number are refused', () => {
    const e = cases['pm2-ssh']();
    const withName = (name: string) => ({
      ...e,
      direct: { ...(e.direct as object), manager: { kind: 'pm2', name } },
    });
    for (const bad of ['all', 'ALL', 'All', '0', '12'])
      expect(parseSetup({ environments: [withName(bad)] }).ok, bad).toBe(false);
    for (const good of ['shop-api', 'all-shop', 'api2', 'a1'])
      expect(parseSetup({ environments: [withName(good)] }).ok, good).toBe(true);
  });

  it('m6: no option as the program, and no unit that is not an app', () => {
    const e = cases['command-local']();
    const withManager = (manager: unknown) => ({ ...e, direct: { ...(e.direct as object), manager } });
    expect(
      parseSetup({ environments: [withManager({ kind: 'command', restart: ['-x', 'a'], sudo: false })] }).ok,
    ).toBe(false);
    const build = { ...e, direct: { ...(e.direct as object), build: [{ label: 'x', argv: ['--version'] }] } };
    expect(parseSetup({ environments: [build] }).ok).toBe(false);
    for (const unit of [
      'multi-user.target',
      'x.slice',
      'dbus.socket',
      'home.mount',
      'sda.device',
      'docker',
      'docker.service',
      'containerd.service',
      'sshd.service',
      'ssh',
      'systemd-logind.service',
      'Systemd-resolved',
    ])
      expect(
        parseSetup({ environments: [withManager({ kind: 'systemd', unit, scope: 'system', sudo: false })] })
          .ok,
        unit,
      ).toBe(false);
    for (const unit of ['shop.service', 'shop', 'dockerized-shop.service', 'my-systemd-app'])
      expect(
        parseSetup({ environments: [withManager({ kind: 'systemd', unit, scope: 'system', sudo: false })] })
          .ok,
        unit,
      ).toBe(true);
  });

  it('m4: a postgres or mysql backup must name the database', () => {
    const e = cases['systemd-sudo-local']();
    const step = (s: object) => ({
      ...e,
      steps: e.steps.map((x) => (x.kind === 'direct_db_backup' ? { ...x, ...s } : x)),
    });
    expect(parseSetup({ environments: [step({ database: undefined })] }).ok).toBe(false);
    expect(parseSetup({ environments: [step({ engine: 'mysql', database: undefined })] }).ok).toBe(false);
    expect(parseSetup({ environments: [step({ database: 'shop' })] }).ok).toBe(true);
    expect(
      parseSetup({
        environments: [step({ engine: 'sqlite', database: undefined, sqliteFile: '/home/shop/x.db' })],
      }).ok,
    ).toBe(true);
  });

  it('what Guildwise found and what it will not touch is listed for the review', () => {
    const env = cases['systemd-user-ssh-adopt']();
    const report = {
      scope: 'ssh_target',
      at: new Date().toISOString(),
      host: 'shop-box',
      containers: [{ name: 'portainer', image: 'portainer/portainer-ce', state: 'running', ports: [] }],
      composeFiles: [],
      volumes: [],
      folders: [{ path: '/home/shop/shop-app', exists: true, entries: ['releases', 'current'] }],
      backups: [],
      proxies: [],
      urls: [],
      listeners: [],
      services: [
        {
          manager: 'systemd_user',
          name: 'shop.service',
          state: 'running',
          workingDir: '/home/shop/shop',
          ports: [8000],
        },
        { manager: 'systemd', name: 'nginx.service', state: 'running', ports: [80] },
      ],
    } as unknown as ProbeReport;
    const items = planChanges({ version: 1, generator: 'x', environments: [env] } as never, { live: report });
    const text = items.map((i) => `${i.group}: ${i.text}`).join('\n');
    expect(text).toContain('reuse: The service "shop" is running');
    expect(text).toContain('untouched: nginx.service');
    expect(text).toContain('untouched: Container portainer');
    expect(text).toContain('each_deploy: /home/shop/shop is a plain folder');
    expect(text).toContain('each_deploy: Point "current" at the new folder');
  });

  it('M2a: data in the plain folder that is not marked shared blocks the save until it is; M12: the restart note', () => {
    const base = cases['systemd-user-ssh-adopt']();
    const report = {
      scope: 'ssh_target',
      at: new Date().toISOString(),
      containers: [],
      composeFiles: [],
      volumes: [],
      folders: [],
      backups: [],
      proxies: [],
      urls: [],
      listeners: [],
      services: [
        {
          manager: 'systemd_user',
          name: 'shop.service',
          state: 'running',
          workingDir: '/home/shop/shop',
          ports: [8000],
          statePaths: ['.env', 'uploads', 'db.sqlite3'],
        },
      ],
    } as unknown as ProbeReport;
    const plan = (env: unknown) =>
      planChanges({ version: 1, generator: 'x', environments: [env] } as never, { live: report });
    const blockers = (env: unknown) => plan(env).filter((i) => i.group === 'setup_once');
    expect(blockers(base).map((i) => i.text)).toEqual([expect.stringContaining('uploads, db.sqlite3')]);
    const marked = {
      ...base,
      direct: { ...(base.direct as { shared: string[] }), shared: ['.env', 'uploads', 'db.sqlite3'] },
    };
    expect(blockers(marked)).toEqual([]);
    const cmd = cases['command-local']();
    expect(
      planChanges({ version: 1, generator: 'x', environments: [cmd] } as never, { live: report })
        .map((i) => i.text)
        .join('\n'),
    ).toContain('judges the new version by the health check only');
  });

  it('M3: a compose app whose running stack is not supported yet blocks the save, with the reason', () => {
    const env = directEnvLike();
    const report = {
      scope: 'local',
      at: new Date().toISOString(),
      docker: { installed: true, usable: true, composeVersion: '2.40.0' },
      containers: [],
      composeFiles: [
        {
          path: env.app.composeFile,
          services: [{ name: env.app.service, ports: [], volumes: [], envFiles: [], vars: [] }],
          volumes: [],
          unsupported: 'It was started from several compose files. This is not supported yet.',
        },
      ],
      volumes: [],
      folders: [],
      backups: [],
      proxies: [],
      urls: [],
      listeners: [],
    } as unknown as ProbeReport;
    const items = planChanges({ version: 1, generator: 'x', environments: [env] } as never, { uat: report });
    const block = items.filter((i) => i.group === 'setup_once');
    expect(block).toHaveLength(1);
    expect(block[0]?.text).toContain('several compose files');
    expect(block[0]?.text).toContain('cannot be updated by Guildwise yet');
  });
});

function directEnvLike() {
  return localAdoptEnv({
    name: 'uat',
    label: 'Test copy',
    target: 'aom-uat',
    composeFile: '/home/u/uat/docker-compose.yml',
    service: 'app',
    imageName: 'aom-uat-app',
    appUrl: 'http://localhost:4700',
  });
}

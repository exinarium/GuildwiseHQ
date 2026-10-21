import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileSetup, directEnv, parseSetup, planChanges, type ProbeReport } from '../src/index.ts';

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
      build: [{ label: 'Install', argv: ['npm', 'ci'] }, { label: 'Build', argv: ['npm', 'run', 'build'] }],
      shared: ['.env', 'uploads'],
      database: { engine: 'postgres', database: 'shop', dir: '~/app/backups' },
      healthUrl: 'http://127.0.0.1:3000/health',
    }),
  'systemd-user-ssh-adopt': () =>
    directEnv({
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
    }, 'test'),
  'pm2-ssh': () =>
    directEnv({
      ...common,
      host: 'shop-box',
      manager: { kind: 'pm2', name: 'shop-api' },
      build: [{ label: 'Install', argv: ['npm', 'ci', '--omit=dev'] }],
      appUrl: 'http://shop.example.com',
      live: true,
    }, 'test'),
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
  it.each(Object.keys(cases))('%s: byte-exact, valid bash, only the app is restarted, nothing is deleted but old releases', (k) => {
    const c = compile(cases[k as keyof typeof cases]());
    golden(`${k}.sh`, c);
    expect(spawnSync('bash', ['-n'], { input: c, encoding: 'utf8' }).status).toBe(0);
    expect(c).not.toMatch(/\b(systemctl|pm2)\b[^\n]*\b(stop|kill|delete|disable|mask)\b|--remove-orphans|docker (rm|stop|kill)\b/);
    // every deletion: the temporary link, a failed backup's partial file, old backups, old releases
    for (const line of c.split('\n').filter((l) => /\brm\b/.test(l)))
      expect(line).toMatch(
        /rm -f -- "\$tmp"|rm -f -- "\$out\.part"|rm -f -- "\$old"|rm -rf -- "\$p"|rm -rf -- "\$\{rel:\?\}\/\$p"/,
      );
    expect(c).toContain('trap on_exit EXIT');
    expect(c).toContain('AOM_DEPLOY_DRY_RUN');
    for (const part of c.split(/\n# step \d+: /).slice(1))
      expect(part.split('\n# the end')[0], part.slice(0, 60)).toMatch(/DRY_RUN|dry/);
  });

  it('sudo is used only when confirmed, and only without a prompt', () => {
    const sudo = compile(cases['systemd-sudo-local']());
    expect(sudo).toContain('USE_SUDO=1');
    expect(sudo).toContain('sudo -n');
    expect(compile(cases['systemd-user-ssh-adopt']())).toContain('USE_SUDO=0');
    expect(compile(cases['pm2-ssh']())).toContain('USE_SUDO=0');
  });

  it('rollback points the link back at the previous folder and restarts, and says the database was not rolled back', () => {
    const c = compile(cases['pm2-ssh']());
    expect(c).toContain('set_link "$PREVIOUS_TARGET" && restart_app 0');
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
        { manager: 'systemd_user', name: 'shop.service', state: 'running', workingDir: '/home/shop/shop', ports: [8000] },
        { manager: 'systemd', name: 'nginx.service', state: 'running', ports: [80] },
      ],
    } as unknown as ProbeReport;
    const items = planChanges({ version: 1, generator: 'x', environments: [env] } as never, { live: report });
    const text = items.map((i) => `${i.group}: ${i.text}`).join('\n');
    expect(text).toContain('reuse: The service "shop" is running');
    expect(text).toContain('untouched: nginx.service');
    expect(text).toContain('untouched: Container portainer');
    expect(text).toContain('setup_once: /home/shop/shop is a plain folder');
    expect(text).toContain('each_deploy: Point "current" at the new folder');
  });
});

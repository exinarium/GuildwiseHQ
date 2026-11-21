import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: the root tool is plain CommonJS (it may not import the runner tree)
export const admin: any = require('../../admin/guildwise-admin.cjs');
export const ADMIN_FILE = join(import.meta.dirname, '../../admin/guildwise-admin.cjs');

export interface FakeUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
  groups?: string[];
}

export interface Call {
  cmd: string;
  args: string[];
  input?: string;
}

type Result = { code: number; stdout: string; stderr: string };

/**
 * A pretend machine for the root tool: system paths live under a temp `root`, users and groups are a table, commands are
 * recorded (and answered by `handle`), chown is a no-op. Nothing needs real root, real users or real system files.
 */
export function fakeSystem(
  opts: {
    platform?: 'linux' | 'darwin';
    users?: FakeUser[];
    groups?: Record<string, number>;
    env?: Record<string, string>;
    handle?: (c: Call, sys: FakeSys) => Result | undefined;
    alive?: number[];
    answers?: string[];
    git?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'gw-admin-'));
  const users = new Map((opts.users ?? []).map((u) => [u.name, { groups: [], ...u }]));
  const groups = new Map(Object.entries(opts.groups ?? {}));
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const ok = (stdout = ''): Result => ({ code: 0, stdout, stderr: '' });
  const sys: FakeSys = {
    platform: opts.platform ?? 'linux',
    root,
    execPath: admin.NODE_PATH,
    uid: () => 0,
    env: opts.env ?? { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    now: () => new Date(),
    dryRun: false,
    ownerAliases: [process.getuid?.() ?? 0],
    rootUid: process.getuid?.() ?? 0,
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    chown: () => {},
    fchown: () => {},
    pidAlive: (pid: number) => (opts.alive ?? []).includes(pid),
    ask: async () => answers.shift() ?? 'y',
    run(cmd: string, args: string[], o: { input?: string } = {}) {
      const c: Call = { cmd, args, ...(o.input !== undefined ? { input: o.input } : {}) };
      calls.push(c);
      const custom = opts.handle?.(c, sys);
      if (custom) return custom;
      if (cmd === 'getent' && args[0] === 'passwd') {
        const u = users.get(args[1] as string);
        return u
          ? ok(`${u.name}:x:${u.uid}:${u.gid}::${u.home}:/usr/sbin/nologin\n`)
          : { code: 2, stdout: '', stderr: '' };
      }
      if (cmd === 'getent' && args[0] === 'group') {
        const g = groups.get(args[1] as string);
        return g === undefined ? { code: 2, stdout: '', stderr: '' } : ok(`${args[1]}:x:${g}:\n`);
      }
      if (cmd === 'groupadd') {
        groups.set(args[args.length - 1] as string, 985);
        return ok();
      }
      if (cmd === 'id') {
        const u = users.get(args[1] as string);
        return u ? ok(`${[u.name, ...(u.groups ?? [])].join(' ')}\n`) : { code: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'gpasswd' && args[0] === '-d') {
        const u = users.get(args[1] as string);
        if (u) u.groups = (u.groups ?? []).filter((g) => g !== args[2]);
        return ok();
      }
      if (cmd === 'usermod' && args[0] === '-aG') {
        const u = users.get(args[2] as string);
        if (u) u.groups = [...(u.groups ?? []), args[1] as string];
        return ok();
      }
      if (cmd === 'useradd') {
        const name = args[args.length - 1] as string;
        const home = `/home/${name}`;
        users.set(name, { name, uid: 990, gid: 990, home, groups: [] });
        mkdirSync(join(root, home), { recursive: true });
        return ok();
      }
      if (cmd === 'visudo') {
        const r = spawnSync('visudo', args, { encoding: 'utf8' });
        return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      }
      if (cmd === 'git') return ok(`${opts.git ?? 'git version 2.53.0'}\n`);
      // `runuser -u <user> -- rm -rf -- <path>`: the removal as that user
      if (cmd === 'runuser' && args.includes('rm')) {
        rmSync(args[args.length - 1] as string, { recursive: true, force: true });
        return ok();
      }
      return ok();
    },
  };
  return { sys, root, calls, out, err, users, groups };
}

export interface FakeSys {
  platform: string;
  root: string;
  execPath: string;
  uid: () => number;
  env: Record<string, string>;
  now: () => Date;
  dryRun: boolean;
  ownerAliases: number[];
  rootUid: number;
  out: (l: string) => void;
  err: (l: string) => void;
  chown: (...a: unknown[]) => void;
  fchown: (...a: unknown[]) => void;
  pidAlive: (pid: number) => boolean;
  ask: (q: string) => Promise<string>;
  run: (cmd: string, args: string[], o?: { input?: string }) => Result;
}

export const RUNNER: FakeUser = {
  name: 'guildwise-runner',
  uid: 990,
  gid: 990,
  home: '/home/guildwise-runner',
};
export const ALICE: FakeUser = { name: 'alice', uid: 1000, gid: 1000, home: '/home/alice' };

import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { readPassword } from '../scripts/read-password.ts';
import { verifyPassword } from '../src/auth/password.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

/** R13: the account CLIs take the password on standard input, so it stays out of the process list and shell history. */
afterAll(async () => {
  await closeAdminPool();
});

describe('readPassword', () => {
  const never = async () => {
    throw new Error('must not prompt');
  };

  it('--password-stdin reads standard input and drops one trailing newline', async () => {
    const warn: string[] = [];
    const pw = await readPassword(
      { passwordStdin: true, password: 'ignored-flag', prompt: 'x' },
      { stdin: Readable.from(['a-long-', 'stdin-password\n']), warn: (m) => warn.push(m), ask: never },
    );
    expect(pw).toBe('a-long-stdin-password');
    expect(warn).toEqual([]);
    expect(
      await readPassword(
        { passwordStdin: true, prompt: 'x' },
        { stdin: Readable.from(['with spaces \r\n']) },
      ),
    ).toBe('with spaces ');
  });

  it('--password still works but warns; then AOM_ADMIN_PASSWORD; then the prompt', async () => {
    const warn: string[] = [];
    expect(
      await readPassword({ password: 'p-flag', prompt: 'x' }, { warn: (m) => warn.push(m), ask: never }),
    ).toBe('p-flag');
    expect(warn.join('')).toMatch(/--password-stdin/);
    expect(await readPassword({ prompt: 'x' }, { env: { AOM_ADMIN_PASSWORD: 'p-env' }, ask: never })).toBe(
      'p-env',
    );
    expect(await readPassword({ prompt: 'Password: ' }, { env: {}, ask: async (qq) => `asked ${qq}` })).toBe(
      'asked Password: ',
    );
  });
});

describe('superadmin:create --password-stdin', () => {
  const run = (args: string[], input: string) =>
    spawnSync('npx', ['tsx', 'scripts/superadmin-create.ts', ...args], {
      input,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL as string, AOM_ADMIN_PASSWORD: '' },
      timeout: 90_000,
    });

  it('creates the account with the password from standard input', async () => {
    const email = uniqueEmail('cli-root');
    const pw = 'stdin-only-password-123';
    const r = run(['--email', email, '--name', 'Cli Root', '--password-stdin'], `${pw}\n`);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(pw);
    const u = (await q(`SELECT password_hash, kind FROM users WHERE lower(email)=lower($1)`, [email]))[0];
    expect(u?.kind).toBe('super_admin');
    expect(await verifyPassword(u?.password_hash, pw)).toBe(true);
  });

  it('refuses --password-stdin without --email and --name', () => {
    const r = run(['--password-stdin'], 'whatever-password-1\n');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--password-stdin needs --email and --name/);
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShiftBrief, ShiftReport } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { issueShiftCredential, resolveShiftEnv, SHIFT_ENV_POINTER } from '../src/session/shift-credential.ts';
import { makeShiftStart } from './fixtures.ts';

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const brief = (makeShiftStart({ remoteNormalized: 'x' }) as { brief: ShiftBrief }).brief;

/** What Claude Code's subprocess scrub does to a Bash child: credential-named variables are gone. */
const scrub = (env: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(([k]) => !/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH/i.test(k)),
  );

async function setup() {
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const reports: ShiftReport[] = [];
  const cred = issueShiftCredential(
    { ipc, runnerRoot: mkdtempSync(join(tmpdir(), 'aom-cli-senv-')) },
    {
      sessionId: 'shift-1',
      handler: {
        report: async (r) => {
          reports.push(r.report);
          return { accepted: true, message: 'Recorded.' };
        },
        rpc: async (r) =>
          r.method === 'card.get' ? { ok: true, result: brief } : { ok: true, result: 'found it' },
      },
    },
  );
  const out: string[] = [];
  const err: string[] = [];
  const ctx = (env: Record<string, string | undefined>, extra: Partial<AomContext> = {}): AomContext => ({
    env,
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    fetch,
    readFile: () => {
      throw new Error('ENOENT');
    },
    ...extra,
  });
  return { ipc, cred, reports, out, err, ctx };
}

describe('aom with the subprocess scrub on', () => {
  it('card and the terminal report work through AOM_SHIFT_ENV_FILE once the token is scrubbed', async () => {
    const t = await setup();
    const scrubbed = scrub(t.cred.env);
    expect(scrubbed.AOM_SHIFT_TOKEN).toBeUndefined();
    const { env, attempts } = resolveShiftEnv(scrubbed);
    expect(await runAom(['card'], t.ctx(env, { shiftEnvAttempts: attempts }))).toBe(0);
    expect(
      await runAom(
        ['handoff', '--note', 'done', '--no-evidence', 'docs only'],
        t.ctx(env, { shiftEnvAttempts: attempts }),
      ),
    ).toBe(0);
    expect(t.reports).toHaveLength(1);
    // the token never shows up in what aom printed
    expect([...t.out, ...t.err].join('')).not.toContain(t.cred.token);
  });

  it('with the token in the environment (scrub off) the file is not needed', async () => {
    const t2 = await setup();
    const env = { ...t2.cred.env, [SHIFT_ENV_POINTER]: '/nowhere/env.json' };
    const resolved = resolveShiftEnv(env, () => {
      throw new Error('must not read');
    });
    expect(resolved.attempts).toEqual([]);
    expect(await runAom(['card'], t2.ctx(resolved.env))).toBe(0);
  });

  it('nothing gives a token: exit non-zero naming the pointer variable and the path tried', async () => {
    const t = await setup();
    const file = t.cred.file as string;
    t.cred.revoke();
    const scrubbed = scrub(t.cred.env);
    const { env, attempts } = resolveShiftEnv(scrubbed);
    expect(await runAom(['card'], t.ctx(env, { shiftEnvAttempts: attempts }))).not.toBe(0);
    const msg = t.err.join('');
    expect(msg).toContain(SHIFT_ENV_POINTER);
    expect(msg).toContain(file);
    expect(msg).not.toContain(t.cred.token);
  });

  it('without the pointer the error names both variables', async () => {
    const t = await setup();
    expect(await runAom(['card'], t.ctx({ AOM_IPC_URL: t.ipc.url }))).toBe(1);
    expect(t.err.join('')).toContain(`AOM_SHIFT_TOKEN and ${SHIFT_ENV_POINTER} are not set`);
  });
});

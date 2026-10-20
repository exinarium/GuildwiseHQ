import { describe, expect, it } from 'vitest';
import {
  AccountKeySchema,
  type AccountRuntimeView,
  accountUsable,
  anyAccountUsable,
  CLAUDE_ACCOUNTS_CAPABILITY,
  ClaudeAccountEnsurePayloadSchema,
  ClaudeAccountInfoSchema,
  ClaudeAccountKeySchema,
  CommandPayloadSchemas,
  checkIntegrationRequest,
  INTEGRATION_KINDS,
  MAIN_ACCOUNT,
  PROTOCOL_VERSION,
  ProjectDtoSchema,
  RESUME_STATES,
  RunnerCommandNameSchema,
  RuntimeInfoSchema,
  resolveShiftAccount,
  ShiftRejectedSchema,
  ShiftStartSchema,
  validIntegrationInstance,
} from '../src/index.ts';

const now = new Date('2026-01-01T12:00:00Z');
const future = '2026-01-01T18:00:00.000Z';
const past = '2026-01-01T08:00:00.000Z';

type State = 'ok' | 'limited' | 'expired' | 'none' | 'missing';
function acct(key: string, state: Exclude<State, 'missing'>) {
  return ClaudeAccountInfoSchema.parse({
    key,
    main: key === 'main',
    source: 'config_dir',
    login: state === 'expired' ? 'expired' : state === 'none' ? 'none' : 'ok',
    usage: state === 'limited' ? 'limited' : 'ok',
    ...(state === 'limited' ? { limitedUntil: future } : {}),
  });
}
function runtime(project: State, main: State): AccountRuntimeView {
  const accounts = [acct('main', main === 'missing' ? 'ok' : main)];
  if (project !== 'missing') accounts.push(acct('work', project));
  return { available: true, accounts };
}
const STATES: State[] = ['ok', 'limited', 'expired', 'none', 'missing'];

describe('resolveShiftAccount truth table', () => {
  for (const project of STATES) {
    for (const main of ['ok', 'limited', 'expired'] as const) {
      for (const fallbackToMain of [false, true]) {
        const name = `project ${project}, main ${main}, fallback ${fallbackToMain}`;
        it(name, () => {
          const got = resolveShiftAccount(
            { accountKey: 'work', fallbackToMain },
            runtime(project, main),
            now,
          );
          if (project === 'ok') expect(got).toEqual({ key: 'work', viaFallback: false });
          else if (fallbackToMain && main === 'ok') expect(got).toEqual({ key: 'main', viaFallback: true });
          else expect(got).toBeNull();
        });
      }
    }
  }

  it('no project / no account / main key: main if usable, else null (fallback irrelevant)', () => {
    for (const main of ['ok', 'limited', 'expired', 'none'] as const) {
      const rt = runtime('ok', main);
      const want = main === 'ok' ? { key: 'main', viaFallback: false } : null;
      expect(resolveShiftAccount(null, rt, now)).toEqual(want);
      expect(resolveShiftAccount(undefined, rt, now)).toEqual(want);
      expect(resolveShiftAccount({ accountKey: null, fallbackToMain: true }, rt, now)).toEqual(want);
      expect(resolveShiftAccount({ accountKey: 'main', fallbackToMain: false }, rt, now)).toEqual(want);
    }
  });

  it('an unknown runtime or an unavailable one resolves to null', () => {
    expect(resolveShiftAccount(null, undefined, now)).toBeNull();
    expect(resolveShiftAccount({ accountKey: 'work', fallbackToMain: true }, undefined, now)).toBeNull();
    expect(resolveShiftAccount(null, { available: false }, now)).toBeNull();
  });

  it('a limit whose reset time has passed no longer counts', () => {
    const rt: AccountRuntimeView = {
      available: true,
      accounts: [acct('main', 'ok'), { ...acct('work', 'limited'), limitedUntil: past }],
    };
    expect(resolveShiftAccount({ accountKey: 'work', fallbackToMain: false }, rt, now)).toEqual({
      key: 'work',
      viaFallback: false,
    });
  });

  describe('shift kinds tied to a ticket (D2)', () => {
    const project = { accountKey: 'work', fallbackToMain: false };
    const rt = runtime('ok', 'ok');
    const ticketBound = ['card', 'question (card_id)', 'ba_task (card_id)'];
    const notBound = ['ceo', 'devops', 'chat', 'question (no card)', 'ba_task (no card)'];
    it.each(ticketBound)('%s uses the project account', () => {
      expect(resolveShiftAccount(project, rt, now)?.key).toBe('work');
    });
    it.each(notBound)('%s passes no project and runs on main', () => {
      expect(resolveShiftAccount(null, rt, now)?.key).toBe('main');
    });
  });
});

describe('legacy runtimes (no accounts[])', () => {
  it('main follows available / auth / usage / limitedUntil', () => {
    expect(accountUsable({ available: true }, 'main', now)).toBe(true);
    expect(accountUsable({ available: false }, 'main', now)).toBe(false);
    expect(accountUsable({ available: true, auth: 'expired' }, 'main', now)).toBe(false);
    expect(accountUsable({ available: true, usage: 'limited', limitedUntil: future }, 'main', now)).toBe(
      false,
    );
    expect(accountUsable({ available: true, usage: 'limited', limitedUntil: past }, 'main', now)).toBe(true);
    expect(accountUsable({ available: true, usage: 'limited' }, 'main', now)).toBe(true);
  });
  it('knows no other account', () => {
    expect(accountUsable({ available: true }, 'work', now)).toBe(false);
    expect(
      resolveShiftAccount({ accountKey: 'work', fallbackToMain: false }, { available: true }, now),
    ).toBeNull();
    expect(
      resolveShiftAccount({ accountKey: 'work', fallbackToMain: true }, { available: true }, now),
    ).toEqual({
      key: 'main',
      viaFallback: true,
    });
  });
});

describe('anyAccountUsable', () => {
  it('is true when only an additional account is usable', () => {
    expect(anyAccountUsable(runtime('ok', 'limited'), now)).toBe(true);
  });
  it('is false when every account is out or the runtime is unavailable', () => {
    expect(anyAccountUsable(runtime('expired', 'limited'), now)).toBe(false);
    expect(anyAccountUsable({ ...runtime('ok', 'ok'), available: false }, now)).toBe(false);
    expect(anyAccountUsable(undefined, now)).toBe(false);
  });
  it('legacy: main only', () => {
    expect(anyAccountUsable({ available: true }, now)).toBe(true);
    expect(anyAccountUsable({ available: true, auth: 'expired' }, now)).toBe(false);
  });
});

describe('account keys', () => {
  it('accepts lowercase keys up to 32 chars', () => {
    for (const k of ['work', 'a', 'client-2', 'a'.repeat(32)]) {
      expect(AccountKeySchema.safeParse(k).success).toBe(true);
      expect(ClaudeAccountKeySchema.safeParse(k).success).toBe(true);
    }
  });
  it('rejects bad shapes', () => {
    for (const k of ['', 'Work', '1abc', '-a', 'a_b', 'a b', 'a'.repeat(33), 'a/b', '../x']) {
      expect(AccountKeySchema.safeParse(k).success).toBe(false);
    }
  });
  it("reserves 'main' for ClaudeAccountKeySchema only", () => {
    expect(MAIN_ACCOUNT).toBe('main');
    expect(AccountKeySchema.safeParse('main').success).toBe(true);
    expect(ClaudeAccountKeySchema.safeParse('main').success).toBe(false);
  });
});

describe('protocol additions', () => {
  it('capability and resume state', () => {
    expect(CLAUDE_ACCOUNTS_CAPABILITY).toBe('claude-accounts:1');
    expect(RESUME_STATES).toContain('fresh_other_account');
  });
  it('claude.account.ensure is a command with a typed payload', () => {
    expect(RunnerCommandNameSchema.safeParse('claude.account.ensure').success).toBe(true);
    expect(CommandPayloadSchemas['claude.account.ensure']).toBe(ClaudeAccountEnsurePayloadSchema);
    expect(ClaudeAccountEnsurePayloadSchema.safeParse({ key: 'work' }).success).toBe(true);
    expect(ClaudeAccountEnsurePayloadSchema.safeParse({ key: 'main' }).success).toBe(false);
  });
  it('RuntimeInfo accepts accounts (max 20) and old payloads without', () => {
    const base = { id: 'claude-code', version: '1', available: true, capabilities: [] };
    expect(RuntimeInfoSchema.safeParse(base).success).toBe(true);
    expect(RuntimeInfoSchema.safeParse({ ...base, accounts: [acct('main', 'ok')] }).success).toBe(true);
    expect(
      RuntimeInfoSchema.safeParse({ ...base, accounts: Array(21).fill(acct('main', 'ok')) }).success,
    ).toBe(false);
  });
  it('shift.rejected accepts accountKey, and parses without', () => {
    const base = {
      v: PROTOCOL_VERSION,
      id: 'm1',
      ts: now.toISOString(),
      type: 'shift.rejected',
      shiftId: crypto.randomUUID(),
      reason: 'usage_limited',
    };
    expect(ShiftRejectedSchema.safeParse(base).success).toBe(true);
    expect(ShiftRejectedSchema.safeParse({ ...base, accountKey: 'work' }).success).toBe(true);
    expect(ShiftRejectedSchema.safeParse({ ...base, accountKey: 'Bad' }).success).toBe(false);
  });
  it('shift.start has an optional account', () => {
    expect(ShiftStartSchema.shape.account.safeParse(undefined).success).toBe(true);
    expect(ShiftStartSchema.shape.account.safeParse({ key: 'work' }).success).toBe(true);
    expect(ShiftStartSchema.shape.account.safeParse({ key: 'Work' }).success).toBe(false);
  });
});

describe('API additions are optional', () => {
  it('ProjectDto fields claudeAccount and usageLimit.accountKey/mode are optional', () => {
    const shape = ProjectDtoSchema.shape;
    expect(shape.claudeAccount.safeParse(undefined).success).toBe(true);
    expect(shape.claudeAccount.safeParse({ key: null, fallbackToMain: false }).success).toBe(true);
    expect(shape.claudeAccount.safeParse({ key: 'main', fallbackToMain: false }).success).toBe(false);
    const old = { until: future, workstationName: 'ws', label: null };
    expect(shape.usageLimit.safeParse(old).success).toBe(true);
    expect(shape.usageLimit.safeParse({ ...old, accountKey: 'work', mode: 'fallback' }).success).toBe(true);
    expect(shape.usageLimit.safeParse({ ...old, mode: 'other' }).success).toBe(false);
  });
});

describe('integrations registry', () => {
  const kind = INTEGRATION_KINDS.find((k) => k.id === 'claude-code');
  it('claude-code is per account, with claude_login first and machine-scoped', () => {
    expect(kind?.instances).toMatchObject({ by: 'account', placeholder: 'work', defaultInstance: '' });
    expect(kind?.methods[0]?.id).toBe('claude_login');
    expect(kind?.machineMethods).toContain('claude_login');
    expect(kind?.minRunnerForInstance).toBe('0.1.33');
    expect(kind?.minRunner).not.toBe('0.1.33');
  });
  it('instances: main (empty) or an account key', () => {
    if (!kind) throw new Error('missing kind');
    expect(validIntegrationInstance(kind, '')).toBe(true);
    expect(validIntegrationInstance(kind, 'work')).toBe(true);
    expect(validIntegrationInstance(kind, 'Work!')).toBe(false);
  });
  it('claude_login needs a non-empty instance', () => {
    expect(checkIntegrationRequest('claude-code', 'work', 'claude_login', 'interactive')).toBeNull();
    expect(checkIntegrationRequest('claude-code', '', 'claude_login', 'interactive')).not.toBeNull();
    expect(checkIntegrationRequest('claude-code', '', 'setup_token', 'interactive')).toBeNull();
  });
});

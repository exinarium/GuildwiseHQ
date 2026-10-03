import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { buildClaudeCommand, buildClaudeSettings } from '../src/adapters/claude-code.ts';
import type { ShiftStartInput } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';

const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
const reviewer = BUILTIN_ROLES.find((r) => r.key === 'reviewer');
const tester = BUILTIN_ROLES.find((r) => r.key === 'tester');
if (!builder || !reviewer || !tester) throw new Error('roles');

const input = (over: Partial<ShiftStartInput> = {}): ShiftStartInput => ({
  shiftId: 's1',
  prompt: '# TOY-1: Add greeting',
  instructionsMarkdown: '# Who you are',
  cwd: '/data/worktrees/TOY/TOY-1',
  sandbox: {
    home: '/data/agents/a1/home',
    configDir: '/data/agents/a1/claude',
    scratch: '/data/agents/a1/scratch',
  },
  agent: {
    agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    name: 'Ada',
    roleKey: 'builder',
    seniority: 'junior',
    runtime: 'claude-code',
    model: 'sonnet',
    effort: 'medium',
    skills: [],
    permissions: builder.permissions,
    isDevops: false,
  },
  env: {
    AOM_IPC_URL: 'http://127.0.0.1:5555',
    AOM_SHIFT_TOKEN: 'tok',
    AOM_SHIFT_ID: 's1',
    PATH: '/data/bin:/usr/bin',
  },
  addDirs: [],
  maxShiftMinutes: 30,
  ...over,
});

describe('claude command builder (ARCHITECTURE section 12.2)', () => {
  it('builds the exact argv', () => {
    const cmd = buildClaudeCommand(
      input({ addDirs: ['/vaults/work/proj', '/vaults/work/shared'] }),
      ClaudeRuntimeConfigSchema.parse({}),
    );
    expect(cmd.bin).toBe('claude');
    expect(cmd.args).toEqual([
      '-p',
      '# TOY-1: Add greeting',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'sonnet',
      '--effort',
      'medium',
      '--permission-mode',
      'acceptEdits',
      '--strict-mcp-config',
      '--mcp-config',
      '/data/agents/a1/claude/mcp.json',
      '--add-dir',
      '/vaults/work/proj',
      '--add-dir',
      '/vaults/work/shared',
    ]);
  });

  it('omits --effort when unset and adds --resume for chat', () => {
    const base = input();
    const cmd = buildClaudeCommand(
      input({ agent: { ...base.agent, effort: undefined }, resumeSessionId: 'sess-1' }),
      ClaudeRuntimeConfigSchema.parse({}),
    );
    expect(cmd.args).not.toContain('--effort');
    expect(cmd.args.slice(-2)).toEqual(['--resume', 'sess-1']);
  });

  it('sets the sandbox env, passes the aom env through and adds OAuth auth', () => {
    const cmd = buildClaudeCommand(
      input(),
      ClaudeRuntimeConfigSchema.parse({ authMode: 'oauth', oauthToken: 'sk-ant-oat-x', bin: '/opt/claude' }),
    );
    expect(cmd.bin).toBe('/opt/claude');
    expect(cmd.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/data/agents/a1/claude',
      HOME: '/data/agents/a1/home',
      USERPROFILE: '/data/agents/a1/home',
      PATH: '/data/bin:/usr/bin',
      AOM_IPC_URL: 'http://127.0.0.1:5555',
      AOM_SHIFT_TOKEN: 'tok',
      AOM_SHIFT_ID: 's1',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
    });
    expect(cmd.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('uses ANTHROPIC_API_KEY in api_key mode and no credentials in default mode', () => {
    const api = buildClaudeCommand(
      input(),
      ClaudeRuntimeConfigSchema.parse({ authMode: 'api_key', apiKey: 'sk-ant-api' }),
    );
    expect(api.env.ANTHROPIC_API_KEY).toBe('sk-ant-api');
    const def = buildClaudeCommand(input(), ClaudeRuntimeConfigSchema.parse({}));
    expect(def.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(def.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe('claude settings.json', () => {
  it('maps tools to allow and always denies git push/rebase/checkout/switch/reset --hard', () => {
    const s = buildClaudeSettings(builder.permissions);
    expect(s.includeCoAuthoredBy).toBe(false);
    expect(s.permissions.defaultMode).toBe('acceptEdits');
    expect(s.permissions.allow).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash']);
    for (const d of [
      'Bash(git push:*)',
      'Bash(git rebase:*)',
      'Bash(git checkout:*)',
      'Bash(git switch:*)',
      'Bash(git reset --hard:*)',
      'Bash(sudo:*)',
      'Bash(rm -rf /*)',
    ]) {
      expect(s.permissions.deny).toContain(d);
    }
  });

  it('restricts Edit/Write to the writable globs (tester)', () => {
    const s = buildClaudeSettings(tester.permissions);
    expect(s.permissions.allow).toContain('Edit(e2e/**)');
    expect(s.permissions.allow).toContain('Write(e2e/**)');
    expect(s.permissions.allow).not.toContain('Edit');
  });

  it('read-only roles get no edit tools', () => {
    const s = buildClaudeSettings({ ...reviewer.permissions, allowedTools: ['read', 'shell', 'web'] });
    expect(s.permissions.allow).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch']);
  });
});

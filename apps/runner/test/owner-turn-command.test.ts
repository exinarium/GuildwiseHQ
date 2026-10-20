import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { buildClaudeOwnerTurnCommand, MAX_ARGV_PROMPT_BYTES } from '../src/adapters/claude-code.ts';
import type { OwnerTurnInput } from '../src/adapters/types.ts';
import { composeOwnerMessage, floorDenies, writeTurnFiles } from '../src/ceo/turn-files.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';

const ceo = BUILTIN_ROLES.find((r) => r.key === 'ceo');
if (!ceo) throw new Error('role');
const cfg = ClaudeRuntimeConfigSchema.parse({});

const input = (over: Partial<OwnerTurnInput> = {}): OwnerTurnInput => ({
  chatId: 'chat-1',
  mode: 'owner',
  message: 'hello CEO',
  cwd: '/home/owner',
  agent: {
    agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    name: 'Ada',
    roleKey: 'ceo',
    seniority: 'senior',
    runtime: 'claude-code',
    model: 'sonnet',
    effort: 'medium',
    skills: [],
    permissions: ceo.permissions,
    isDevops: false,
  },
  env: {
    AOM_IPC_URL: 'http://127.0.0.1:1',
    AOM_SHIFT_TOKEN: 't',
    AOM_SHIFT_ID: 'chat-1',
    PATH: '/runner/bin:/usr/bin',
  },
  turnDir: '/runner/ceo-turns/chat-1',
  ...over,
});

describe('buildClaudeOwnerTurnCommand (the full-power profile)', () => {
  it("is the owner's own Claude Code: his settings, no private config dir, no strict MCP, no disabled skills, auto mode", () => {
    const c = buildClaudeOwnerTurnCommand(input(), cfg, {
      HOME: '/home/owner',
      CLAUDE_CONFIG_DIR: undefined,
      FOO: 'bar',
    });
    const a = c.args;
    expect(a.slice(0, 2)).toEqual(['-p', 'hello CEO']);
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('user,project,local');
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(a[a.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__aom_permission__ask');
    expect(a.slice(a.indexOf('--allowedTools') + 1, a.indexOf('--allowedTools') + 4)).toEqual([
      'Bash(aom:*)',
      'Bash(aom deploy run:*)',
      'Bash(aom deploy status:*)',
    ]);
    expect(a[a.indexOf('--append-system-prompt-file') + 1]).toBe('/runner/ceo-turns/chat-1/ceo-brief.md');
    expect(a[a.indexOf('--mcp-config') + 1]).toBe('/runner/ceo-turns/chat-1/aom-permission.json');
    expect(a[a.indexOf('--settings') + 1]).toBe('/runner/ceo-turns/chat-1/floor.json');
    expect(a[a.indexOf('--model') + 1]).toBe('sonnet');
    expect(a[a.indexOf('--effort') + 1]).toBe('medium');
    expect(a).toContain('--include-partial-messages');
    expect(a).not.toContain('--strict-mcp-config');
    expect(a).not.toContain('--disable-slash-commands');
    expect(a).not.toContain('dontAsk');
    expect(c.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(c.env.FOO).toBe('bar'); // the owner's own environment
    expect(c.env.AOM_SHIFT_TOKEN).toBe('t');
    expect((c.env.PATH ?? '').startsWith('/runner/bin')).toBe(true);
  });

  it('a private CLAUDE_CONFIG_DIR of the parent is not forced; --resume and --add-dir are passed', () => {
    const c = buildClaudeOwnerTurnCommand(
      input({ resumeSessionId: 'sess-9', addDirs: ['/srv/a', '/srv/b'] }),
      cfg,
      {},
    );
    expect(c.args[c.args.indexOf('--resume') + 1]).toBe('sess-9');
    expect(c.args.filter((x) => x === '--add-dir')).toHaveLength(2);
    expect(c.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('uses the configured provider credential only when there is one; otherwise his own login', () => {
    expect(buildClaudeOwnerTurnCommand(input(), cfg, {}).env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const tok = ClaudeRuntimeConfigSchema.parse({ authMode: 'oauth', oauthToken: 'tok' });
    expect(buildClaudeOwnerTurnCommand(input(), tok, {}).env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
  });

  it('sends a huge prompt on stdin', () => {
    const c = buildClaudeOwnerTurnCommand(input({ message: 'x'.repeat(MAX_ARGV_PROMPT_BYTES + 1) }), cfg, {});
    expect(c.stdin).toHaveLength(MAX_ARGV_PROMPT_BYTES + 1);
    expect(c.args[1]).toBe('--output-format');
  });
});

describe('turn files', () => {
  it('writes the brief, the relay config, the deny floor with its hook, and the guard inputs', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'aom-turn-')), 'ceo-turns', 'c1');
    writeTurnFiles({
      turnDir: dir,
      brief: 'THE BRIEF',
      mode: 'order',
      ipcEnv: { AOM_IPC_URL: 'http://x', AOM_SHIFT_TOKEN: 'tok' },
      runnerRoots: ['/data/runner'],
      pid: 4242,
      clones: [{ path: '/src/p4', name: 'p4' }],
      home: '/home/owner',
    });
    expect(readFileSync(join(dir, 'ceo-brief.md'), 'utf8')).toBe('THE BRIEF');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const relay = JSON.parse(readFileSync(join(dir, 'aom-permission.json'), 'utf8'));
    expect(relay.mcpServers.aom_permission.args).toContain('ceo-permission-mcp');
    expect(relay.mcpServers.aom_permission.env).toMatchObject({
      AOM_SHIFT_TOKEN: 'tok',
      AOM_PERMISSION_MODE: 'order',
    });
    const floor = JSON.parse(readFileSync(join(dir, 'floor.json'), 'utf8'));
    expect(floor.permissions.deny).toEqual(
      expect.arrayContaining(['Bash(systemctl * aom-runner*)', 'Bash(pkill *aom*)', 'Bash(kill * 4242)']),
    );
    expect(
      floor.permissions.deny.some((d: string) => d.startsWith('Read(//home/owner/.aom-runner/secrets')),
    ).toBe(true);
    expect(floor.permissions.deny.some((d: string) => d.startsWith('Edit(//data/runner/config.json'))).toBe(
      true,
    );
    expect(floor.hooks.PreToolUse[0].matcher).toBe('Edit|Write|NotebookEdit');
    expect(floor.hooks.PreToolUse[0].hooks[0].command).toContain('guard');
    expect(existsSync(join(dir, 'guard.json'))).toBe(true);
  });

  it('floorDenies protects every runner root', () => {
    const d = floorDenies({ runnerRoots: ['/a', '/b'], pid: 1, home: '/h' });
    for (const root of ['/a', '/b', '/h/.aom-runner']) expect(d).toContain(`Read(/${root}/secrets/**)`);
  });

  it('composeOwnerMessage fences the context and says how long a queued message waited', () => {
    const m = composeOwnerMessage(
      { message: 'do it', briefDelta: 'new rule X', queuedAt: '2026-10-19T10:00:00.000Z' },
      new Date('2026-10-19T12:00:00.000Z'),
    );
    expect(m).toContain('<guildwise-context>\nnew rule X\n</guildwise-context>');
    expect(m).toContain('waited 2 hours');
    expect(m.endsWith('do it')).toBe(true);
    expect(composeOwnerMessage({ message: 'plain' })).toBe('plain');
  });
});

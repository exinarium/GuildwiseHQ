import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeChatCommand,
  buildClaudeCommand,
  ClaudeCodeAdapter,
  sessionEnv,
} from '../src/adapters/claude-code.ts';
import type { RuntimeEvent, RuntimeSession } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
const reviewer = BUILTIN_ROLES.find((r) => r.key === 'reviewer');
if (!reviewer) throw new Error('role');
const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const cfg = ClaudeRuntimeConfigSchema.parse({});

const skill = (name: string) => ({
  name,
  files: { 'SKILL.md': `---\nname: ${name}\ndescription: d\n---\nbody\n` },
});
const base = {
  shiftId: 's1',
  prompt: 'hi',
  instructionsMarkdown: '',
  cwd: '/data/worktrees/P/P-1',
  sandbox: { home: '/d/home', configDir: '/d/claude', scratch: '/d/scratch', tmp: '/d/tmp' },
  agent: { model: 'sonnet', roleKey: 'reviewer', permissions: reviewer.permissions, isDevops: false },
  env: {},
  addDirs: [],
  maxShiftMinutes: 5,
};

describe('Claude Code with granted skills', () => {
  it('keeps the skills switch off for an agent without grants and for DevOps', () => {
    expect(buildClaudeCommand(base as never, cfg).args).toContain('--disable-slash-commands');
    expect(buildClaudeCommand({ ...base, grantedSkills: [] } as never, cfg).args).toContain(
      '--disable-slash-commands',
    );
    const devops = { ...base, agent: { ...base.agent, isDevops: true }, grantedSkills: [skill('a')] };
    expect(buildClaudeCommand(devops as never, cfg).args).toContain('--disable-slash-commands');
  });

  it("drops the switch and Claude Code's bundled skills when skills are granted", () => {
    const c = buildClaudeCommand({ ...base, grantedSkills: [skill('a')] } as never, cfg);
    expect(c.args).not.toContain('--disable-slash-commands');
    expect(c.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBe('1');
    const chat = buildClaudeChatCommand(
      { ...base, chatId: 'c', message: 'm', readOnly: true, grantedSkills: [skill('a')] } as never,
      cfg,
    );
    expect(chat.args).not.toContain('--disable-slash-commands');
    expect(
      sessionEnv({ env: {}, sandbox: base.sandbox }, cfg).CLAUDE_CODE_DISABLE_BUNDLED_SKILLS,
    ).toBeUndefined();
  });

  it('writes exactly the granted skills into the private config dir, with the guard hook; no grants removes stale ones', async () => {
    const t = tmp();
    const argv = join(t, 'argv.txt');
    const bin = join(t, 'fakeclaude');
    writeFileSync(bin, `#!/bin/sh\necho "$@" > ${argv}\necho '{"type":"system"}'\nexit 0\n`);
    chmodSync(bin, 0o755);
    const cwd = join(t, 'data', 'worktrees', 'P4-98eeafb0', 'P4-3');
    mkdirSync(cwd, { recursive: true });
    const paths = runnerPaths(join(t, 'data'));
    const sandbox = await ensureSandbox(paths, A, 'Rev');
    const adapter = new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse({ bin, sandbox: 'off' }), paths);
    process.env.AOM_CLAUDE_SMOKE = '1';
    const run = async (grantedSkills: ReturnType<typeof skill>[] | undefined) => {
      const s: RuntimeSession = await adapter.start({
        shiftId: 'zz',
        prompt: 'go',
        instructionsMarkdown: '',
        cwd,
        sandbox,
        addDirs: [],
        env: {},
        maxShiftMinutes: 5,
        ...(grantedSkills ? { grantedSkills } : {}),
        agent: {
          agentId: A,
          name: 'Rev',
          roleKey: 'reviewer',
          seniority: 'senior',
          runtime: 'claude-code',
          model: 'sonnet',
          skills: [],
          permissions: reviewer.permissions,
          isDevops: false,
        },
      } as never);
      const ev: RuntimeEvent[] = [];
      for await (const e of s.events()) ev.push(e);
      return ev.at(-1);
    };
    try {
      expect(await run([skill('bmad-dev-story'), skill('Bad Name')])).toMatchObject({
        kind: 'exit',
        code: 0,
      });
      const dir = join(sandbox.configDir, 'skills');
      expect(existsSync(join(dir, 'bmad-dev-story/SKILL.md'))).toBe(true);
      expect(readFileSync(argv, 'utf8')).not.toContain('--disable-slash-commands');
      const settings = JSON.parse(readFileSync(join(sandbox.configDir, 'settings.json'), 'utf8'));
      expect(settings.hooks.PreToolUse.some((h: { matcher: string }) => h.matcher === 'Skill')).toBe(true);
      expect(settings.permissions.deny).toContain('Skill(anthropic-skills:*)');
      expect(JSON.parse(readFileSync(join(sandbox.configDir, 'skill-guard.json'), 'utf8'))).toEqual({
        allowed: ['bmad-dev-story'],
      });
      // the next shift grants nothing: the folder is emptied and the switch is back
      expect(await run([])).toMatchObject({ kind: 'exit', code: 0 });
      expect(existsSync(dir)).toBe(false);
      expect(readFileSync(argv, 'utf8')).toContain('--disable-slash-commands');
    } finally {
      delete process.env.AOM_CLAUDE_SMOKE;
    }
  });
});

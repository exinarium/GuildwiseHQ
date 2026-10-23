import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCodexCommand, codexFilesystem } from '../src/adapters/codex.ts';
import { materializeSkills } from '../src/capabilities/materialize.ts';

const profile = {
  cwd: '/work/wt',
  readOnlyCwd: false,
  sandbox: { home: '/runner/agents/a/home', scratch: '/runner/agents/a/scratch', tmp: '/tmp/aom-abc' },
  gitDirs: [],
  mayCommit: false,
  readDirs: [],
  addDirs: [],
  toolchainReadPaths: [],
  aomReadPaths: [],
  codexReadPaths: [],
};
const cfg = { enabled: true, bin: '/usr/bin/codex', authMode: 'login' as const, toolchainPaths: [] };
const build = (over: { model?: string; resumeSessionId?: string }) =>
  buildCodexCommand(
    {
      prompt: 'P',
      cwd: '/work/wt',
      model: 'gpt-6',
      shellEnv: {},
      profile,
      web: false,
      codexHome: '/c',
      ...over,
    },
    cfg,
    { PATH: '/usr/bin' },
  );

describe('codex command line', () => {
  it('passes the model as one argument and ends the options before the positionals', () => {
    const c = build({ model: '--dangerously-bypass-approvals-and-sandbox' });
    expect(c.args).toContain('--model=--dangerously-bypass-approvals-and-sandbox');
    expect(c.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(c.args.slice(-2)).toEqual(['--', '-']);
  });
  it('resumes only a thread id; anything else starts a fresh session', () => {
    const id = '0190aaaa-1111-7222-8333-444455556666';
    expect(build({ resumeSessionId: id }).args.slice(-4)).toEqual(['resume', '--', id, '-']);
    const bad = build({ resumeSessionId: '--config=evil' });
    expect(bad.args).not.toContain('resume');
    expect(bad.args).not.toContain('--config=evil');
  });
  it('keeps the shell from writing the skills folder of its home', () => {
    expect(codexFilesystem(profile)['/runner/agents/a/home/.agents']).toBe('read');
  });
});

describe('materializing skills into a folder the shell could write', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'aom-mat-'));
    dirs.push(d);
    return d;
  };
  const skill = [{ name: 'one', files: { 'SKILL.md': 'x' } }];

  it('writes the skills into a plain folder', () => {
    const home = tmp();
    expect(materializeSkills(join(home, '.agents', 'skills'), skill, home)).toEqual(['one']);
    expect(readFileSync(join(home, '.agents', 'skills', 'one', 'SKILL.md'), 'utf8')).toBe('x');
  });
  it('refuses a symlinked skills folder and removes nothing behind it', () => {
    const home = tmp();
    const victim = tmp();
    writeFileSync(join(victim, 'precious'), 'keep');
    mkdirSync(join(home, '.agents'));
    symlinkSync(victim, join(home, '.agents', 'skills'));
    expect(() => materializeSkills(join(home, '.agents', 'skills'), skill, home)).toThrow(/symbolic link/);
    expect(readFileSync(join(victim, 'precious'), 'utf8')).toBe('keep');
  });
  it('refuses a symlinked ancestor', () => {
    const home = tmp();
    const victim = tmp();
    symlinkSync(victim, join(home, '.agents'));
    expect(() => materializeSkills(join(home, '.agents', 'skills'), skill, home)).toThrow(/symbolic link/);
    expect(() => readFileSync(join(victim, 'skills', 'one', 'SKILL.md'))).toThrow();
  });
});

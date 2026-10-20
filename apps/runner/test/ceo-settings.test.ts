import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { buildCeoSettings, buildShiftSettings } from '../src/adapters/claude-policy.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

const ceoRole = BUILTIN_ROLES.find((r) => r.key === 'ceo');
if (!ceoRole) throw new Error('the CEO role is missing');

const ctx = (over = {}) =>
  policyCtx({
    cwd: '/data/agents/a1/scratch',
    gitDirs: [],
    addDirs: [],
    readDirs: ['/data/vaults/v1/org'],
    ipcSocket: '/data/run/ipc.sock',
    ...over,
  });

describe('the CEO sandbox profile', () => {
  it('may read, write only its scratch directory and run only `aom`', () => {
    const s = buildCeoSettings(ctx(), POLICY_PATHS);
    expect(s.permissions.allow).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Bash(aom:*)',
      'Edit(//data/agents/a1/scratch/**)',
      // the one deploy action: ask Guildwise (docs/design/ceo-front-door.md 9.6)
      'Bash(aom deploy run:*)',
      'Bash(aom deploy status:*)',
    ]);
    expect(s.permissions.defaultMode).toBe('dontAsk');
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
  });

  it('has no web, no MCP servers, no network and no git push', () => {
    const s = buildCeoSettings(ctx(), POLICY_PATHS);
    for (const rule of ['WebFetch', 'WebSearch', 'mcp__*', 'Bash(git push:*)'])
      expect(s.permissions.deny, rule).toContain(rule);
    expect(s.permissions.allow.some((r) => r.startsWith('mcp__') || r.startsWith('Web'))).toBe(false);
    expect(s.sandbox?.network.allowedDomains).toEqual([]);
    expect(s.sandbox?.enabled).toBe(true);
    expect(s.sandbox?.allowUnsandboxedCommands).toBe(false);
  });

  it('reads the organization vault read-only: it is a read directory, never writable', () => {
    const s = buildCeoSettings(ctx(), POLICY_PATHS);
    expect(s.permissions.additionalDirectories).toContain('/data/vaults/v1/org');
    expect(s.permissions.deny).toEqual(
      expect.arrayContaining(['Edit(//data/vaults/v1/org/**)', 'Edit(//data/vaults/v1/org)']),
    );
    expect(s.sandbox?.filesystem.denyWrite).toContain('/data/vaults/v1/org');
    // the runner's private state and the agent's Claude config stay out of reach
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Edit(//data/agents/a1/claude/**)']));
    expect(s.sandbox?.filesystem.denyRead).toContain('/data');
  });

  it('is the profile of the CEO role in a shift too, whatever the role permissions say', () => {
    const wide = { ...ceoRole.permissions, allowedTools: ['read', 'edit', 'shell', 'web'] as never };
    const viaShift = buildShiftSettings(wide, ctx(), POLICY_PATHS, 'ceo', false);
    expect(viaShift).toEqual(buildCeoSettings(ctx(), POLICY_PATHS));
    const builder = buildShiftSettings(wide, ctx(), POLICY_PATHS, 'builder', false);
    expect(builder.permissions.allow).toContain('WebFetch');
  });

  it('the role itself has no claimable stages, is senior only and cannot commit', () => {
    expect(ceoRole.claimableStages).toEqual([]);
    expect(ceoRole.seniorityLevels).toEqual(['senior']);
    expect(ceoRole.permissions.mayCommit).toBe(false);
    expect(ceoRole.department).toBe('management');
    expect(ceoRole.coreRules.join(' ')).toContain('aom ceo');
  });
});

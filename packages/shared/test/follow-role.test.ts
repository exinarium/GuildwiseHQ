import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  COMMON_DENIED_SHELL,
  hasDeviations,
  permissionDeviations,
  rebasePermissions,
  rebaseSkills,
} from '../src/index.ts';

describe('rebaseSkills: newRole + (agent - oldRole)', () => {
  it("an unedited agent takes the new version's skills", () => {
    expect(rebaseSkills({ role: ['a', 'b'] }, ['a', 'b'], ['a', 'c'])).toEqual(['a', 'c']);
  });
  it('keeps the skills the agent added and leaves out the ones it dropped', () => {
    expect(rebaseSkills({ role: ['a', 'b'] }, ['a', 'own'], ['a', 'b', 'c'])).toEqual(['a', 'c', 'own']);
  });
  it('a skill an older version listed is not taken for one of its own', () => {
    expect(rebaseSkills({ role: ['a'], known: ['old'] }, ['a', 'old'], ['a', 'new'])).toEqual(['a', 'new']);
  });
});

const builder = BUILTIN_ROLES.find((r) => r.key === 'builder')!.permissions;
const v1 = { ...builder, deniedShellPatterns: COMMON_DENIED_SHELL };

describe('rebasePermissions: newRole + (agent - oldRole)', () => {
  it('an unedited agent takes the new role exactly', () => {
    expect(rebasePermissions({ role: v1 }, v1, builder)).toEqual(builder);
  });

  it('keeps own deviations and drops the old role restrictions the new role lifted', () => {
    const agent = {
      ...v1,
      allowedTools: [...v1.allowedTools, 'mcp:plugin_x'],
      deniedShellPatterns: [...v1.deniedShellPatterns, 'npm publish*'],
      riskTiers: ['small' as const],
    };
    const out = rebasePermissions({ role: v1 }, agent, builder);
    expect(out.deniedShellPatterns).toEqual([...builder.deniedShellPatterns, 'npm publish*']);
    expect(out.deniedShellPatterns).not.toContain('git rebase*');
    expect(out.allowedTools).toContain('mcp:plugin_x');
    expect(out.riskTiers).toEqual(['small']);
  });

  it('a value any earlier version carried is not a deviation', () => {
    const d = permissionDeviations({ role: builder, knownDeniedShell: COMMON_DENIED_SHELL }, v1);
    expect(hasDeviations(d)).toBe(false);
    expect(rebasePermissions({ role: builder, knownDeniedShell: COMMON_DENIED_SHELL }, v1, builder)).toEqual(
      builder,
    );
  });

  it('a removed tool stays removed, a tool the new role adds arrives', () => {
    const agent = { ...v1, allowedTools: ['read', 'edit'] };
    const out = rebasePermissions({ role: v1 }, agent, {
      ...builder,
      allowedTools: ['read', 'edit', 'shell', 'web'],
    });
    expect(out.allowedTools).toEqual(['read', 'edit', 'web']);
  });
});

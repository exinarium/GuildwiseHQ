import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  COMMON_DENIED_SHELL,
  hasDeviations,
  permissionDeviations,
  rebasePermissions,
} from '../src/index.ts';

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

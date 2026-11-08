import { type AgentPermissions, BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  buildCeoSettings,
  buildChatSettings,
  buildMentionWorkSettings,
  buildShiftSettings,
  type ClaudePolicyContext,
  type ClaudeSettings,
  DARWIN_LOCAL_BINDING_ROLES,
  keepsLocalBindingOnDarwin,
} from '../src/adapters/claude-policy.ts';
import { settingsProblem } from '../src/health/role-smoke.ts';
import { runnerPaths } from '../src/paths.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

const PLATFORMS = ['linux', 'darwin'] as const;
type Platform = (typeof PLATFORMS)[number];

const role = (key: string): AgentPermissions => {
  const r = BUILTIN_ROLES.find((x) => x.key === key);
  if (!r) throw new Error(`no built-in role ${key}`);
  return r.permissions as AgentPermissions;
};
const hasShell = (p: AgentPermissions) => p.allowedTools.includes('shell');

const ctxFor = (platform: Platform, over: Partial<ClaudePolicyContext> = {}) =>
  policyCtx({ platform, ...over });
const binding = (s: ClaudeSettings) => s.sandbox?.network.allowLocalBinding;

const shift = (key: string, platform: Platform, over: Partial<ClaudePolicyContext> = {}) =>
  buildShiftSettings(role(key), ctxFor(platform, over), POLICY_PATHS, key);

const customBrowserRole: AgentPermissions = {
  ...role('ba'),
  allowedTools: ['read', 'shell'],
  browser: true,
} as AgentPermissions;

const scanPerms = {
  allowedTools: ['read', 'edit', 'shell'],
  deniedShellPatterns: [],
  writableGlobs: null,
  mayCommit: true,
} as never;

// Expected `allowLocalBinding` per settings builder, per platform.
const TABLE: Array<{
  name: string;
  build: (pl: Platform) => ClaudeSettings;
  linux: boolean;
  darwin: boolean;
}> = [
  { name: 'shift builder', build: (pl) => shift('builder', pl), linux: true, darwin: true },
  // The reviewer never builds or runs tests and reads untrusted diffs: off on macOS, like pre_reviewer.
  { name: 'shift reviewer', build: (pl) => shift('reviewer', pl), linux: true, darwin: false },
  { name: 'shift tester', build: (pl) => shift('tester', pl), linux: true, darwin: true },
  {
    name: 'shift custom role with browser: true',
    build: (pl) => buildShiftSettings(customBrowserRole, ctxFor(pl), POLICY_PATHS, 'qa_custom'),
    linux: true,
    darwin: true,
  },
  ...['ba', 'planner', 'architect', 'pre_reviewer', 'writer'].map((key) => ({
    name: `shift ${key}`,
    build: (pl: Platform) => shift(key, pl),
    linux: true,
    darwin: false,
  })),
  {
    name: 'shift role without shell',
    build: (pl) =>
      buildShiftSettings(
        { ...role('reviewer'), allowedTools: ['read', 'edit'] },
        ctxFor(pl),
        POLICY_PATHS,
        'reviewer',
      ),
    linux: false,
    darwin: false,
  },
  {
    name: 'mention work (builder permissions)',
    build: (pl) => buildMentionWorkSettings(role('builder'), ctxFor(pl), POLICY_PATHS),
    linux: true,
    darwin: false,
  },
  {
    name: 'chat',
    build: (pl) => buildChatSettings(true, [], ctxFor(pl), POLICY_PATHS),
    linux: true,
    darwin: false,
  },
  {
    name: 'CEO (buildCeoSettings)',
    build: (pl) => buildCeoSettings(ctxFor(pl), POLICY_PATHS),
    linux: true,
    darwin: false,
  },
  {
    name: "CEO (buildShiftSettings 'ceo')",
    build: (pl) => buildShiftSettings(role('ba'), ctxFor(pl), POLICY_PATHS, 'ceo'),
    linux: true,
    darwin: false,
  },
  {
    name: 'DevOps scan',
    build: (pl) =>
      buildShiftSettings(scanPerms, ctxFor(pl, { readOnlyScan: true }), POLICY_PATHS, 'devops', true),
    linux: false,
    darwin: false,
  },
];

describe('allowLocalBinding per platform and role', () => {
  for (const row of TABLE)
    for (const pl of PLATFORMS)
      it(`${row.name} on ${pl}: ${row[pl]}`, () => {
        expect(binding(row.build(pl))).toBe(row[pl]);
      });

  it('DevOps outside a scan has no sandbox block on either platform', () => {
    for (const pl of PLATFORMS)
      expect(buildShiftSettings(scanPerms, ctxFor(pl), POLICY_PATHS, 'devops', true).sandbox).toBeUndefined();
  });
});

describe('Linux keeps today’s rule', () => {
  it('every built-in role on linux: allowLocalBinding equals "has a shell", same as with no platform set', () => {
    for (const r of BUILTIN_ROLES) {
      if (r.key === 'devops') continue; // unsandboxed by design
      const p = r.permissions as AgentPermissions;
      const linux = buildShiftSettings(p, ctxFor('linux'), POLICY_PATHS, r.key);
      const expected = r.key === 'ceo' ? true : hasShell(p);
      expect(binding(linux), r.key).toBe(expected);
      if (process.platform === 'linux') {
        const unset = buildShiftSettings(p, policyCtx(), POLICY_PATHS, r.key);
        expect(binding(unset), r.key).toBe(binding(linux));
      }
    }
  });
});

describe('nothing else in the sandbox changes on darwin', () => {
  const strip = (s: ClaudeSettings) => {
    const sb = structuredClone(s.sandbox);
    if (sb) delete (sb.network as { allowLocalBinding?: boolean }).allowLocalBinding;
    return sb;
  };
  const over = { ipcSocket: '/tmp/aom-ipc/x.sock', extraAllowedDomains: ['npm.corp'] };

  it('an off-list role (BA): the darwin and linux sandbox blocks differ only in allowLocalBinding', () => {
    const linux = shift('ba', 'linux', over);
    const darwin = shift('ba', 'darwin', over);
    expect(binding(linux)).toBe(true);
    expect(binding(darwin)).toBe(false);
    expect(strip(darwin)).toEqual(strip(linux));
  });

  it('an allow-listed role (builder): the blocks are identical on both platforms', () => {
    expect(shift('builder', 'darwin', over).sandbox).toEqual(shift('builder', 'linux', over).sandbox);
  });
});

describe('the aom route to the runner on darwin', () => {
  const sock = '/tmp/aom-ipc/x.sock';
  const cases: Array<[string, ClaudeSettings]> = [
    ['ba shift', shift('ba', 'darwin', { ipcSocket: sock })],
    ['chat', buildChatSettings(true, [], ctxFor('darwin', { ipcSocket: sock }), POLICY_PATHS)],
    ['ceo', buildCeoSettings(ctxFor('darwin', { ipcSocket: sock }), POLICY_PATHS)],
  ];
  for (const [name, s] of cases)
    it(`${name}: aom stays an excluded command and the IPC socket stays allowed`, () => {
      expect(binding(s)).toBe(false);
      expect(s.sandbox?.excludedCommands).toEqual(expect.arrayContaining(['aom', 'aom *']));
      expect(s.sandbox?.network.allowUnixSockets).toEqual([sock]);
    });
});

describe('the macOS allow-list', () => {
  it('is exactly builder and tester, each with a reason', () => {
    expect([...DARWIN_LOCAL_BINDING_ROLES.keys()].sort()).toEqual(['builder', 'tester']);
    for (const reason of DARWIN_LOCAL_BINDING_ROLES.values()) expect(reason.trim().length).toBeGreaterThan(0);
  });

  it('keepsLocalBindingOnDarwin: listed roles and browser roles, never a mention', () => {
    expect(keepsLocalBindingOnDarwin({ browser: false }, 'builder')).toBe(true);
    expect(keepsLocalBindingOnDarwin({ browser: false }, 'tester')).toBe(true);
    expect(keepsLocalBindingOnDarwin({ browser: true }, 'qa_custom')).toBe(true);
    expect(keepsLocalBindingOnDarwin({ browser: false }, 'ba')).toBe(false);
    expect(keepsLocalBindingOnDarwin({ browser: false }, 'reviewer')).toBe(false);
    expect(keepsLocalBindingOnDarwin({ browser: false }, undefined)).toBe(false);
    expect(keepsLocalBindingOnDarwin({ browser: true }, 'mention')).toBe(false);
  });
});

describe('role smoke check', () => {
  it('settingsProblem is null for every built-in role', () => {
    const paths = runnerPaths('/data');
    const agentDir = '/data/agents/a1';
    for (const r of BUILTIN_ROLES)
      expect(
        settingsProblem(r, paths, `${agentDir}/scratch`, '/data/worktrees/TOY/TOY-1', agentDir),
        r.key,
      ).toBeNull();
  });
});

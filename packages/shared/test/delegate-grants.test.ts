import { describe, expect, it } from 'vitest';
import {
  type AgentPermissions,
  agentHandle,
  childPermissions,
  DELEGATE_GRANT_LIMITS,
  DelegateGrantSettingsSchema,
  effectiveProfile,
  narrowerProfile,
  profileOfPermissions,
  profileOfPersonaTools,
  SetDelegateGrantRequestSchema,
  summarizeReply,
  toolsOfProfile,
} from '../src/index.ts';

const perms = (over: Partial<AgentPermissions> = {}): AgentPermissions => ({
  allowedTools: ['read'],
  deniedShellPatterns: [],
  writableGlobs: null,
  mayCommit: false,
  browser: false,
  riskTiers: ['small', 'large'],
  readOrgRepos: false,
  repoIds: null,
  ...over,
});

describe('tool profiles', () => {
  it('reads a profile from permissions and from a persona frontmatter', () => {
    expect(profileOfPermissions({ allowedTools: ['read', 'web'] })).toBe('read_only');
    expect(profileOfPermissions({ allowedTools: ['read', 'edit'] })).toBe('edit');
    expect(profileOfPermissions({ allowedTools: ['read', 'edit', 'shell'] })).toBe('shell');
    expect(profileOfPersonaTools(undefined)).toBe('read_only');
    expect(profileOfPersonaTools(['Read', 'Grep'])).toBe('read_only');
    expect(profileOfPersonaTools(['Read', 'Write'])).toBe('edit');
    expect(profileOfPersonaTools(['Bash'])).toBe('shell');
    expect(toolsOfProfile('edit')).toEqual(['read', 'edit']);
  });

  it('takes the narrower of two profiles', () => {
    expect(narrowerProfile('shell', 'edit')).toBe('edit');
    expect(narrowerProfile('read_only', 'shell')).toBe('read_only');
    expect(effectiveProfile('shell', 'edit')).toBe('edit');
    expect(effectiveProfile('shell', 'shell', 'read_only')).toBe('read_only');
    expect(effectiveProfile('edit', 'shell', null)).toBe('edit');
  });
});

describe('the permissions of a child run', () => {
  const parent = perms({
    allowedTools: ['read', 'edit', 'shell'],
    deniedShellPatterns: ['git push*'],
    writableGlobs: ['src/**', 'test/**'],
    mayCommit: true,
  });

  it('never exceed the parent: a shell target under an edit-only parent has no shell', () => {
    const target = perms({ allowedTools: ['read', 'edit', 'shell'], writableGlobs: null, mayCommit: true });
    const editParent = perms({ allowedTools: ['read', 'edit'], writableGlobs: ['src/**'] });
    const c = childPermissions(target, editParent, 'shell');
    expect(c.allowedTools).toEqual(['read', 'edit']);
    expect(c.writableGlobs).toEqual(['src/**']);
    expect(c.mayCommit).toBe(false);
  });

  it('are read only under a read-only parent, whatever the target declares', () => {
    const target = perms({ allowedTools: ['read', 'edit', 'shell', 'web'] });
    const c = childPermissions(target, perms(), 'shell');
    expect(c.allowedTools).toEqual(['read']);
    expect(c.writableGlobs).toEqual([]);
    expect(c.browser).toBe(false);
  });

  it('follow the profile of the grant and keep the parent denials and globs', () => {
    const target = perms({ allowedTools: ['read', 'edit', 'shell'], deniedShellPatterns: ['rm -rf*'] });
    const c = childPermissions(target, parent, 'edit');
    expect(c.allowedTools).toEqual(['read', 'edit']);
    expect(c.deniedShellPatterns).toEqual(['git push*', 'rm -rf*']);
    expect(c.writableGlobs).toEqual(['src/**', 'test/**']);
    const both = childPermissions(
      perms({ allowedTools: ['read', 'edit'], writableGlobs: ['src/**', 'docs/**'] }),
      parent,
      'edit',
    );
    expect(both.writableGlobs).toEqual(['src/**']);
  });

  it('commit only when both may and a shell is in the profile', () => {
    const t = perms({ allowedTools: ['read', 'edit', 'shell'], mayCommit: true });
    expect(childPermissions(t, parent, 'shell').mayCommit).toBe(true);
    expect(childPermissions(t, parent, 'edit').mayCommit).toBe(false);
    expect(
      childPermissions(perms({ allowedTools: ['read', 'edit', 'shell'] }), parent, 'shell').mayCommit,
    ).toBe(false);
  });

  it('intersect the repositories', () => {
    const a = '019e3f6a-7b1c-7a2d-8c3e-0123456789c1';
    const b = '019e3f6a-7b1c-7a2d-8c3e-0123456789c2';
    expect(
      childPermissions(perms({ repoIds: [a, b] }), perms({ repoIds: [a] }), 'read_only').repoIds,
    ).toEqual([a]);
    expect(childPermissions(perms({ repoIds: null }), perms({ repoIds: [b] }), 'read_only').repoIds).toEqual([
      b,
    ]);
  });
});

describe('grants', () => {
  it('have sane defaults and bounds', () => {
    expect(DelegateGrantSettingsSchema.parse({})).toEqual({
      maxCalls: DELEGATE_GRANT_LIMITS.defaultMaxCalls,
      timeoutSec: DELEGATE_GRANT_LIMITS.defaultTimeoutSec,
      maxProfile: null,
    });
    expect(DelegateGrantSettingsSchema.safeParse({ maxCalls: 0 }).success).toBe(false);
    expect(DelegateGrantSettingsSchema.safeParse({ maxCalls: 99 }).success).toBe(false);
    expect(DelegateGrantSettingsSchema.safeParse({ timeoutSec: 5 }).success).toBe(false);
    expect(DelegateGrantSettingsSchema.safeParse({ timeoutSec: 601 }).success).toBe(false);
  });

  it('revoke with a null grant', () => {
    expect(
      SetDelegateGrantRequestSchema.parse({ targetKind: 'persona', targetKey: 'a', grant: null }).grant,
    ).toBeNull();
    expect(SetDelegateGrantRequestSchema.safeParse({ targetKind: 'persona', targetKey: 'a' }).success).toBe(
      false,
    );
  });

  it('give an agent a readable, unique handle', () => {
    expect(agentHandle('Ada Reviewer')).toBe('agent:ada-reviewer');
    expect(agentHandle('Ada Reviewer', new Set(['agent:ada-reviewer']), 'abcd1234')).toBe(
      'agent:ada-reviewer-abcd',
    );
    expect(agentHandle('???')).toBe('agent:agent');
  });

  it('summarize a reply on one line', () => {
    expect(summarizeReply('a\n\n b')).toBe('a b');
    expect(summarizeReply('x'.repeat(500)).length).toBe(280);
  });
});

import type { AgentPermissions } from '@aom/shared';
import { BRANCH_MOVING_DENIED, GIT_PUSH_DENIED, STASH_REMOVING_DENIED, shellDeny } from './claude-policy.ts';

/**
 * The shell commands a role may not run, as plain command prefixes (`git push`, `git reset --hard`): the CLI harnesses that
 * can match a command by its leading words (Codex's execpolicy, Gemini's policy engine, opencode's bash permissions) refuse
 * them as a second line. Patterns with a wildcard in the middle (`git -C * push`) have no such equivalent and are left to the
 * structure (no credentials in the sandbox, no route to a git host that accepts a push, a read-only `.git/config`).
 */
export function deniedShellPrefixes(
  p: Pick<AgentPermissions, 'deniedShellPatterns'>,
  roleKey?: string,
): string[] {
  const claude = [
    ...GIT_PUSH_DENIED,
    'Bash(git reset --hard:*)',
    ...STASH_REMOVING_DENIED,
    ...(roleKey === 'builder' ? [] : BRANCH_MOVING_DENIED),
    ...p.deniedShellPatterns.map(shellDeny),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of claude) {
    const m = /^Bash\(([A-Za-z0-9_./ -]+?)(?::\*)?\)$/.exec(r);
    if (!m?.[1] || m[1].includes('*') || m[1].includes('/*')) continue;
    const key = m[1].trim().split(/\s+/).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

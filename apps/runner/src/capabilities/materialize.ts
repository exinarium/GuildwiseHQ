import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * A skill granted to an agent, ready to be written into a runtime's native skills folder (Claude Code:
 * `<CLAUDE_CONFIG_DIR>/skills/<name>/`, Codex: `<project>/.agents/skills/<name>/`). `files` holds the text of every file
 * of the skill by path relative to its folder (`SKILL.md`, `references/...`); the registry has already dropped scripts
 * that are not enabled and skills of an untrusted pack, so this module writes exactly what it is given.
 */
export interface GrantedSkill {
  /** The folder name (the Agent Skills `name`). */
  name: string;
  files: Record<string, string>;
}

/** Folder names are the skills' own `name`: lowercase letters, digits and single hyphens, nothing that climbs out. */
const SAFE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Refuses a path that is, or goes through, a symbolic link below `root`. The folder this module empties and fills may sit in
 * a place the agent's own shell can write (Codex's `HOME/.agents/skills`); a link swapped in there must never make this
 * unsandboxed process delete or write somewhere else. A component that does not exist yet is fine. Throws on a link.
 */
export function assertNoSymlinkBelow(root: string, path: string): void {
  const base = realpathSync(root);
  const rel = relative(resolve(root), resolve(path));
  if (rel.startsWith('..')) throw new Error(`refusing ${path}: it is outside ${root}`);
  let cur = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    cur = join(cur, part);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(cur);
    } catch {
      return; // nothing here yet, so nothing to follow
    }
    if (st.isSymbolicLink()) throw new Error(`refusing ${cur}: it is a symbolic link`);
    if (!st.isDirectory()) throw new Error(`refusing ${cur}: it is not a folder`);
  }
}

/**
 * Replaces the contents of `destRoot` with the granted skills (one folder each), so the folder holds exactly what the
 * agent is granted this shift and nothing from an earlier shift. Paths that would leave a skill's folder are skipped.
 * `trustedRoot` (default: the parent of `destRoot`) is the folder this module relies on: no link may lie between it and
 * `destRoot`, and the files are created exclusively, so an existing link is never written through. Returns the names written.
 */
export function materializeSkills(
  destRoot: string,
  skills: readonly GrantedSkill[],
  trustedRoot: string = dirname(destRoot),
): string[] {
  assertNoSymlinkBelow(trustedRoot, destRoot);
  rmSync(destRoot, { recursive: true, force: true });
  if (skills.length === 0) return [];
  mkdirSync(destRoot, { recursive: true });
  const written: string[] = [];
  for (const s of skills) {
    if (!SAFE_NAME.test(s.name) || written.includes(s.name)) continue;
    const base = resolve(destRoot, s.name);
    for (const [rel, text] of Object.entries(s.files)) {
      const target = resolve(base, rel);
      if (!target.startsWith(base + sep)) continue;
      mkdirSync(dirname(target), { recursive: true });
      assertNoSymlinkBelow(trustedRoot, dirname(target));
      writeFileSync(target, text, { flag: 'wx' });
    }
    written.push(s.name);
  }
  return written;
}

export const skillsDirOf = (configDir: string): string => join(configDir, 'skills');

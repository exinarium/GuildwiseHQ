import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

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
 * Replaces the contents of `destRoot` with the granted skills (one folder each), so the folder holds exactly what the
 * agent is granted this shift and nothing from an earlier shift. Paths that would leave a skill's folder are skipped.
 * Returns the names written.
 */
export function materializeSkills(destRoot: string, skills: readonly GrantedSkill[]): string[] {
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
      writeFileSync(target, text);
    }
    written.push(s.name);
  }
  return written;
}

export const skillsDirOf = (configDir: string): string => join(configDir, 'skills');

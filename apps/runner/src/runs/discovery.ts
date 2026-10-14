import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 60 * 1024;

/** A file named `name` (any case) directly in `dir`, or null. */
function findCaseInsensitive(dir: string, name: string): string | null {
  try {
    const hit = readdirSync(dir).find((f) => f.toLowerCase() === name.toLowerCase());
    if (!hit) return null;
    const p = join(dir, hit);
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * `BUILD.md` of a repository's run worktree: first in the project folder (`projectPath`, subfolder projects), then at
 * the repository root, case-insensitively. The runner finds it so the DevOps engineer never has to search.
 */
export function findBuildDoc(
  worktree: string,
  projectPath?: string,
): { path: string; content: string } | null {
  const dirs = [...(projectPath ? [join(worktree, projectPath)] : []), worktree];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const p = findCaseInsensitive(dir, 'BUILD.md');
    if (!p) continue;
    try {
      const text = readFileSync(p, 'utf8');
      return {
        path: p.slice(worktree.length).replace(/^[\\/]/, '') || 'BUILD.md',
        content: text.length > MAX_BYTES ? `${text.slice(0, MAX_BYTES)}\n... (cut)` : text,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** Hash of the BUILD.md files a plan was made from (part of the plan's fingerprint on the server). */
export function buildHash(docs: Array<{ repoId: string; content: string }>): string {
  const h = createHash('sha256');
  for (const d of [...docs].sort((a, b) => (a.repoId < b.repoId ? -1 : 1)))
    h.update(`${d.repoId}\n${d.content}\n`);
  return h.digest('hex');
}

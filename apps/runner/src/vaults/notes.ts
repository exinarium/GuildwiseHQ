import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_VAULT_NOTE_COUNT, TASTE_FILE } from '@aom/shared';

/** Files and folders the system writes into a vault itself: they are not the user's notes. */
const GENERATED_FILES = new Set(['standing-orders.md', TASTE_FILE]);
const GENERATED_DIRS = new Set(['graph', 'delivery']);

/**
 * How many notes (Markdown files the user wrote) a vault folder holds, counted up to `cap`. Skips symlinks, dot
 * folders, the generated `graph/` and `delivery/` folders, `standing-orders.md` and `taste.md`. Returns 0 on any error.
 */
export function countVaultNotes(root: string, cap = MAX_VAULT_NOTE_COUNT): number {
  let count = 0;
  const stack = [root];
  try {
    while (stack.length > 0 && count < cap) {
      const dir = stack.pop() as string;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (!e.name.startsWith('.') && !GENERATED_DIRS.has(e.name)) stack.push(join(dir, e.name));
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && !GENERATED_FILES.has(e.name)) {
          if (++count >= cap) break;
        }
      }
    }
  } catch {
    return 0;
  }
  return count;
}

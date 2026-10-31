import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_VAULT_NOTE_COUNT, TASTE_FILE } from '@aom/shared';

/** The `noteCount` field of a vault status report, left out when the folder could not be read. */
export function noteCountField(root: string): { noteCount?: number } {
  const noteCount = countVaultNotes(root);
  return noteCount === undefined ? {} : { noteCount };
}

/** Files and folders the system writes into a vault itself: they are not the user's notes. */
const GENERATED_FILES = new Set(['standing-orders.md', TASTE_FILE]);
const GENERATED_DIRS = new Set(['graph', 'delivery']);

/**
 * How many notes (Markdown files the user wrote) a vault folder holds, counted up to `cap`. Skips symlinks, dot
 * folders, the generated `graph/` and `delivery/` folders, `standing-orders.md` and `taste.md`. Returns undefined on any
 * error, so the caller leaves the count out and the server keeps the last good one.
 */
export function countVaultNotes(root: string, cap = MAX_VAULT_NOTE_COUNT): number | undefined {
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
    return undefined;
  }
  return count;
}

import { indexPack, packSnapshotOf } from './packs.ts';

/** The content hash an authored pack's files hash to (the value the reviewer approves, and the revision's name). */
export function authoredTreeContentHash(name: string, tree: Record<string, string>): string {
  const index = indexPack({ name, adapter: 'generic', tree });
  return packSnapshotOf({ name, ref: 'v0', sha: 'a'.repeat(64), index }).contentHash;
}

export interface TreeFileChange {
  path: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  before: string | null;
  after: string | null;
}

/**
 * File-level difference of two versions of a pack (path by path, sorted): which files were added, removed or changed, with
 * both texts so a page can show a line diff. `before` null: there is no earlier version, every file is added.
 */
export function diffPackTrees(
  before: Record<string, string> | null | undefined,
  after: Record<string, string>,
): TreeFileChange[] {
  const old = before ?? {};
  const paths = [...new Set([...Object.keys(old), ...Object.keys(after)])].sort();
  return paths.map((path) => {
    const b = path in old ? (old[path] as string) : null;
    const a = path in after ? (after[path] as string) : null;
    const status = b === null ? 'added' : a === null ? 'removed' : a === b ? 'unchanged' : 'changed';
    return { path, status, before: b, after: a };
  });
}

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * A local vault is a plain folder on this workstation (docs/design/project-graphs.md section 3): no remote, no sync, no
 * commits. The marker file tells the runner the folder is a vault it created (and keeps `readVaultContext` and the sync
 * code from treating an arbitrary folder as one).
 */
export const LOCAL_VAULT_MARKER = '.aom-local-vault';

/** Creates the folder and its marker. Idempotent. */
export function ensureLocalVault(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, LOCAL_VAULT_MARKER);
  if (!existsSync(marker))
    writeFileSync(
      marker,
      `${JSON.stringify({ kind: 'aom-local-vault', createdAt: new Date().toISOString() })}\n`,
    );
}

/** Is `dir` a local vault folder (and not a clone)? */
export const isLocalVaultDir = (dir: string): boolean =>
  existsSync(join(dir, LOCAL_VAULT_MARKER)) && !existsSync(join(dir, '.git'));

/**
 * A project vault that got a remote repository after it was a local folder: the folder is set aside (never deleted: the
 * owner may want what is in it) so the repository can be cloned in its place. Returns the new name, or null when there was
 * nothing to set aside.
 */
export function setAsideLocalVault(dir: string, now: () => Date = () => new Date()): string | null {
  if (!isLocalVaultDir(dir)) return null;
  const aside = `${dir}.was-local-${now().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(dir, aside);
  return aside;
}

/**
 * Folders that a sync tool (OneDrive, iCloud, Dropbox, Google Drive) keeps: a repository inside one corrupts easily, and a
 * local vault there is the owner's backup business. Returns the matching tool name, or null.
 */
export function syncRootOf(path: string, home: string = homedir()): string | null {
  const p = resolve(path);
  const roots: Array<[string, string]> = [
    ['OneDrive', join(home, 'OneDrive')],
    ['iCloud Drive', join(home, 'Library', 'Mobile Documents')],
    ['iCloud Drive', join(home, 'iCloudDrive')],
    ['Dropbox', join(home, 'Dropbox')],
    ['Google Drive', join(home, 'Google Drive')],
    ['Google Drive', join(home, 'Library', 'CloudStorage')],
  ];
  for (const [name, root] of roots) if (p === root || p.startsWith(root + sep)) return name;
  // `OneDrive - Contoso` style folders and the like.
  const m = /(^|[\\/])(OneDrive[^\\/]*|Dropbox[^\\/]*|iCloud[^\\/]*)([\\/]|$)/i.exec(p);
  if (m?.[2]) return m[2].replace(/\s*-.*/, '');
  return null;
}

/** The warning shown (and logged) for a local vault: never synced, and where it sits. */
export function localVaultWarning(dir: string): string {
  const root = syncRootOf(dir);
  return root
    ? `local vault folder ${dir} sits inside ${root}: it is not synced by Guildwise; back it up yourself, and do not run git init inside a synced folder`
    : `local vault folder ${dir} is not synced by Guildwise; back it up yourself (or give the project a git repository)`;
}

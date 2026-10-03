import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isSafeVaultPath, type VaultWriteCommand } from '@aom/shared';
import { git, gitOk } from '../git/git.ts';
import { identityEnv, type VaultIdentity } from './sync.ts';

export class VaultWriteError extends Error {}

export interface VaultWriteResult {
  /** The file content changed (false: an identical write already happened, which is success). */
  written: boolean;
  committed: boolean;
}

/**
 * `vault.write` (docs/ARCHITECTURE.md section 16.4): writes one markdown file into the local vault clone and commits
 * it. Idempotent: `create` of identical content, `append` of a block that is already there and `replace` with
 * identical content are successes without a new commit. The caller pushes (sync) when `cmd.push`.
 */
export async function writeVaultFile(
  dir: string,
  cmd: VaultWriteCommand,
  identity: VaultIdentity,
): Promise<VaultWriteResult> {
  if (!isSafeVaultPath(cmd.path)) throw new VaultWriteError(`unsafe vault path: ${cmd.path}`);
  const file = join(dir, ...cmd.path.split('/'));
  const exists = existsSync(file);
  const current = exists ? await readFile(file, 'utf8') : '';
  let next: string;
  switch (cmd.mode) {
    case 'create':
      if (exists) {
        if (current === cmd.content) return { written: false, committed: false };
        throw new VaultWriteError(`${cmd.path} already exists with different content`);
      }
      next = cmd.content;
      break;
    case 'append':
      if (exists && current.includes(cmd.content)) return { written: false, committed: false };
      next = exists
        ? `${current}${current && !current.endsWith('\n') ? '\n' : ''}${cmd.content}`
        : `${cmd.header ?? ''}${cmd.content}`;
      break;
    case 'replace':
      if (exists && current === cmd.content) return { written: false, committed: false };
      next = cmd.content;
      break;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, next);
  const env = identityEnv(identity);
  await gitOk(dir, ['add', '--', cmd.path], { env });
  const staged = await git(dir, ['diff', '--cached', '--quiet', '--', cmd.path], { env });
  if (staged.exitCode === 0) return { written: true, committed: false };
  await gitOk(dir, ['-c', 'commit.gpgsign=false', 'commit', '-m', cmd.commitMessage, '--', cmd.path], {
    env,
  });
  return { written: true, committed: true };
}

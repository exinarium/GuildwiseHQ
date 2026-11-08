import { randomBytes } from 'node:crypto';
import { constants, createReadStream, createWriteStream, lstatSync, statSync } from 'node:fs';
import { link, lstat, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { STORAGE_MAX_CLASH, storageClashName, storedPathSegments } from '@aom/shared';
import { fromNodeError } from './errors.ts';
import {
  PROBE_BODY,
  PROBE_NAME,
  type Spooled,
  type StorageConnector,
  StorageError,
  type StorageTarget,
} from './types.ts';

/** Validates a local root: absolute, an existing directory, not a drive/filesystem root. */
export function checkLocalRoot(root: string, forbidden: string[] = []): void {
  if (!root || (!isAbsolute(root) && !/^\\\\[^\\]+\\[^\\]+/.test(root)))
    throw new StorageError('invalid', 'The folder must be an absolute path on the workstation.');
  const r = resolve(root);
  if (r === resolve(sep) || /^[A-Za-z]:\\?$/.test(r))
    throw new StorageError('invalid', 'Choose a folder, not the top of a disk.');
  for (const f of forbidden) {
    const rel = relative(resolve(f), r);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
      throw new StorageError('invalid', 'This folder is used by the runner itself: choose another.');
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(r);
  } catch (err) {
    throw fromNodeError(err);
  }
  if (!st.isDirectory()) throw new StorageError('invalid', 'The path is not a folder.');
}

/** Resolves `segments` below `root`, refusing a symlink on the way. */
export function confineUnder(root: string, segments: string[]): string {
  const base = resolve(root);
  let cur = base;
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || /[\\/]/.test(seg))
      throw new StorageError('invalid', 'The destination path is not allowed.');
    cur = join(cur, seg);
    try {
      if (lstatSync(cur).isSymbolicLink())
        throw new StorageError('permission', 'The destination goes through a link and was refused.');
    } catch (err) {
      if (err instanceof StorageError) throw err;
      return join(cur, ...segments.slice(segments.indexOf(seg) + 1));
    }
  }
  return cur;
}

/** A folder or NAS share reachable from this workstation. */
export class LocalConnector implements StorageConnector {
  constructor(
    private readonly root: string,
    private readonly forbidden: string[] = [],
  ) {}

  private check(): void {
    checkLocalRoot(this.root, this.forbidden);
  }

  async probe(): Promise<void> {
    this.check();
    const f = confineUnder(this.root, [PROBE_NAME()]);
    try {
      await writeFile(f, PROBE_BODY, { flag: 'wx' });
      await unlink(f);
    } catch (err) {
      throw fromNodeError(err);
    }
  }

  async put(target: StorageTarget, file: Spooled): Promise<{ path: string }> {
    this.check();
    const dir = confineUnder(this.root, target.folder);
    try {
      await mkdir(dir, { recursive: true });
      const part = join(dir, `.${target.name}.part-${randomBytes(4).toString('hex')}`);
      await pipeline(createReadStream(file.file), createWriteStream(part, { mode: 0o640, flags: 'wx' }));
      try {
        // Never overwrite: link() fails with EEXIST when the name is taken; then the next suffix is tried.
        for (let n = 1; n <= STORAGE_MAX_CLASH; n++) {
          const name = n === 1 ? target.name : storageClashName(target.name, n);
          try {
            await link(part, join(dir, name));
            return { path: [...target.folder, name].join('/') };
          } catch (err) {
            if ((err as { code?: string }).code === 'EEXIST') continue;
            if (['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes((err as { code?: string }).code ?? '')) {
              // A share without hard links: rename after an existence check.
              const dest = join(dir, name);
              if (existsSyncSafe(dest)) continue;
              await rename(part, dest);
              return { path: [...target.folder, name].join('/') };
            }
            throw err;
          }
        }
        throw new StorageError('conflict', 'Too many files with the same name.');
      } finally {
        await rm(part, { force: true });
      }
    } catch (err) {
      throw fromNodeError(err);
    }
  }

  async delete(path: string): Promise<void> {
    const f = confineUnder(this.root, path.split('/'));
    await rm(f, { force: true });
  }

  async deleteFile(ref: { path: string }): Promise<'deleted' | 'not_found'> {
    const segs = storedPathSegments(ref.path);
    if (!segs) throw new StorageError('invalid', 'The file is outside the storage destination.');
    // A folder that is not there (a share that is not mounted) must not look like "the file is gone".
    try {
      if (!statSync(resolve(this.root)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new StorageError('unavailable', 'The storage folder is not reachable on this workstation.');
    }
    const f = confineUnder(this.root, segs);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(f);
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT' || (err as { code?: string }).code === 'ENOTDIR')
        return 'not_found';
      throw fromNodeError(err);
    }
    if (!st.isFile()) throw new StorageError('invalid', 'Only files are removed, not folders or links.');
    try {
      await rm(f);
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return 'not_found';
      throw fromNodeError(err);
    }
    return 'deleted';
  }
}

function existsSyncSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
void constants;

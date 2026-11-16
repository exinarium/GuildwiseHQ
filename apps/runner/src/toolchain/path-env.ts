import { delimiter } from 'node:path';

/** The toolchain directories first, then the parent PATH entries (pure). */
export function toolchainPathDirs(pathDirs: readonly string[], parentPath: string | undefined): string[] {
  return [...pathDirs, ...(parentPath ?? '').split(delimiter)];
}

/** The PATH value a command runs with: the toolchain directories ahead of the parent PATH (pure). */
export function toolchainPathValue(pathDirs: readonly string[], parentPath: string | undefined): string {
  return [...pathDirs, parentPath ?? ''].join(delimiter);
}

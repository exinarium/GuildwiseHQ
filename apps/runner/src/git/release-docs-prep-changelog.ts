import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  changelogSkeleton,
  checkChangelog,
  mergeUnreleased,
  type ReleaseChangelogOutput,
  ReleasePrepChangelogPayloadSchema,
} from '@aom/shared';
import type { DocsPrepStepHandler } from './release-docs-prep-steps.ts';

const FILE = 'CHANGELOG.md';

/**
 * 'Write changelog': merges the server-checked entries into the Unreleased block of CHANGELOG.md in the prep worktree.
 * Deterministic: the entries were written and checked before the command was sent. Writes only when the file changes,
 * so a retry with the entries already present leaves the file byte-identical.
 */
export const changelogStep: DocsPrepStepHandler = async ({ worktree, payload }) => {
  const parsed = ReleasePrepChangelogPayloadSchema.safeParse(payload.changelog);
  if (!parsed.success) return { ok: false, error: 'the server sent no changelog entries: update the server' };
  const { projectName, version, entries, proposal } = parsed.data;
  const path = join(worktree, FILE);

  let md: string | null = null;
  try {
    const st = await lstat(path);
    if (!st.isFile()) return { ok: false, error: `${FILE} is not a regular file` };
    md = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const check = md === null ? { errors: [], warnings: [] } : checkChangelog(md, version ? { version } : {});
  if (check.errors.length > 0) return { ok: false, error: check.errors.join(' ') };

  const base: ReleaseChangelogOutput = {
    created: false,
    added: [],
    duplicates: [],
    covered: proposal?.covered ?? [],
    skipped: proposal?.skipped ?? [],
    warnings: check.warnings,
  };
  if (entries.length === 0) return { ok: true, files: [], output: base };

  const merged = mergeUnreleased(md ?? changelogSkeleton(projectName), entries);
  if (merged.kind === 'error') return { ok: false, error: merged.message };
  if (merged.kind === 'unchanged')
    return { ok: true, files: [], output: { ...base, duplicates: merged.duplicates } };

  await writeFile(path, merged.md, 'utf8');
  const sourcesOf = (text: string) =>
    entries.find((e) => e.text.replace(/\s+/g, ' ').trim() === text)?.sources ?? [];
  return {
    ok: true,
    files: [FILE],
    output: {
      ...base,
      created: md === null,
      added: merged.added.map((e) => ({ ...e, sources: sourcesOf(e.text) })),
      duplicates: merged.duplicates,
    },
  };
};

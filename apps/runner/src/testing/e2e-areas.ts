import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  E2E_AREAS_FILE,
  type E2eAreaMap,
  E2eAreaMapSchema,
  type E2eSelection,
  type ShiftBrief,
  selectE2eSpecs,
} from '@aom/shared';
import { git } from '../git/git.ts';

const SPEC_FILE = /\.(spec|test|e2e)\.[a-z0-9]+$/i;

/** The E2E spec files of the card's worktree: tracked files under the project's E2E globs' folders that look like specs. */
export async function listSpecFiles(worktree: string, e2eGlobs: readonly string[]): Promise<string[]> {
  const r = await git(worktree, ['ls-files', '-z']);
  if (r.exitCode !== 0) return [];
  const folders = e2eGlobs.map((g) => g.replace(/\/?\*.*$/, '').replace(/^\.\//, '')).filter(Boolean);
  const all = r.stdout.split('\0').filter((f) => SPEC_FILE.test(f));
  const inE2e = all.filter((f) => folders.length === 0 || folders.some((d) => f.startsWith(`${d}/`)));
  return inE2e.length > 0 ? inE2e : all.filter((f) => /(^|\/)(e2e|playwright)(\/|$)/i.test(f));
}

/** The project's own mapping file in the repository (`e2e/areas.json`), when it has one and it parses. */
export function readAreasFile(worktree: string, projectPath?: string): E2eAreaMap | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(worktree, projectPath ?? '', E2E_AREAS_FILE), 'utf8'),
    ) as unknown;
    const parsed = E2eAreaMapSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The tester's "E2E areas for this card" section (lean team): the card's changed paths mapped to the specs that belong to them.
 * The repository's `e2e/areas.json` wins over the project's setting, which wins over the default derived from the E2E
 * folders. Undefined when the brief carries no changed paths (a card of the older workflows).
 */
export async function e2eAreasSection(
  brief: ShiftBrief,
  worktree: string | null,
): Promise<{ text: string; selection: E2eSelection } | undefined> {
  const e2e = brief.e2e;
  if (!e2e || !worktree) return undefined;
  const specFiles = await listSpecFiles(worktree, brief.project.e2eGlobs);
  const mapping = readAreasFile(worktree, brief.project.projectPath) ?? e2e.mapping;
  const selection = selectE2eSpecs({
    changedPaths: e2e.changedPaths,
    mapping,
    specFiles,
    hint: e2e.hint,
  });
  const lines = [
    '## E2E areas for this card',
    `Changed files: ${e2e.changedPaths.length === 0 ? 'none recorded' : `${e2e.changedPaths.length} (${e2e.changedPaths.slice(0, 12).join(', ')}${e2e.changedPaths.length > 12 ? ', ...' : ''})`}`,
    `Selection: ${selection.reason}.`,
  ];
  if (selection.mode === 'all')
    lines.push('Run the whole E2E suite for this card (no area could be chosen).');
  else {
    lines.push(
      selection.specs.length > 0
        ? `Run only these specs (plus the tests you write for the card):\n${selection.specs.map((s) => `- ${s}`).join('\n')}`
        : 'No spec file belongs to these areas: write the tests for the card and run those.',
    );
    lines.push('Do not run the full suite: it is a manual regression run after the cards are merged.');
  }
  return { text: lines.join('\n'), selection };
}

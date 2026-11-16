import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripAnsi } from '../checks/attribute.ts';

/** Runs one program of the repository (no shell); same shape as the Release prep exec. */
export type ReleaseExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

export interface ReleaseFormatInput {
  /** The integration worktree (the release tip): the tool runs here and reads the tip's configuration. */
  worktree: string;
  /** Repository-relative paths, exactly the files the release commit wrote. */
  files: string[];
  /** The runner's clone of the repository: where the repository's own node_modules/.bin lives. */
  repoPath: string;
  /** Toolchain PATH folders (then the process PATH), searched after the clone's node_modules/.bin. */
  pathDirs: string[];
  /** Absent: this runner cannot run programs for the release commit, and the check is skipped. */
  exec?: ReleaseExec;
  /** Defaults to `process.platform`; tests pin it. */
  platform?: NodeJS.Platform;
}

export type ReleaseFormatOutcome =
  | { state: 'skipped'; reason: string }
  | { state: 'passed'; tool: string; commands: string[]; files: string[]; fixed: string[] }
  | { state: 'failed'; tool: string; commands: string[]; files: string[]; failing: string[]; output: string };

export interface FormatterSpec {
  tool: 'biome' | 'prettier';
  /** The configuration file that selected the tool (for the notices). */
  config: string;
  fixArgs: string[];
  verifyArgs: string[];
}

const RUN_TIMEOUT_MS = 2 * 60_000;
const OUTPUT_MAX = 2500;

const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'];
const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
];

function hasPrettierKey(worktree: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')) as unknown;
    return typeof pkg === 'object' && pkg !== null && 'prettier' in pkg;
  } catch {
    return false;
  }
}

/** The file-scoped formatter the repository configures at its root (biome first, then prettier), or null. */
export function detectReleaseFormatter(worktree: string): FormatterSpec | null {
  const biome = BIOME_CONFIGS.find((f) => existsSync(join(worktree, f)));
  if (biome) {
    const common = [
      '--no-errors-on-unmatched',
      '--files-ignore-unknown=true',
      '--max-diagnostics=none',
      '--colors=off',
    ];
    return {
      tool: 'biome',
      config: biome,
      fixArgs: ['check', '--write', ...common],
      verifyArgs: ['check', ...common, '--diagnostic-level=error'],
    };
  }
  const prettier =
    PRETTIER_CONFIGS.find((f) => existsSync(join(worktree, f))) ??
    (hasPrettierKey(worktree) ? 'package.json' : undefined);
  if (prettier)
    return {
      tool: 'prettier',
      config: prettier,
      fixArgs: ['--write', '--ignore-unknown', '--no-color'],
      verifyArgs: ['--check', '--ignore-unknown', '--no-color'],
    };
  return null;
}

/** The repository's own binary: the clone's node_modules/.bin first, then the PATH folders. Never npx, never an install. */
export function resolveFormatterBinary(tool: string, repoPath: string, pathDirs: string[]): string | null {
  for (const dir of [join(repoPath, 'node_modules', '.bin'), ...pathDirs.filter(Boolean)]) {
    const bin = join(dir, tool);
    if (existsSync(bin)) return bin;
  }
  return null;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/**
 * Runs the repository's formatter/linter on exactly the files the release commit wrote: the fix pass first (its exit
 * code is ignored: biome exits 1 when errors it cannot fix remain), then the verify pass, whose exit code decides.
 * Never touches another file; never throws for expected failures.
 */
export async function formatReleaseFiles(input: ReleaseFormatInput): Promise<ReleaseFormatOutcome> {
  const files = [...new Set(input.files)];
  if (files.length === 0) return { state: 'skipped', reason: 'the release commit wrote no files' };
  const spec = detectReleaseFormatter(input.worktree);
  if (!spec) return { state: 'skipped', reason: 'the repository has no biome or prettier configuration' };
  if (!input.exec)
    return { state: 'skipped', reason: 'this runner cannot run programs for the release commit' };
  if ((input.platform ?? process.platform) === 'win32')
    return {
      state: 'skipped',
      reason: `${spec.config} is in the repository but the ${spec.tool} check does not run on Windows runners yet`,
    };
  const bin = resolveFormatterBinary(spec.tool, input.repoPath, input.pathDirs);
  if (!bin)
    return {
      state: 'skipped',
      reason: `${spec.config} is in the repository but no ${spec.tool} program was found in ${join(input.repoPath, 'node_modules', '.bin')} or on the toolchain PATH`,
    };
  // './' keeps a path from ever being read as an option
  const fileArgs = files.map((f) => `./${f}`);
  const fixArgs = [...spec.fixArgs, ...fileArgs];
  const verifyArgs = [...spec.verifyArgs, ...fileArgs];
  const commands = [fixArgs, verifyArgs].map((a) => [spec.tool, ...a].join(' '));
  const before = await Promise.all(files.map((f) => readOrNull(join(input.worktree, f))));
  const opts = { cwd: input.worktree, timeoutMs: RUN_TIMEOUT_MS };
  try {
    await input.exec(bin, fixArgs, opts);
  } catch {
    // the verify pass reports what is still wrong
  }
  const after = await Promise.all(files.map((f) => readOrNull(join(input.worktree, f))));
  const fixed = files.filter((_, i) => before[i] !== after[i]);
  let verify: { exitCode: number; stdout: string; stderr: string; timedOut: boolean };
  try {
    verify = await input.exec(bin, verifyArgs, opts);
  } catch (err) {
    verify = {
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
    };
  }
  if (verify.exitCode === 0 && !verify.timedOut)
    return { state: 'passed', tool: spec.tool, commands, files, fixed };
  const raw = stripAnsi(`${verify.stdout}\n${verify.stderr}`).trim();
  const text = verify.timedOut ? `${raw}\n(${baseName(bin)} timed out)`.trim() : raw;
  const named = files.filter((f) => text.includes(f));
  return {
    state: 'failed',
    tool: spec.tool,
    commands,
    files,
    failing: named.length > 0 ? named : files,
    output: text.length > OUTPUT_MAX ? `…${text.slice(-OUTPUT_MAX)}` : text,
  };
}

/** A list of file names for a notice: at most `max`, then "and N more". */
export function shortList(files: string[], max = 5): string {
  return files.length <= max
    ? files.join(', ')
    : `${files.slice(0, max).join(', ')} and ${files.length - max} more`;
}

/** The notice for a skipped or passed check, at most 500 characters (the result schema's cap). */
export function formatNotice(o: Exclude<ReleaseFormatOutcome, { state: 'failed' }>): string {
  const text =
    o.state === 'skipped'
      ? `Format check skipped: ${o.reason}.`
      : `Format check: ${o.tool} ran on ${shortList(o.files)} (${o.commands
          .map((c) =>
            c
              .split(' ')
              .filter((t) => !t.startsWith('./'))
              .join(' '),
          )
          .join(' ; ')}): passed${o.fixed.length > 0 ? `; it fixed ${shortList(o.fixed)}` : ''}.`;
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

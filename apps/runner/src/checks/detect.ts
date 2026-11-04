import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCommandLine } from '@aom/shared';

/**
 * Proposes `check` suites from what a repository declares: the CI workflow, the package.json scripts and the config of
 * the usual linters and formatters. The proposals wait unconfirmed in the project settings; only a confirmed check blocks
 * a handoff. Never executes anything.
 */

export interface CheckProposal {
  name: string;
  cmd: string[];
  cwd: string;
  kind: 'check';
  timeoutMin: number;
  fix?: string[];
}

const MAX_PROPOSALS = 5;
const KEYWORDS =
  /\b(lint|format|fmt|typecheck|type-check|check-types|tsc|biome|eslint|prettier|ruff|black|isort|mypy|dotnet format|gofmt|golangci-lint)\b/;
const SHELLY = /&&|\|\||\||;|>|<|\$|`/;
const SCRIPTS = ['lint', 'typecheck', 'type-check', 'check-types', 'format:check', 'fmt:check'];
const PM_FLAGS = new Set(['-r', '--recursive', '--if-present', '--no-bail', 'run', 'run-script']);

const read = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

function readJson(p: string): { scripts: Record<string, string>; packageManager?: string } | null {
  const t = read(p);
  if (t === null) return null;
  try {
    const j = JSON.parse(t) as { scripts?: Record<string, string>; packageManager?: string };
    return {
      scripts: j.scripts && typeof j.scripts === 'object' ? j.scripts : {},
      packageManager: j.packageManager,
    };
  } catch {
    return null;
  }
}

/** The `run:` command lines of a workflow file (one-liners and block scalars). */
export function workflowRuns(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i] as string);
    if (!m) continue;
    const indent = (m[1] as string).length;
    const rest = (m[2] as string).trim();
    if (/^[|>][+-]?$/.test(rest)) {
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] as string;
        if (l.trim() === '') continue;
        if (l.length - l.trimStart().length <= indent) break;
        out.push(l.trim());
        i = j;
      }
    } else if (rest) out.push(rest.replace(/^(['"])(.*)\1$/, '$2'));
  }
  return out;
}

const kindName = (cmdText: string): string =>
  /typecheck|type-check|check-types|tsc|mypy/.test(cmdText)
    ? 'typecheck'
    : /format|fmt|prettier|black|isort|gofmt/.test(cmdText)
      ? 'format'
      : 'lint';

/** The package script a `pnpm|npm|yarn` command line runs, or null. */
function scriptOf(argv: string[]): string | null {
  if (!['pnpm', 'npm', 'yarn'].includes(argv[0] ?? '')) return null;
  return argv.slice(1).find((a) => !a.startsWith('-') && !PM_FLAGS.has(a)) ?? null;
}

/** Hardening (visible in the proposal): Biome prints at most 20 diagnostics and `pnpm -r` stops at the first failure. */
function harden(argv: string[], scripts: Record<string, string>): string[] {
  let out = [...argv];
  const script = scriptOf(out);
  const body = script ? (scripts[script] ?? '') : '';
  const runsBiome = out.includes('biome') || /\bbiome\b/.test(body);
  if (runsBiome && !out.some((a) => a.startsWith('--max-diagnostics')) && !/--max-diagnostics/.test(body))
    out = out[0] === 'npm' ? [...out, '--', '--max-diagnostics=none'] : [...out, '--max-diagnostics=none'];
  const ri = out.findIndex((a) => a === '-r' || a === '--recursive');
  if (ri >= 0 && !out.includes('--no-bail')) out.splice(ri + 1, 0, '--no-bail');
  return out;
}

export function detectChecks(worktree: string, relDir = '.'): CheckProposal[] {
  const dir = relDir === '.' || relDir === '' ? worktree : join(worktree, relDir);
  const cwd = relDir || '.';
  const pkg = readJson(join(dir, 'package.json')) ?? readJson(join(worktree, 'package.json'));
  const scripts = pkg?.scripts ?? {};
  const pm = pmOf(dir, worktree, pkg?.packageManager);
  const found: CheckProposal[] = [];
  const seen = new Set<string>();
  const coveredNames = new Set<string>();
  const coveredBodies = new Set<string>();
  const used = new Map<string, number>();
  const add = (argv: string[], fix?: string[]): void => {
    const key = argv.join(' ');
    if (seen.has(key) || found.length >= MAX_PROPOSALS) return;
    seen.add(key);
    const base = kindName(key);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    found.push({
      name: n === 1 ? base : `${base} ${n}`,
      cmd: argv,
      cwd,
      kind: 'check',
      timeoutMin: 5,
      ...(fix ? { fix } : {}),
    });
  };
  const fixFor = (bodyOfCheck: string): string[] | undefined => {
    const fmt = scripts.format ?? scripts.fmt;
    const tool = /\b(biome|prettier|ruff|black)\b/.exec(bodyOfCheck)?.[1];
    if (!fmt || !tool || !new RegExp(`\\b${tool}\\b`).test(fmt) || !/--write|\bformat\b/.test(fmt))
      return undefined;
    if (!/--write/.test(fmt) && tool !== 'ruff') return undefined;
    return pm === 'npm'
      ? ['npm', 'run', scripts.format ? 'format' : 'fmt']
      : [pm, scripts.format ? 'format' : 'fmt'];
  };

  // 1. the CI workflow
  const wfDir = join(worktree, '.github', 'workflows');
  let files: string[] = [];
  try {
    files = readdirSync(wfDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort();
  } catch {
    // no workflows
  }
  for (const f of files) {
    for (const line of workflowRuns(read(join(wfDir, f)) ?? '')) {
      if (!KEYWORDS.test(line) || SHELLY.test(line)) continue;
      if (/--write|--fix|\binstall\b/.test(line)) continue;
      if (/\bdotnet format\b/.test(line) && !line.includes('--verify-no-changes')) continue;
      const argv = parseCommandLine(line);
      if (argv.length === 0) continue;
      const script = scriptOf(argv);
      if (script) {
        coveredNames.add(script);
        if (/--write|--fix/.test(scripts[script] ?? '')) continue;
        if (scripts[script]) coveredBodies.add(scripts[script] as string);
      }
      coveredBodies.add(line);
      add(harden(argv, scripts), fixFor(`${line} ${script ? (scripts[script] ?? '') : ''}`));
    }
  }

  // 2. the package.json scripts CI does not already run
  for (const name of SCRIPTS) {
    const body = scripts[name];
    if (!body || /--write|--fix/.test(body)) continue;
    if (coveredNames.has(name) || coveredBodies.has(body)) continue;
    const argv = pm === 'npm' ? ['npm', 'run', name] : [pm, name];
    add(harden(argv, scripts), fixFor(body));
  }

  // 3. the config of the usual tools, only when nothing above was found
  if (found.length === 0) {
    const has = (...names: string[]) => names.some((n) => existsSync(join(dir, n)));
    if (has('biome.json', 'biome.jsonc'))
      add(
        ['npx', 'biome', 'check', '.', '--max-diagnostics=none'],
        ['npx', 'biome', 'format', '--write', '.'],
      );
    if (
      has(
        'eslint.config.js',
        'eslint.config.mjs',
        'eslint.config.cjs',
        'eslint.config.ts',
        '.eslintrc',
        '.eslintrc.json',
        '.eslintrc.js',
        '.eslintrc.cjs',
      )
    )
      add(['npx', 'eslint', '.']);
    if (has('.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js', 'prettier.config.mjs'))
      add(['npx', 'prettier', '--check', '.'], ['npx', 'prettier', '--write', '.']);
    if (has('ruff.toml', '.ruff.toml') || /\[tool\.ruff\]/.test(read(join(dir, 'pyproject.toml')) ?? '')) {
      add(['ruff', 'check', '.']);
      add(['ruff', 'format', '--check', '.'], ['ruff', 'format', '.']);
    }
    let dotnet = false;
    try {
      dotnet = readdirSync(dir).some((f) => /\.(sln|slnx|csproj)$/.test(f));
    } catch {
      // not a folder
    }
    if (dotnet && has('.editorconfig'))
      add(['dotnet', 'format', '--verify-no-changes'], ['dotnet', 'format', 'whitespace']);
  }
  return found;
}

function pmOf(dir: string, root: string, declared?: string): 'pnpm' | 'npm' | 'yarn' {
  const d = /^(pnpm|npm|yarn)@/.exec(declared ?? '')?.[1];
  if (d === 'pnpm' || d === 'npm' || d === 'yarn') return d;
  for (const base of [dir, root]) {
    if (existsSync(join(base, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(base, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(base, 'package-lock.json'))) return 'npm';
  }
  return 'npm';
}

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DeployExecPayload, parseRecipe, RECIPE_FILE } from '@aom/shared';
import { sha256Hex } from './deploy-pin.ts';
import { writeFileAtomic } from './store.ts';

/**
 * What a deploy approval shows (R18-S, REVIEW blocker 3): the command as the runner will run it. That means the recipe
 * environment (script, arguments, secret NAMES, env file, Docker), every file of the recipe bundle, and a diff against
 * the bundle of the last approved deploy of the same project, environment and target. The executor re-checks the bundle
 * hash before it runs, so what is shown is what runs.
 */

export interface BundleSnapshot {
  hash: string;
  files: Array<{ path: string; content: string }>;
}

const MAX_FILE = 20_000;

const keyOf = (p: DeployExecPayload): string =>
  sha256Hex(`${p.projectId}\0${p.env}\0${p.target.id ?? p.target.name}`).slice(0, 24);

/** `approved-bundles/` beside the policy: the bundle of the last deploy that ran after approval (or a pin). */
export class ApprovedBundles {
  readonly dir: string;
  constructor(root: string) {
    this.dir = join(root, 'approved-bundles');
  }
  get(p: DeployExecPayload): BundleSnapshot | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, `${keyOf(p)}.json`), 'utf8')) as BundleSnapshot;
    } catch {
      return null;
    }
  }
  put(p: DeployExecPayload, b: BundleSnapshot): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.dir, `${keyOf(p)}.json`), JSON.stringify(b), 0o600);
  }
}

/** A plain line diff (LCS): `-` removed, `+` added, ` ` unchanged context near changes. */
export function lineDiff(a: string, b: string, context = 2): string[] {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 4_000_000) return ['(too large to diff: compare the files above)'];
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        x[i] === y[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
  const ops: Array<{ t: ' ' | '-' | '+'; l: string }> = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) ops.push({ t: ' ', l: x[i++] as string }), j++;
    else if (
      i < x.length &&
      (j >= y.length || ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))
    )
      ops.push({ t: '-', l: x[i++] as string });
    else ops.push({ t: '+', l: y[j++] as string });
  }
  const keep = new Set<number>();
  ops.forEach((o, k) => {
    if (o.t !== ' ') for (let d = -context; d <= context; d++) keep.add(k + d);
  });
  return ops.filter((_, k) => keep.has(k)).map((o) => `${o.t} ${o.l}`);
}

export function describeBundle(
  p: DeployExecPayload,
  bundle: BundleSnapshot,
  previous: BundleSnapshot | null,
): string {
  const out: string[] = [];
  if (bundle.hash !== p.hash)
    out.push(
      `WARNING: the recipe in the vault (hash ${bundle.hash}) is not the one the server asked for (${p.hash}); the run will refuse it.`,
    );
  const recipe = bundle.files.find((f) => f.path === RECIPE_FILE);
  const parsed = recipe ? parseRecipe(recipe.content) : null;
  const env = parsed?.ok ? parsed.recipe.environments.find((e) => e.name === p.env) : undefined;
  if (env) {
    out.push(
      'what runs:',
      `  script         ${env.script} ${env.args.join(' ')}`.trimEnd(),
      `  secrets (names) ${env.secrets.join(', ') || '-'}`,
      `  env file       ${env.envFile ?? '-'}`,
      `  docker         ${env.docker ? 'yes (outside the sandbox)' : 'no'}`,
      `  smoke          ${env.smoke ?? '-'}`,
      '  env (always set) AOM_DEPLOY_COMMIT, AOM_DEPLOY_CHECKOUT, AOM_DEPLOY_ENV, AOM_DEPLOY_PROJECT_ID, AOM_DEPLOY_TARGET, AOM_DEPLOY_HOST, AOM_DEPLOY_APP_URL, AOM_DEPLOY_DRY_RUN',
    );
  } else out.push(`the recipe has no environment ${p.env}: the run will refuse it`);
  if (previous) {
    const changed: string[] = [];
    const paths = new Set([...previous.files.map((f) => f.path), ...bundle.files.map((f) => f.path)]);
    for (const path of [...paths].sort()) {
      const a = previous.files.find((f) => f.path === path)?.content ?? '';
      const b = bundle.files.find((f) => f.path === path)?.content ?? '';
      if (a !== b) changed.push(`--- ${path}`, ...lineDiff(a, b));
    }
    out.push(
      '',
      changed.length ? 'changes since the last approved deploy:' : 'no change since the last approved deploy',
      ...changed,
    );
  } else
    out.push('', 'no earlier approved deploy of this environment on this workstation: every file is new');
  out.push('', 'recipe files:');
  for (const f of bundle.files)
    out.push(
      `--- ${f.path}`,
      f.content.length > MAX_FILE ? `${f.content.slice(0, MAX_FILE)}\n... (cut)` : f.content,
    );
  return out.join('\n');
}

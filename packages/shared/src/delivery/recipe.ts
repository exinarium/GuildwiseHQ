import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { sha256Hex } from '../graph/sha256.ts';
import { RunHealthSchema } from '../runs/plan.ts';
import { EnvNameSchema, type Gate, GateSchema } from './gate.ts';

/**
 * Delivery recipes (docs/design/ceo-front-door.md section 9). A recipe is `delivery/recipe.yaml` plus the scripts it names,
 * kept in the PROJECT vault (never the organization vault). The Owner approves one exact content hash of `delivery/`; a run
 * is pinned to that hash and the workstation re-checks it before it runs anything. No model runs a deploy command.
 */

export const DELIVERY_DIR = 'delivery';
export const RECIPE_FILE = 'recipe.yaml';
export const RECIPE_VERSION = 1;

/** The template variables an environment's `args` may use. */
export const RECIPE_TEMPLATE_VARS = [
  'checkout',
  'commit',
  'branch',
  'env',
  'appUrl',
  'target',
  'host',
] as const;
export type RecipeTemplateVar = (typeof RECIPE_TEMPLATE_VARS)[number];

export const TRIGGERS = ['after_merge', 'phase_done', 'on_request'] as const;
export const TriggerSchema = z.enum(TRIGGERS);
export type Trigger = z.infer<typeof TriggerSchema>;

/** Who releases an environment once its gate's requirements hold. The CEO is never the releaser unless the recipe says so. */
export const RELEASERS = ['owner', 'ceo', 'auto'] as const;
export const ReleasedBySchema = z.enum(RELEASERS);
export type ReleasedBy = z.infer<typeof ReleasedBySchema>;

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const SafeRelPath = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (p) => !p.startsWith('/') && !p.includes('\0') && !p.split('/').includes('..') && !/^[A-Za-z]:/.test(p),
    {
      message: 'a path inside delivery/ (no leading slash, no ..)',
    },
  );

const Health = RunHealthSchema.refine((h) => h.kind !== 'tcp' || typeof h.port === 'number', {
  message: 'a tcp health check needs a port number',
});

const RecipeEnvInput = z
  .object({
    name: EnvNameSchema,
    /** The deploy target (`deploy_targets.name` of the project) this environment goes to. Several: a server list. */
    target: z.string().min(1).max(80).optional(),
    targets: z.array(z.string().min(1).max(80)).min(1).max(20).optional(),
    /** The repository (`project_repos.name`) whose commit is checked out; absent: the project's only repository. */
    repo: z.string().min(1).max(120).optional(),
    script: SafeRelPath,
    args: z.array(z.string().max(500)).max(30).default([]),
    trigger: z.union([TriggerSchema, z.array(TriggerSchema).max(3)]).default('on_request'),
    timeoutSec: z.number().int().min(10).max(21_600).default(3600),
    health: Health.default({ kind: 'none', graceSec: 3 }),
    smoke: SafeRelPath.optional(),
    secrets: z.array(z.string().regex(SECRET_NAME, 'a secret name is UPPER_SNAKE_CASE')).max(30).default([]),
    /** A file on the workstation that holds the secret values (KEY=value lines). Only the path is in the recipe. */
    envFile: z.string().min(1).max(500).optional(),
    /** Runs outside the model sandbox (as run services do): the script talks to Docker or a remote host. */
    docker: z.boolean().default(false),
    /** Who releases this environment. Default: the release queue (the Owner or an Admin clicks Release). */
    releasedBy: ReleasedBySchema.default('owner'),
    /** `none`, the name of an organization gate preset, or an inline gate. */
    gate: z.union([z.literal('none'), z.string().min(1).max(60), GateSchema]).default('none'),
  })
  .refine((e) => !!e.target !== !!e.targets, { message: 'give either target or targets' });

export const RecipeSchema = z.object({
  version: z.literal(RECIPE_VERSION),
  environments: z.array(RecipeEnvInput).min(1).max(12),
});

export interface RecipeEnv {
  name: string;
  targets: string[];
  repo?: string | undefined;
  script: string;
  args: string[];
  triggers: Trigger[];
  timeoutSec: number;
  health: z.infer<typeof RunHealthSchema>;
  smoke?: string | undefined;
  secrets: string[];
  envFile?: string | undefined;
  docker: boolean;
  releasedBy: ReleasedBy;
  gate: 'none' | string | Gate;
}
export interface Recipe {
  version: 1;
  environments: RecipeEnv[];
}

/** What the server stores of an environment (and shows): the same fields, normalized. */
export const normalizeRecipe = (r: z.infer<typeof RecipeSchema>): Recipe => ({
  version: 1,
  environments: r.environments.map((e) => ({
    name: e.name,
    targets: e.targets ?? [e.target as string],
    ...(e.repo ? { repo: e.repo } : {}),
    script: e.script,
    args: e.args,
    triggers: Array.isArray(e.trigger) ? e.trigger : [e.trigger],
    timeoutSec: e.timeoutSec,
    health: e.health,
    ...(e.smoke ? { smoke: e.smoke } : {}),
    secrets: e.secrets,
    ...(e.envFile ? { envFile: e.envFile } : {}),
    docker: e.docker,
    releasedBy: e.releasedBy,
    gate: e.gate,
  })),
});

export type RecipeParse = { ok: true; recipe: Recipe } | { ok: false; error: string };

/** Parses `recipe.yaml` text. Never throws. */
export function parseRecipe(text: string): RecipeParse {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return {
      ok: false,
      error: `recipe.yaml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const r = RecipeSchema.safeParse(raw);
  if (!r.success)
    return {
      ok: false,
      error: r.error.issues
        .map((i) => `${i.path.join('.') || 'recipe'}: ${i.message}`)
        .join('; ')
        .slice(0, 800),
    };
  const names = r.data.environments.map((e) => e.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return { ok: false, error: `environment ${dup} is listed twice` };
  return { ok: true, recipe: normalizeRecipe(r.data) };
}

/** `${checkout}` style templates; an unknown name is left as it is (the lint reports it). */
export function expandTemplate(s: string, vars: Partial<Record<RecipeTemplateVar, string>>): string {
  return s.replace(/\$\{([A-Za-z]+)\}/g, (m, name: string) => vars[name as RecipeTemplateVar] ?? m);
}

export const unknownTemplateVars = (s: string): string[] =>
  [...s.matchAll(/\$\{([A-Za-z]+)\}/g)]
    .map((m) => m[1] as string)
    .filter((n) => !(RECIPE_TEMPLATE_VARS as readonly string[]).includes(n));

// ---------------------------------------------------------------------------------------------------- the content hash

export interface BundleEntry {
  /** Relative to `delivery/`, `/`-separated. */
  path: string;
  /** `755` when the owner-executable bit is set, else `644`: the only mode bit that changes what runs. */
  mode: '755' | '644';
  sha256: string;
}

/** `sha256` over the sorted listing `path\0mode\0sha256(content)\n`: order-independent, working-tree state never enters. */
export function bundleHash(entries: readonly BundleEntry[]): string {
  let listing = '';
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
    listing += `${e.path}\0${e.mode}\0${e.sha256}\n`;
  return sha256Hex(listing);
}

// ---------------------------------------------------------------------------------------------------- lint

export interface LintItem {
  level: 'error' | 'warn';
  code:
    | 'no_recipe'
    | 'parse_error'
    | 'missing_script'
    | 'not_executable'
    | 'secret_in_file'
    | 'unknown_target'
    | 'unknown_preset'
    | 'production_no_gate'
    | 'unknown_template'
    | 'unknown_env_in_gate'
    | 'unknown_repo'
    | 'dry_run_missing';
  message: string;
  env?: string;
  path?: string;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'a GitHub token'],
  [/\bsk-[A-Za-z0-9_-]{24,}\b/, 'an API key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [
    /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?(?![\s"'$<{])[A-Za-z0-9/+_.=-]{12,}["']?/i,
    'a hard-coded credential',
  ],
];

/** What a secret scan found in a text, or null. The text itself is never returned. */
export function findSecret(text: string): string | null {
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what;
  return null;
}

export interface LintInput {
  recipe: Recipe | null;
  parseError?: string | undefined;
  /** Every file of the bundle (without content): `path` is relative to `delivery/`. */
  files: Array<{ path: string; mode: '755' | '644'; secret?: string | null | undefined }>;
  /** Known to the caller, else the checks are skipped. */
  targets?: Array<{ name: string; production: boolean }> | undefined;
  presets?: string[] | undefined;
  repos?: string[] | undefined;
}

/** The recipe lint (section 9.4): problems the Owner should see before approving, and errors that stop an approval. */
export function lintRecipe(i: LintInput): LintItem[] {
  const out: LintItem[] = [];
  for (const f of i.files)
    if (f.secret)
      out.push({
        level: 'error',
        code: 'secret_in_file',
        path: f.path,
        message: `${f.path} contains ${f.secret}: secrets are named in the recipe and kept on the workstation`,
      });
  if (i.parseError) {
    out.push({ level: 'error', code: 'parse_error', message: i.parseError });
    return out;
  }
  if (!i.recipe) {
    out.push({ level: 'error', code: 'no_recipe', message: 'there is no delivery/recipe.yaml' });
    return out;
  }
  const byPath = new Map(i.files.map((f) => [f.path, f]));
  const envNames = new Set(i.recipe.environments.map((e) => e.name));
  for (const e of i.recipe.environments) {
    for (const [kind, p] of [
      ['script', e.script],
      ['smoke', e.smoke],
    ] as const) {
      if (!p) continue;
      const f = byPath.get(p);
      if (!f)
        out.push({
          level: 'error',
          code: 'missing_script',
          env: e.name,
          path: p,
          message: `${e.name}: the ${kind} ${p} is not in delivery/`,
        });
      else if (f.mode !== '755')
        out.push({
          level: 'error',
          code: 'not_executable',
          env: e.name,
          path: p,
          message: `${e.name}: ${p} is not executable (chmod +x)`,
        });
    }
    for (const a of [...e.args, e.envFile ?? '']) {
      const bad = unknownTemplateVars(a);
      if (bad.length)
        out.push({
          level: 'error',
          code: 'unknown_template',
          env: e.name,
          message: `${e.name}: unknown template ${bad.map((b) => `\${${b}}`).join(', ')}`,
        });
    }
    if (i.targets) {
      for (const t of e.targets) {
        const known = i.targets.find((x) => x.name.toLowerCase() === t.toLowerCase());
        if (!known)
          out.push({
            level: 'error',
            code: 'unknown_target',
            env: e.name,
            message: `${e.name}: the deploy target ${t} does not exist in this project`,
          });
        else if (known.production && e.gate === 'none' && e.releasedBy === 'auto')
          out.push({
            level: 'error',
            code: 'production_no_gate',
            env: e.name,
            message: `${e.name}: ${t} is a production target: it needs a gate, or release by the Owner or the CEO (not automatic with no gate)`,
          });
      }
    }
    if (typeof e.gate === 'string' && e.gate !== 'none' && i.presets && !i.presets.includes(e.gate))
      out.push({
        level: 'error',
        code: 'unknown_preset',
        env: e.name,
        message: `${e.name}: there is no gate preset named ${e.gate}`,
      });
    const inline = typeof e.gate === 'object' ? e.gate : null;
    for (const r of inline?.requires ?? [])
      if ('envHealthy' in r && !envNames.has(r.envHealthy))
        out.push({
          level: 'error',
          code: 'unknown_env_in_gate',
          env: e.name,
          message: `${e.name}: the gate names ${r.envHealthy}, which is not an environment of this recipe`,
        });
    if (e.repo && i.repos && !i.repos.some((r) => r.toLowerCase() === e.repo?.toLowerCase()))
      out.push({
        level: 'error',
        code: 'unknown_repo',
        env: e.name,
        message: `${e.name}: the repository ${e.repo} is not attached to this project`,
      });
  }
  return out;
}

export const lintHasErrors = (l: readonly LintItem[]): boolean => l.some((x) => x.level === 'error');

/** The gate of an environment, resolved against the organization's presets and bindings. `null`: a preset that does not exist. */
export function resolveGate(env: Pick<RecipeEnv, 'gate'>, presets: Record<string, Gate>): Gate | null {
  if (env.gate === 'none') return { requires: [] };
  if (typeof env.gate === 'string') return presets[env.gate] ?? null;
  return env.gate;
}

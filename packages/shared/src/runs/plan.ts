import { z } from 'zod';

/**
 * Run plans and run settings (docs/design/run-and-integration-tests.md sections 2 and 5). A run plan is what the
 * workstation's DevOps engineer worked out to run a project: setup steps and services. Plans live in Guildwise, never in
 * the repository. Validation is shared: the server checks a saved plan and the runner checks every step it is given.
 */

/** Service, step and port names: short, safe in file names, URLs and `${svc.port}` templates. */
export const RunNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/i, 'use letters, digits, "-" and "_" (at most 40 characters)');

export const RunEnvVarNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/);

export const RunPortSchema = z.object({
  name: RunNameSchema,
  default: z.number().int().min(1).max(65535),
  /** The environment variable the app reads its port from; set when the default is taken and a free port is allocated. */
  envVar: RunEnvVarNameSchema.optional(),
  /** Where a person opens it, `http://localhost:${port}/`. */
  url: z.string().max(300).optional(),
});
export type RunPort = z.infer<typeof RunPortSchema>;

export const RunHealthSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http'),
    url: z.string().min(1).max(500),
    expect: z.enum(['2xx', '2xx3xx']).default('2xx'),
  }),
  /** `port`: a number, or the name of one of the service's ports. */
  z.object({ kind: z.literal('tcp'), port: z.union([z.number().int().min(1).max(65535), RunNameSchema]) }),
  z.object({ kind: z.literal('log'), regex: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('none'), graceSec: z.number().int().min(0).max(300).default(3) }),
]);
export type RunHealth = z.infer<typeof RunHealthSchema>;

const Cmd = z.array(z.string().max(2000)).min(1).max(100);

export const RunSetupStepSchema = z.object({
  name: z.string().min(1).max(80),
  repoId: z.uuid(),
  /** Relative to the repository's run worktree. */
  cwd: z.string().max(300).default('.'),
  cmd: Cmd,
  timeoutSec: z.number().int().min(1).max(7200).default(1200),
  when: z.string().max(200).default('always'),
  /** Plain-language name shown in the guided editor ("Install packages"); absent on plans DevOps wrote before. */
  label: z.string().max(120).optional(),
  /** The guided template this step was made from (`packages/shared/src/runs/templates.ts`), so it can be edited as one. */
  template: z.string().max(40).optional(),
});
export type RunSetupStep = z.infer<typeof RunSetupStepSchema>;

export const RunServiceSchema = z.object({
  name: RunNameSchema,
  repoId: z.uuid(),
  cwd: z.string().max(300).default('.'),
  cmd: Cmd,
  /** Absolute path of an env file on the workstation, outside every worktree. Only the path is stored. */
  envFile: z.string().max(500).optional(),
  /** No secrets. May use `${port}`, `${svc.port}` and `${svc.name}` templates. */
  env: z.record(RunEnvVarNameSchema, z.string().max(1000)).default({}),
  ports: z.array(RunPortSchema).max(10).default([]),
  health: RunHealthSchema.default({ kind: 'none', graceSec: 3 }),
  startTimeoutSec: z.number().int().min(1).max(3600).default(300),
  after: z.array(RunNameSchema).max(20).default([]),
  stopCmd: Cmd.optional(),
  docker: z.boolean().default(false),
  /** Plain-language name shown in the guided editor ("The website"). */
  label: z.string().max(120).optional(),
  /** The guided template this service was made from. */
  template: z.string().max(40).optional(),
});
export type RunService = z.infer<typeof RunServiceSchema>;

export const RunPlanSchema = z.object({
  version: z.literal(1).default(1),
  repos: z
    .array(z.object({ repoId: z.uuid(), subdir: z.string().max(300).optional() }))
    .max(20)
    .default([]),
  setup: z.array(RunSetupStepSchema).max(50).default([]),
  services: z.array(RunServiceSchema).max(20).default([]),
  /** What DevOps learned; shown in the settings. */
  notes: z.string().max(10000).default(''),
});
export type RunPlan = z.infer<typeof RunPlanSchema>;

/** A relative path that stays inside its base: no absolute path, no `..`, no NUL. */
export function isSafeRelativeDir(p: string): boolean {
  if (p.includes('\0') || p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[\\/]+/).includes('..');
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/** Services in start order (dependencies first, otherwise as listed); null when `after` has a cycle. */
export function runOrder<T extends { name: string; after: string[] }>(services: T[]): T[] | null {
  const by = new Map(services.map((s) => [s.name.toLowerCase(), s]));
  const out: T[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (s: T): boolean => {
    const k = s.name.toLowerCase();
    if (state.get(k) === 'done') return true;
    if (state.get(k) === 'visiting') return false;
    state.set(k, 'visiting');
    for (const a of s.after) {
      const dep = by.get(a.toLowerCase());
      if (dep && !visit(dep)) return false;
    }
    state.set(k, 'done');
    out.push(s);
    return true;
  };
  for (const s of services) if (!visit(s)) return null;
  return out;
}

/** The named services plus everything they depend on, in start order. */
export function withDependencies<T extends { name: string; after: string[] }>(
  services: T[],
  wanted: string[],
): T[] {
  const by = new Map(services.map((s) => [s.name.toLowerCase(), s]));
  const keep = new Set<string>();
  const add = (n: string) => {
    const s = by.get(n.toLowerCase());
    if (!s || keep.has(s.name.toLowerCase())) return;
    keep.add(s.name.toLowerCase());
    for (const a of s.after) add(a);
  };
  for (const w of wanted) add(w);
  return (runOrder(services) ?? services).filter((s) => keep.has(s.name.toLowerCase()));
}

/** Problems with a plan the schema cannot see (empty list: fine). */
export function validateRunPlan(plan: RunPlan): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const s of plan.services) {
    if (names.has(s.name.toLowerCase())) problems.push(`service "${s.name}" appears twice`);
    names.add(s.name.toLowerCase());
  }
  for (const s of plan.services) {
    if (!isSafeRelativeDir(s.cwd)) problems.push(`service "${s.name}": cwd must stay inside the repository`);
    if (s.envFile && !isAbsolutePath(s.envFile))
      problems.push(`service "${s.name}": envFile must be an absolute path on the workstation`);
    for (const a of s.after)
      if (!names.has(a.toLowerCase())) problems.push(`service "${s.name}": after "${a}" is not a service`);
    const seen = new Set<string>();
    for (const p of s.ports) {
      if (seen.has(p.name.toLowerCase()))
        problems.push(`service "${s.name}": port "${p.name}" appears twice`);
      seen.add(p.name.toLowerCase());
    }
  }
  for (const st of plan.setup)
    if (!isSafeRelativeDir(st.cwd)) problems.push(`step "${st.name}": cwd must stay inside the repository`);
  if (runOrder(plan.services) === null)
    problems.push('the "after" dependencies of the services form a cycle');
  return problems;
}

/** Splits a command line into an argv array (single and double quotes, backslash escapes). No shell is involved. */
export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** The inverse of `parseCommandLine` for display. */
export function formatCommandLine(argv: string[]): string {
  return argv
    .map((a) => (a === '' || /[\s"'\\]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a))
    .join(' ');
}

/**
 * `--port name:default[:ENVVAR]` of `aom run service` (and the settings form). The URL a person opens is
 * `http://localhost:<port>/` for ports named like a web endpoint.
 */
export function parseRunPort(spec: string): RunPort {
  const [name, def, envVar, ...rest] = spec.split(':');
  const port = Number(def);
  if (!name || rest.length || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`a port is name:number[:ENV_VAR], for example http:5000:PORT (got "${spec}")`);
  return RunPortSchema.parse({
    name,
    default: port,
    ...(envVar ? { envVar } : {}),
    ...(WEB_PORT_NAMES.test(name)
      ? { url: `${/^https$/i.test(name) ? 'https' : 'http'}://localhost:\${port}/` }
      : {}),
  });
}
const WEB_PORT_NAMES = /^(https?|web|ui|app|frontend|site|api|admin|dashboard)$/i;

/** `--health http://...`, `tcp:<port or port name>`, `log:<regex>`, `none[:graceSec]`. */
export function parseRunHealth(spec: string): RunHealth {
  if (/^https?:\/\//i.test(spec)) return RunHealthSchema.parse({ kind: 'http', url: spec });
  const m = /^(tcp|log|none):(.*)$/s.exec(spec) ?? (spec === 'none' ? ['', 'none', ''] : null);
  if (!m)
    throw new Error(`a health check is a URL, tcp:<port>, log:<regex> or none[:seconds] (got "${spec}")`);
  const [, kind, rest] = m as unknown as [string, string, string];
  if (kind === 'tcp')
    return RunHealthSchema.parse({ kind: 'tcp', port: /^\d+$/.test(rest) ? Number(rest) : rest });
  if (kind === 'log') return RunHealthSchema.parse({ kind: 'log', regex: rest });
  return RunHealthSchema.parse({ kind: 'none', ...(rest ? { graceSec: Number(rest) } : {}) });
}

/** The inverse of `parseRunPort` / `parseRunHealth`, for the settings form and the plan view. */
export const formatRunPort = (p: RunPort): string =>
  `${p.name}:${p.default}${p.envVar ? `:${p.envVar}` : ''}`;
export function formatRunHealth(h: RunHealth): string {
  if (h.kind === 'http') return h.url;
  if (h.kind === 'tcp') return `tcp:${h.port}`;
  if (h.kind === 'log') return `log:${h.regex}`;
  return `none:${h.graceSec}`;
}

// ------------------------------------------------------------------------------------------ project settings

/** A service the project declares in Project settings > Run & test. It pre-fills the plan; DevOps may not contradict it. */
export const RunDeclaredServiceSchema = z.object({
  name: RunNameSchema,
  repoId: z.uuid(),
  cwd: z.string().max(300).default('.'),
  cmd: Cmd.optional(),
  envFile: z.string().max(500).optional(),
  ports: z.array(RunPortSchema).max(10).default([]),
  health: RunHealthSchema.optional(),
  after: z.array(RunNameSchema).max(20).default([]),
});
export type RunDeclaredService = z.infer<typeof RunDeclaredServiceSchema>;

export const DEFAULT_RUN_TTL_HOURS = 8;
export const RunSettingsSchema = z.object({
  /** Manual environments stop after this many hours (Extend adds the same again). */
  ttlHours: z.number().int().min(1).max(72).default(DEFAULT_RUN_TTL_HOURS),
  /** Branch code may use Docker (compose, docker run): such steps run outside any service sandbox. */
  allowDocker: z.boolean().default(false),
  services: z.array(RunDeclaredServiceSchema).max(20).default([]),
  /**
   * Build guide(s): absolute path(s) on the workstation. When set they replace the runner's discovery of BUILD.md (in the
   * repository and in the folders above the clones); the runner reads them and passes them to the DevOps engineer as text.
   */
  buildGuides: z.array(z.string().min(1).max(500)).max(5).default([]),
});
export type RunSettings = z.infer<typeof RunSettingsSchema>;

/** Problems with the declared services (names, dependencies, safe paths). */
export function validateRunSettings(s: RunSettings): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const d of s.services) {
    if (names.has(d.name.toLowerCase())) problems.push(`service "${d.name}" appears twice`);
    names.add(d.name.toLowerCase());
  }
  for (const d of s.services) {
    if (!isSafeRelativeDir(d.cwd)) problems.push(`service "${d.name}": cwd must stay inside the repository`);
    if (d.envFile && !isAbsolutePath(d.envFile))
      problems.push(`service "${d.name}": the env file must be an absolute path on the workstation`);
    for (const a of d.after)
      if (!names.has(a.toLowerCase())) problems.push(`service "${d.name}": after "${a}" is not a service`);
  }
  for (const g of s.buildGuides)
    if (!isAbsolutePath(g)) problems.push(`build guide "${g}": must be an absolute path on the workstation`);
  if (runOrder(s.services.map((d) => ({ name: d.name, after: d.after }))) === null)
    problems.push('the "after" dependencies form a cycle');
  return problems;
}

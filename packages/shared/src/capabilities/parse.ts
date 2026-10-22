import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { sha256Hex } from '../graph/sha256.ts';

/**
 * Capability Registry v0 (docs/design/discovery-boardroom-registry.md). Three kinds, one tree layout:
 *
 *   skills/<key>/SKILL.md [+ scripts/ references/ assets/]   Agent Skills open standard
 *   personas/<key>.md                                          frontmatter + persona prompt
 *   playbooks/<key>/workflow.md + steps/step-NN-*.md [+ assets/*.csv]
 *
 * The same layout is used by the built-ins (`packages/capabilities/`) and by the organization vault (`org/skills/`,
 * `org/personas/`, `org/playbooks/`, so the vault root passed to `indexCapabilityTree` is `org/`). Everything here is pure.
 */

export const CAPABILITY_KINDS = ['skill', 'persona', 'playbook'] as const;
export const CapabilityKindSchema = z.enum(CAPABILITY_KINDS);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;

/** Where a capability came from. Later sources override earlier ones with the same kind and key. */
export const CapabilitySourceSchema = z.enum(['builtin', 'org-vault']);
export type CapabilitySource = z.infer<typeof CapabilitySourceSchema>;

/** Lowercase letters and digits joined by single hyphens, at most 64 characters (the Agent Skills `name` rule). */
export const CapabilityKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and single hyphens');

/** The only thing the runner reports to the server about a vault capability: never the content. */
export const CapabilityMetaSchema = z.object({
  key: CapabilityKeySchema,
  kind: CapabilityKindSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(1024),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  source: CapabilitySourceSchema,
});
export type CapabilityMeta = z.infer<typeof CapabilityMetaSchema>;

// ---------------------------------------------------------------------------------------------------- frontmatter

/** Splits `---\nyaml\n---\nbody`. Throws a readable error when the frontmatter is missing or is not a YAML mapping. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(src);
  if (!m) throw new Error('missing frontmatter: the file must start with a --- block');
  let data: unknown;
  try {
    data = parseYaml(m[1] ?? '');
  } catch (err) {
    throw new Error(`frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter must be a YAML mapping');
  return { data: data as Record<string, unknown>, body: (m[2] ?? '').replace(/^\n+/, '') };
}

// ---------------------------------------------------------------------------------------------------- skills

/** Agent Skills spec: `name` (matches the directory), `description`, optional `license`, `compatibility`, `metadata`, `allowed-tools`. */
export const SkillFrontmatterSchema = z.object({
  name: CapabilityKeySchema,
  description: z.string().min(1).max(1024),
  license: z.string().max(500).optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.coerce.string()).optional(),
  /** Space-delimited tool names. In v0 this is informational: it never grants an agent anything (see `ALLOWED_TOOLS_NOTE`). */
  'allowed-tools': z.string().max(1000).optional(),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export const ALLOWED_TOOLS_NOTE =
  "A skill's `allowed-tools` is advisory in v0: it never adds a permission to an agent. The agent's own role permissions decide what it may do.";

// ---------------------------------------------------------------------------------------------------- personas

export const PersonaFrontmatterSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1024),
  stance: z.string().min(1).max(500),
  voice: z.string().min(1).max(500),
  icon: z.string().min(1).max(60),
  model: z.string().min(1).max(100).optional(),
  tools: z.array(z.string().min(1).max(60)).max(30).optional(),
  skills: z.array(CapabilityKeySchema).max(30).optional(),
});
export type PersonaFrontmatter = z.infer<typeof PersonaFrontmatterSchema>;

// ---------------------------------------------------------------------------------------------------- playbooks

export const PlaybookFrontmatterSchema = z.object({
  name: CapabilityKeySchema,
  description: z.string().min(1).max(1024),
});
export type PlaybookFrontmatter = z.infer<typeof PlaybookFrontmatterSchema>;

export const STEP_FILE_RE = /^steps\/step-(\d{2})-[a-z0-9][a-z0-9-]*\.md$/;

// ---------------------------------------------------------------------------------------------------- the parsed forms

interface Base {
  key: string;
  /** Path of the file that carries the frontmatter, relative to the capability root (`SKILL.md`, `<key>.md`, `workflow.md`). */
  main: string;
  /** Every file of the capability, by path relative to its root. */
  files: Record<string, string>;
  hash: string;
}

export type ParsedCapability =
  | (Base & { kind: 'skill'; name: string; description: string; meta: SkillFrontmatter; body: string })
  | (Base & { kind: 'persona'; name: string; description: string; meta: PersonaFrontmatter; body: string })
  | (Base & {
      kind: 'playbook';
      name: string;
      description: string;
      meta: PlaybookFrontmatter;
      body: string;
      /** `steps/step-NN-*.md`, in order. */
      steps: string[];
    });

export interface CapabilityIssue {
  /** Path in the tree, for example `skills/foo/SKILL.md`. */
  path: string;
  message: string;
}

/** Hash of all files of one capability: stable under file order, changes with any path or byte. */
export function hashCapabilityFiles(files: Record<string, string>): string {
  return sha256Hex(
    Object.keys(files)
      .sort()
      .map((p) => `${p}\u0000${files[p]}`)
      .join('\u0001'),
  );
}

const zodMessage = (err: z.ZodError): string =>
  err.issues.map((i) => `${i.path.join('.') || 'frontmatter'}: ${i.message}`).join('; ');

export function parseSkill(key: string, files: Record<string, string>): ParsedCapability {
  const main = files['SKILL.md'];
  if (main === undefined) throw new Error('a skill needs a SKILL.md');
  const { data, body } = splitFrontmatter(main);
  const r = SkillFrontmatterSchema.safeParse(data);
  if (!r.success) throw new Error(zodMessage(r.error));
  if (r.data.name !== key) throw new Error(`name "${r.data.name}" must match the directory name "${key}"`);
  return {
    kind: 'skill',
    key,
    main: 'SKILL.md',
    files,
    hash: hashCapabilityFiles(files),
    name: r.data.name,
    description: r.data.description,
    meta: r.data,
    body,
  };
}

export function parsePersona(key: string, text: string): ParsedCapability {
  const { data, body } = splitFrontmatter(text);
  const r = PersonaFrontmatterSchema.safeParse(data);
  if (!r.success) throw new Error(zodMessage(r.error));
  if (!body.trim()) throw new Error('a persona needs a prompt after the frontmatter');
  const files = { [`${key}.md`]: text };
  return {
    kind: 'persona',
    key,
    main: `${key}.md`,
    files,
    hash: hashCapabilityFiles(files),
    name: r.data.name,
    description: r.data.description,
    meta: r.data,
    body,
  };
}

export function parsePlaybook(key: string, files: Record<string, string>): ParsedCapability {
  const main = files['workflow.md'];
  if (main === undefined) throw new Error('a playbook needs a workflow.md');
  const { data, body } = splitFrontmatter(main);
  const r = PlaybookFrontmatterSchema.safeParse(data);
  if (!r.success) throw new Error(zodMessage(r.error));
  if (r.data.name !== key) throw new Error(`name "${r.data.name}" must match the directory name "${key}"`);
  const steps = Object.keys(files)
    .filter((p) => p.startsWith('steps/'))
    .sort();
  const seen = new Set<string>();
  for (const s of steps) {
    const m = STEP_FILE_RE.exec(s);
    if (!m) throw new Error(`"${s}" is not named steps/step-NN-<name>.md`);
    if (seen.has(m[1] as string)) throw new Error(`two steps share the number ${m[1]}`);
    seen.add(m[1] as string);
  }
  return {
    kind: 'playbook',
    key,
    main: 'workflow.md',
    files,
    hash: hashCapabilityFiles(files),
    name: r.data.name,
    description: r.data.description,
    meta: r.data,
    body,
    steps,
  };
}

/** The most files and bytes one capability may have: a vault is not trusted to be small. */
export const CAPABILITY_MAX_FILES = 200;
export const CAPABILITY_MAX_FILE_BYTES = 512 * 1024;

/**
 * Indexes a tree of files (`path -> text`, paths relative to the capability root, `/` separators) into capabilities.
 * A bad capability becomes an issue and is skipped; the others are still returned.
 */
export function indexCapabilityTree(tree: Record<string, string>): {
  entries: ParsedCapability[];
  issues: CapabilityIssue[];
} {
  const entries: ParsedCapability[] = [];
  const issues: CapabilityIssue[] = [];
  const groups = new Map<string, Record<string, string>>(); // "skills/key" | "playbooks/key" -> files
  for (const [rawPath, text] of Object.entries(tree)) {
    const path = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = path.split('/');
    if (parts.includes('..') || path.startsWith('/')) {
      issues.push({ path, message: 'path escapes the capability tree' });
      continue;
    }
    if (parts[0] === 'personas' && parts.length === 2 && parts[1]?.endsWith('.md')) {
      const key = parts[1].slice(0, -3);
      try {
        if (!CapabilityKeySchema.safeParse(key).success)
          throw new Error('the file name must be lowercase letters, digits and single hyphens');
        entries.push(parsePersona(key, text));
      } catch (err) {
        issues.push({ path, message: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }
    if ((parts[0] === 'skills' || parts[0] === 'playbooks') && parts.length >= 3 && parts[1]) {
      const id = `${parts[0]}/${parts[1]}`;
      const files = groups.get(id) ?? {};
      files[parts.slice(2).join('/')] = text;
      groups.set(id, files);
    }
  }
  for (const [id, files] of groups) {
    const [dir, key] = id.split('/') as [string, string];
    const path = `${id}/${dir === 'skills' ? 'SKILL.md' : 'workflow.md'}`;
    try {
      if (!CapabilityKeySchema.safeParse(key).success)
        throw new Error('the directory name must be lowercase letters, digits and single hyphens');
      if (Object.keys(files).length > CAPABILITY_MAX_FILES) throw new Error('too many files');
      for (const [p, t] of Object.entries(files))
        if (t.length > CAPABILITY_MAX_FILE_BYTES) throw new Error(`${p} is too large`);
      entries.push(dir === 'skills' ? parseSkill(key, files) : parsePlaybook(key, files));
    } catch (err) {
      issues.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind.localeCompare(b.kind)));
  return { entries, issues };
}

export function capabilityMeta(e: ParsedCapability, source: CapabilitySource): CapabilityMeta {
  return {
    key: e.key,
    kind: e.kind,
    name: e.name,
    description: e.description.slice(0, 1024),
    hash: e.hash,
    source,
  };
}

/** The unique id of a capability inside a registry: keys are only unique within a kind. */
export const capabilityId = (c: { kind: CapabilityKind; key: string }): string => `${c.kind}:${c.key}`;

/**
 * The effective registry: later sources override earlier ones by kind and key (built-in, then org vault). The result is
 * sorted by kind then key.
 */
export function mergeRegistry(...sources: CapabilityMeta[][]): CapabilityMeta[] {
  const byId = new Map<string, CapabilityMeta>();
  for (const list of sources) for (const m of list) byId.set(capabilityId(m), m);
  return [...byId.values()].sort((a, b) =>
    a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind.localeCompare(b.kind),
  );
}

/**
 * Finds the capability a name in `skills: string[]` or on the command line means. `kind:key` is exact; a bare key tries
 * skill, then playbook, then persona.
 */
export function resolveCapabilityRef<T extends { kind: CapabilityKind; key: string }>(
  ref: string,
  all: readonly T[],
): T | undefined {
  const colon = ref.indexOf(':');
  if (colon > 0) {
    const kind = ref.slice(0, colon);
    const key = ref.slice(colon + 1);
    return all.find((c) => c.kind === kind && c.key === key);
  }
  for (const kind of CAPABILITY_KINDS) {
    const hit = all.find((c) => c.kind === kind && c.key === ref);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The index an agent sees in its instructions for the capabilities its role names: name and description only, plus how to
 * load one. Unknown names are listed as unavailable so a typo in a role is visible.
 */
export function renderCapabilityIndex(
  refs: readonly string[],
  all: readonly Pick<CapabilityMeta, 'kind' | 'key' | 'name' | 'description'>[],
): string {
  if (refs.length === 0) return '';
  const lines = refs.map((r) => {
    const hit = resolveCapabilityRef(r, all);
    return hit
      ? `- \`${hit.kind}:${hit.key}\` ${hit.name}: ${hit.description}`
      : `- \`${r}\`: not found in the registry on this workstation`;
  });
  return [
    '# Capabilities',
    'These skills, playbooks and personas are available to you. Load one only when it fits the task: `aom skill show <key>` prints it; for a playbook add `--file steps/<name>` to read a step or an asset. Do not load them all.',
    ...lines,
  ].join('\n');
}

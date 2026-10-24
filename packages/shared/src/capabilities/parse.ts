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

/**
 * Where a capability came from. Precedence, lowest first: built-in, organization vault, project repository, imported pack
 * (`SOURCE_RANK`). A later source overrides an earlier one with the same kind and key; a pack's keys are namespaced
 * (`bmad:analyst`) so in practice a pack never shadows anything by accident.
 */
export const CAPABILITY_SOURCES = ['builtin', 'org-vault', 'project-repo', 'pack'] as const;
export const CapabilitySourceSchema = z.enum(CAPABILITY_SOURCES);
export type CapabilitySource = z.infer<typeof CapabilitySourceSchema>;

/** Lowercase letters and digits joined by single hyphens, at most 64 characters (the Agent Skills `name` rule). */
export const CapabilityKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and single hyphens');

export const SOURCE_RANK: Record<CapabilitySource, number> = {
  builtin: 0,
  'org-vault': 1,
  'project-repo': 2,
  pack: 3,
};

/** A key inside an imported pack: `<pack>:<key>`, each part lowercase letters, digits and single hyphens. */
export const PackedKeySchema = z
  .string()
  .min(3)
  .max(129)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$/, '<pack>:<key>');
/** A plain key or a pack key. */
export const AnyCapabilityKeySchema = z.union([CapabilityKeySchema, PackedKeySchema]);
export const packedKey = (pack: string, key: string): string => `${pack}:${key}`;
export const isPackedKey = (key: string): boolean => key.includes(':');

/** The only thing the runner reports to the server about a vault capability: never the content. */
const MetaExtras = {
  /** The pack this comes from (`source 'pack'`). */
  pack: CapabilityKeySchema.optional(),
  hasScripts: z.boolean().optional(),
  tags: z.array(z.string().max(40)).max(10).optional(),
  icon: z.string().max(60).optional(),
  /** A persona's declared tools (advisory; read when it is hired from a pack to map a permission preset). */
  tools: z.array(z.string().max(60)).max(30).optional(),
  /** Where a project-repository capability lives in its checkout (`.claude/skills/<name>`), for the review list. */
  path: z.string().max(300).optional(),
};
const MetaBase = {
  kind: CapabilityKindSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(1024),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  source: CapabilitySourceSchema,
  ...MetaExtras,
};
export const CapabilityMetaSchema = z.object({ key: CapabilityKeySchema, ...MetaBase });
/** What a registry lists: the same, with a pack's `<pack>:<key>` keys allowed. */
export const RegistryMetaSchema = z.object({ key: AnyCapabilityKeySchema, ...MetaBase });
export type CapabilityMeta = Omit<z.infer<typeof RegistryMetaSchema>, 'key'> & { key: string };

// ---------------------------------------------------------------------------------------------------- frontmatter

/** Splits `---\nyaml\n---\nbody`. Throws a readable error when the frontmatter is missing or is not a YAML mapping. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) throw new Error('missing frontmatter: the file must start with a --- block');
  // A linear scan for the closing fence (a regex with a lazy group backtracks badly on long inputs).
  let close = -1;
  let from = 3; // the first "\n---" may be the one right after the opening fence line
  for (;;) {
    const at = src.indexOf('\n---', from);
    if (at < 0) break;
    let j = at + 4;
    while (src[j] === ' ' || src[j] === '\t') j++;
    if (j >= src.length || src[j] === '\n') {
      close = at;
      from = j < src.length ? j + 1 : j;
      break;
    }
    from = at + 1;
  }
  if (close < 0) throw new Error('missing frontmatter: the file must start with a --- block');
  const m = [src, src.slice(4, close), src.slice(from)];
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
  /** A plain key, or `<pack>:<key>` for a capability of an imported pack. */
  key: string;
  /** Set for a capability of an imported pack. */
  pack?: { name: string; sha?: string };
  /** The capability ships files that could run (`scripts/` or executable-looking files). */
  hasScripts?: boolean;
  /** Free labels the pickers read: `discovery`, `template:brief`, `template:prd`, `roster`, `delegate`. */
  tags?: string[];
  /** A persona's icon, for the pickers (the metadata does not carry the prompt). */
  icon?: string;
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
  // Length-prefixed, so no path or content can imitate a separator and collide with another file set.
  return sha256Hex(
    Object.keys(files)
      .sort()
      .map((p) => `${p.length}:${p}${(files[p] as string).length}:${files[p]}`)
      .join(''),
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
  if (utf8Bytes(text) > CAPABILITY_MAX_FILE_BYTES) throw new Error(`${key}.md is too large`);
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
export const CAPABILITY_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const utf8Encoder = new TextEncoder();
const utf8Bytes = (t: string): number => utf8Encoder.encode(t).length;

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
      let total = 0;
      for (const [p, t] of Object.entries(files)) {
        const n = utf8Bytes(t);
        if (n > CAPABILITY_MAX_FILE_BYTES) throw new Error(`${p} is too large`);
        total += n;
      }
      if (total > CAPABILITY_MAX_TOTAL_BYTES) throw new Error('the capability is too large');
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
    ...(e.pack ? { pack: e.pack.name } : {}),
    ...(e.hasScripts ? { hasScripts: true } : {}),
    ...(e.tags?.length ? { tags: e.tags } : {}),
    ...(e.icon ? { icon: e.icon } : {}),
    ...(e.pack && e.kind === 'persona' && e.meta.tools?.length ? { tools: e.meta.tools } : {}),
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
  for (const list of sources)
    for (const m of list) {
      const cur = byId.get(capabilityId(m));
      // The higher source wins whatever the order of the lists; equal rank: the later list.
      if (!cur || SOURCE_RANK[m.source] >= SOURCE_RANK[cur.source]) byId.set(capabilityId(m), m);
    }
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
    // `persona:bmad:analyst` is exact; `bmad:analyst` (a pack key) is not a kind prefix and resolves like a bare key.
    if ((CAPABILITY_KINDS as readonly string[]).includes(kind)) {
      const key = ref.slice(colon + 1);
      return all.find((c) => c.kind === kind && c.key === key);
    }
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

/** Digest of a reported index: an identical report (the same ids, hashes and issues) produces the same value. */
export function digestCapabilityIndex(
  items: ReadonlyArray<Pick<CapabilityMeta, 'kind' | 'key' | 'hash' | 'name' | 'description'>>,
  issues: ReadonlyArray<{ path: string; message: string }> = [],
): string {
  const lines = [
    ...items.map((i) => `${i.kind}:${i.key}\u0000${i.hash}\u0000${i.name}\u0000${i.description}`).sort(),
    ...issues.map((i) => `issue\u0000${i.path}\u0000${i.message}`).sort(),
  ];
  return sha256Hex(lines.join('\u0001'));
}

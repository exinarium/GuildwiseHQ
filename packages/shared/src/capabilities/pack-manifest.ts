import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { normalizeScopes } from '../governance/index.ts';
import { CapabilityKeySchema } from './parse.ts';

/**
 * The optional, neutral pack manifest: `pack.yaml`, `pack.yml` or `pack.json` at the root of a pack. Everything in it is a
 * pointer to files the pack already holds (the pack is still reviewed and pinned as a whole); nothing in it grants anything.
 *
 * ```yaml
 * scopes: [shell, web]           # what the pack needs (shown when it is granted); each entry below may add its own `scopes:`
 * agents:                         # personas: a file each (a persona .md, or a Claude Code subagent .md)
 *   - file: agents/analyst.md
 *     key: analyst                # optional, default: the file name
 *     name: Mary                  # optional overrides of the file's own frontmatter
 *     title: Business Analyst
 *     icon: "📊"
 * playbooks:                      # folders with a workflow.md (and steps/), anywhere in the pack
 *   - dir: flows/brainstorming
 *     tags: [discovery]           # labels the pickers read: discovery, template:brief, template:prd
 * skills:                         # folders with a SKILL.md that the generic pass would not find (it finds them anywhere already)
 *   - dir: extras/lint
 * ```
 *
 * Without a manifest a pack is read by convention: `SKILL.md` folders are skills, `personas/*.md` and `.claude/agents/*.md` are
 * personas, `playbooks/<key>/workflow.md` folders are playbooks, and a skill whose frontmatter says `metadata.kind: agent`
 * (or `type: agent`) is a persona.
 */
export const PACK_MANIFEST_FILES = ['pack.yaml', 'pack.yml', 'pack.json'] as const;

const MAX_ENTRIES = 100;
const MAX_MANIFEST_BYTES = 64 * 1024;

const Tag = z.string().min(1).max(40);
const ManifestPath = z.string().min(1).max(300);
/** `scopes: [shell, web]` or `scopes: "shell, web"`: what the pack (or one entry) needs; shown when it is granted to an agent. */
const Scopes = z.preprocess(
  (v) => (v === undefined ? undefined : normalizeScopes(v)),
  z.array(z.string()).max(20).optional(),
);

export const ManifestAgentSchema = z.object({
  file: ManifestPath,
  key: CapabilityKeySchema.optional(),
  name: z.string().min(1).max(100).optional(),
  title: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(1024).optional(),
  stance: z.string().min(1).max(500).optional(),
  voice: z.string().min(1).max(500).optional(),
  icon: z.string().min(1).max(60).optional(),
  tags: z.array(Tag).max(10).optional(),
  scopes: Scopes,
});
export type ManifestAgent = z.infer<typeof ManifestAgentSchema>;

export const ManifestDirSchema = z.object({
  dir: ManifestPath,
  key: CapabilityKeySchema.optional(),
  tags: z.array(Tag).max(10).optional(),
  scopes: Scopes,
});
export type ManifestDir = z.infer<typeof ManifestDirSchema>;

export const PackManifestSchema = z.object({
  /** Scopes every capability of the pack needs. */
  scopes: Scopes,
  agents: z.array(ManifestAgentSchema).max(MAX_ENTRIES).default([]),
  playbooks: z.array(ManifestDirSchema).max(MAX_ENTRIES).default([]),
  skills: z.array(ManifestDirSchema).max(MAX_ENTRIES).default([]),
});
export type PackManifest = z.infer<typeof PackManifestSchema>;

/** A path inside the pack: relative, no `..`, nothing under `.git` or `node_modules`. */
export function safePackPath(p: string): string | null {
  const n = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!n || n.startsWith('/') || /^[a-z]:/i.test(n)) return null;
  const parts = n.split('/');
  if (parts.some((s) => s === '..' || s === '.' || s === '' || s === '.git' || s === 'node_modules'))
    return null;
  return n;
}

/** The manifest of a pack tree, or why it could not be read. A pack without one gets `{ manifest: null }`. */
export function readPackManifest(tree: Record<string, string>): {
  manifest: PackManifest | null;
  file: string | null;
  error: string | null;
} {
  const file = PACK_MANIFEST_FILES.find((f) => tree[f] !== undefined) ?? null;
  if (!file) return { manifest: null, file: null, error: null };
  const text = tree[file] as string;
  if (text.length > MAX_MANIFEST_BYTES) return { manifest: null, file, error: `${file} is too large` };
  let raw: unknown;
  try {
    raw = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    return {
      manifest: null,
      file,
      error:
        `${file} is not valid ${file.endsWith('.json') ? 'JSON' : 'YAML'}: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          300,
        ),
    };
  }
  if (raw === null || raw === undefined) return { manifest: PackManifestSchema.parse({}), file, error: null };
  const r = PackManifestSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    return {
      manifest: null,
      file,
      error: `${file}: ${i?.path.join('.') || 'the file'}: ${i?.message ?? 'invalid'}`,
    };
  }
  return { manifest: r.data, file, error: null };
}

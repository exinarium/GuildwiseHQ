import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  builtinCapabilities,
  CAPABILITY_MAX_FILE_BYTES,
  CAPABILITY_MAX_FILES,
  type CapabilityIssue,
  type CapabilityMeta,
  type CapabilitySource,
  capabilityId,
  capabilityMeta,
  claudeAgentToPersonaText,
  digestCapabilityIndex,
  type IpcRpcResponse,
  indexCapabilityTree,
  materialisedSkillMarkdown,
  type ParsedCapability,
  packLabel,
  renderCapabilityIndex,
  renderPackText,
  resolveCapabilityRef,
} from '@aom/shared';
import { type Logger, nullLogger } from '../log.ts';
import type { GrantedSkill } from './materialize.ts';
import type { PackManager } from './packs.ts';

const ROOTS = ['skills', 'personas', 'playbooks'] as const;
/** Text files only: a capability is instructions and data, never a binary. */
const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|ya?ml|toml|sh|py|js|mjs|ts|html|xml)$/i;
const MAX_DEPTH = 6;

/**
 * Reads `org/skills`, `org/personas` and `org/playbooks` of an organization vault clone into a path -> text map. Symbolic
 * links are skipped (a vault is not trusted to stay inside itself), as are files that are not text or are too large.
 */
export function readCapabilityTree(orgDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of ROOTS) Object.assign(out, walkTextTree(join(orgDir, r), r));
  return out;
}

/** The text files below `root`, keyed `<prefix>/<relative path>`; same rules as `readCapabilityTree`. */
function walkTextTree(root: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  let files = 0;
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH || files > CAPABILITY_MAX_FILES * 20) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const abs = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs, `${rel}/${name}`, depth + 1);
      else if (
        st.isFile() &&
        st.size <= CAPABILITY_MAX_FILE_BYTES &&
        (TEXT_EXT.test(name) || name === 'SKILL.md')
      ) {
        try {
          out[`${rel}/${name}`] = readFileSync(abs, 'utf8');
          files++;
        } catch {
          // unreadable: skipped
        }
      }
    }
  };
  walk(root, prefix, 1);
  return out;
}

export interface IndexResult {
  items: Array<CapabilityMeta & { source: 'org-vault' }>;
  issues: CapabilityIssue[];
  /** The digest of the reported set differs from the previous index of this vault. */
  changed: boolean;
}

/**
 * The runner's capability registry: the built-ins that ship with the product plus what is in the organization vault
 * clone on this workstation (a vault capability replaces a built-in of the same kind and key). Agents load a capability
 * with `aom skill show`; the server only ever learns the metadata.
 */
export class CapabilityRegistry {
  private vault: ParsedCapability[] = [];
  private vaultId: string | undefined;
  private lastDigest = '';
  private lastReport: IndexResult | undefined;
  /** Capabilities of project checkouts (`.agents/skills`, `.claude/skills`, `.claude/agents`), by project id. */
  private projectRepo = new Map<string, ParsedCapability[]>();
  private projectDigest = new Map<string, string>();
  private readonly log: Logger;
  private packs: PackManager | undefined;

  constructor(opts: { log?: Logger; packs?: PackManager } = {}) {
    this.log = opts.log ?? nullLogger;
    this.packs = opts.packs;
  }

  setPacks(packs: PackManager): void {
    this.packs = packs;
  }

  /** Re-reads the organization vault folder (`<clone>/org`). */
  index(vaultId: string, cloneDir: string): IndexResult {
    const { entries, issues } = indexCapabilityTree(readCapabilityTree(join(cloneDir, 'org')));
    this.vault = entries;
    this.vaultId = vaultId;
    const items = entries.map((e) => ({ ...capabilityMeta(e, 'org-vault'), source: 'org-vault' as const }));
    const digest = digestCapabilityIndex(items, issues);
    const changed = digest !== this.lastDigest;
    this.lastDigest = digest;
    if (issues.length)
      this.log.warn(`organization vault capabilities with problems: ${issues.map((i) => i.path).join(', ')}`);
    this.lastReport = { items, issues, changed };
    return this.lastReport;
  }

  /**
   * Indexes the capabilities a project's checkout carries (`.agents/skills/*`, `.claude/skills/*`, `.claude/agents/*.md`, the
   * last mapped from Claude Code subagent frontmatter to personas). They override the built-ins and the vault for that project's
   * shifts only. Returns what to report to the server and whether it changed.
   */
  indexProject(projectId: string, repoDir: string): ProjectIndexResult {
    const tree: Record<string, string> = {};
    const issues: CapabilityIssue[] = [];
    const read = readCapabilityTreeAt(repoDir, ['.claude/skills', '.agents/skills', '.claude/agents']);
    for (const [path, text] of Object.entries(read)) {
      const m = /^\.(?:claude|agents)\/skills\/(.+)$/.exec(path);
      if (m) {
        // `.agents/skills` wins over `.claude/skills` for the same name (it is read last)
        tree[`skills/${m[1]}`] = text;
        continue;
      }
      const a = /^\.claude\/agents\/([^/]+)\.md$/.exec(path);
      if (a) {
        try {
          tree[`personas/${a[1]}.md`] = claudeAgentToPersonaText(a[1] as string, text);
        } catch (err) {
          issues.push({ path, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    const r = indexCapabilityTree(tree);
    issues.push(...r.issues);
    this.projectRepo.set(projectId, r.entries);
    const items = r.entries.map((e) => ({
      ...capabilityMeta(e, 'project-repo'),
      source: 'project-repo' as const,
    }));
    const digest = digestCapabilityIndex(items, issues);
    const changed = this.projectDigest.get(projectId) !== digest;
    this.projectDigest.set(projectId, digest);
    return { items, issues, changed };
  }

  get indexedVaultId(): string | undefined {
    return this.vaultId;
  }

  /** The last index result, for a repeat report after a reconnect. */
  last(): (IndexResult & { vaultId: string }) | undefined {
    return this.lastReport && this.vaultId ? { ...this.lastReport, vaultId: this.vaultId } : undefined;
  }

  /**
   * Effective entries with their source, lowest precedence first: built-ins, the organization vault, the project's own
   * repository, then imported packs (usable ones only: approved at this commit and unchanged on disk).
   */
  private all(projectId?: string): Array<{ e: ParsedCapability; source: CapabilitySource }> {
    const byId = new Map<string, { e: ParsedCapability; source: CapabilitySource }>();
    for (const e of builtinCapabilities()) byId.set(capabilityId(e), { e, source: 'builtin' });
    for (const e of this.vault) byId.set(capabilityId(e), { e, source: 'org-vault' });
    if (projectId)
      for (const e of this.projectRepo.get(projectId) ?? [])
        byId.set(capabilityId(e), { e, source: 'project-repo' });
    for (const e of this.packs?.entries(projectId) ?? []) byId.set(capabilityId(e), { e, source: 'pack' });
    return [...byId.values()].sort((a, b) =>
      a.e.kind === b.e.kind ? a.e.key.localeCompare(b.e.key) : a.e.kind.localeCompare(b.e.kind),
    );
  }

  /** Effective entries, sorted by kind and key. */
  entries(projectId?: string): ParsedCapability[] {
    return this.all(projectId).map((x) => x.e);
  }

  meta(projectId?: string): CapabilityMeta[] {
    return this.all(projectId).map((x) => capabilityMeta(x.e, x.source));
  }

  get(ref: string, projectId?: string): ParsedCapability | undefined {
    return resolveCapabilityRef(ref, this.entries(projectId));
  }

  private sourceOf(e: ParsedCapability, projectId?: string): CapabilitySource {
    return this.all(projectId).find((x) => x.e === e)?.source ?? 'builtin';
  }

  /** The text of a pack capability as a model sees it: labelled and fenced as outside content. */
  private served(e: ParsedCapability, text: string): string {
    if (!e.pack) return text;
    return renderPackText(packLabel(e.pack.name, e.pack.sha ?? 'unpinned', `${e.kind}:${e.key}`), text);
  }

  /** The persona text for a turn that did not carry it (a persona in the vault, a project repo or a pack). */
  persona(key: string, projectId?: string): Extract<ParsedCapability, { kind: 'persona' }> | undefined {
    const e = this.entries(projectId).find((x) => x.kind === 'persona' && x.key === key);
    if (e?.kind !== 'persona') return undefined;
    return e.pack ? { ...e, body: this.served(e, e.body) } : e;
  }

  /**
   * `aom skill show <ref> [--file <path>]`: the main file of a capability, or one of its files (a playbook step or
   * asset, a skill reference). Without `--file` a playbook also lists its steps and assets so the agent knows what to load.
   * Text of an imported pack is labelled as outside content.
   */
  show(
    ref: string,
    file?: string,
    projectId?: string,
  ): { ok: true; text: string } | { ok: false; error: string } {
    const e = this.get(ref, projectId);
    if (!e) {
      const near = this.entries(projectId)
        .filter((x) => x.key.includes(ref.replace(/^[a-z]+:/, '')))
        .slice(0, 5)
        .map((x) => `${x.kind}:${x.key}`);
      return {
        ok: false,
        error: `no capability "${ref}"${near.length ? `; did you mean ${near.join(', ')}?` : ''}. List them with \`aom skill list\`.`,
      };
    }
    if (file) {
      const clean = file.replace(/\\/g, '/').replace(/^\.\//, '');
      const text = e.files[clean];
      if (text === undefined || clean.split('/').includes('..'))
        return {
          ok: false,
          error: `${e.kind}:${e.key} has no file "${file}". Files: ${Object.keys(e.files).sort().join(', ')}${e.hasScripts && e.pack && !this.packs?.scriptsEnabled(e.pack.name) ? ' (script files are disabled for this pack)' : ''}`,
        };
      return { ok: true, text: this.served(e, text) };
    }
    const main = this.served(e, e.files[e.main] ?? '');
    const others = Object.keys(e.files)
      .filter((p) => p !== e.main)
      .sort();
    const tail = others.length
      ? `\n\n---\nMore files in ${e.kind}:${e.key} (read one with \`aom skill show ${e.kind}:${e.key} --file <path>\`):\n${others.map((p) => `- ${p}`).join('\n')}\n`
      : '';
    return { ok: true, text: main + tail };
  }

  /** `aom skill list`: kind, key and description of every effective capability. */
  list(kind?: string, projectId?: string): string {
    const rows = this.all(projectId).filter((x) => !kind || x.e.kind === kind);
    if (!rows.length) return 'No capabilities.';
    const label: Record<CapabilitySource, string> = {
      builtin: '',
      'org-vault': ' (organization vault)',
      'project-repo': ' (project repository)',
      pack: ' (imported pack)',
    };
    return rows.map((x) => `${x.e.kind}:${x.e.key}${label[x.source]}\t${x.e.description}`).join('\n');
  }

  /** The "Capabilities" section of an agent's instructions for the names its role lists (empty when it lists none). */
  instructionsIndex(names: readonly string[], projectId?: string): string {
    return renderCapabilityIndex(names, this.meta(projectId));
  }

  /**
   * The skills (not playbooks or personas) among the names a role lists, ready to be written into a runtime's own skills
   * folder: the descriptive frontmatter only (an `allowed-tools` line never reaches the runtime), pack text fenced as outside
   * content, script files only when the pack's owner enabled them. Folder names are unique and safe.
   */
  grantedSkills(names: readonly string[], projectId?: string): GrantedSkill[] {
    const out: GrantedSkill[] = [];
    const seen = new Set<string>();
    for (const n of names) {
      const e = this.get(n, projectId);
      if (e?.kind !== 'skill' || seen.has(capabilityId(e))) continue;
      seen.add(capabilityId(e));
      const name = e.pack ? `${e.pack.name}-${e.key.slice(e.pack.name.length + 1)}` : e.key;
      const files = { ...e.files };
      files['SKILL.md'] = materialisedSkillMarkdown(
        name,
        packLabel(e.pack?.name ?? '', e.pack?.sha ?? '', `skill:${e.key}`),
        e.files['SKILL.md'] ?? '',
        { wrap: !!e.pack },
      );
      out.push({ name, files });
    }
    return out;
  }
}

export interface ProjectIndexResult {
  items: Array<CapabilityMeta & { source: 'project-repo' }>;
  issues: CapabilityIssue[];
  changed: boolean;
}

/** Reads text files below the given folders of a checkout into a path -> text map (paths relative to `root`). */
export function readCapabilityTreeAt(root: string, folders: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of folders) Object.assign(out, walkTextTree(join(root, f), f));
  return out;
}

/** The `skill.show` and `skill.list` rpc methods, answered by the runner from its own registry (chats and shifts alike). */
export function skillRpc(
  registry: CapabilityRegistry | undefined,
  method: string,
  params: Record<string, unknown>,
  projectId?: string,
): IpcRpcResponse {
  if (!registry) return { ok: false, error: 'the capability registry is not available on this workstation' };
  if (method === 'skill.list')
    return {
      ok: true,
      result: { text: registry.list(typeof params.kind === 'string' ? params.kind : undefined, projectId) },
    };
  const ref = typeof params.ref === 'string' ? params.ref.trim() : '';
  if (!ref) return { ok: false, error: 'usage: aom skill show <key> [--file <path>]' };
  const r = registry.show(
    ref,
    typeof params.file === 'string' && params.file ? params.file : undefined,
    projectId,
  );
  return r.ok ? { ok: true, result: { text: r.text } } : { ok: false, error: r.error };
}

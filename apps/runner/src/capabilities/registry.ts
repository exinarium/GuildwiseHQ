import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  builtinCapabilities,
  CAPABILITY_MAX_FILE_BYTES,
  CAPABILITY_MAX_FILES,
  type CapabilityIssue,
  type CapabilityMeta,
  capabilityId,
  capabilityMeta,
  digestCapabilityIndex,
  type IpcRpcResponse,
  indexCapabilityTree,
  type ParsedCapability,
  renderCapabilityIndex,
  resolveCapabilityRef,
} from '@aom/shared';
import { type Logger, nullLogger } from '../log.ts';

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
  for (const r of ROOTS) walk(join(orgDir, r), r, 1);
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
  private readonly log: Logger;

  constructor(opts: { log?: Logger } = {}) {
    this.log = opts.log ?? nullLogger;
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

  get indexedVaultId(): string | undefined {
    return this.vaultId;
  }

  /** The last index result, for a repeat report after a reconnect. */
  last(): (IndexResult & { vaultId: string }) | undefined {
    return this.lastReport && this.vaultId ? { ...this.lastReport, vaultId: this.vaultId } : undefined;
  }

  /** Effective entries: built-ins overridden by the vault, sorted by kind and key. */
  entries(): ParsedCapability[] {
    const byId = new Map<string, ParsedCapability>();
    for (const e of builtinCapabilities()) byId.set(capabilityId(e), e);
    for (const e of this.vault) byId.set(capabilityId(e), e);
    return [...byId.values()].sort((a, b) =>
      a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind.localeCompare(b.kind),
    );
  }

  meta(): CapabilityMeta[] {
    return this.entries().map((e) => capabilityMeta(e, this.vault.includes(e) ? 'org-vault' : 'builtin'));
  }

  get(ref: string): ParsedCapability | undefined {
    return resolveCapabilityRef(ref, this.entries());
  }

  /** The persona text for a turn that did not carry it (a persona that lives in the organization vault). */
  persona(key: string): Extract<ParsedCapability, { kind: 'persona' }> | undefined {
    const e = this.entries().find((x) => x.kind === 'persona' && x.key === key);
    return e?.kind === 'persona' ? e : undefined;
  }

  /**
   * `aom skill show <ref> [--file <path>]`: the main file of a capability, or one of its files (a playbook step or
   * asset, a skill reference). Without `--file` a playbook also lists its steps and assets so the agent knows what to load.
   */
  show(ref: string, file?: string): { ok: true; text: string } | { ok: false; error: string } {
    const e = this.get(ref);
    if (!e) {
      const near = this.entries()
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
          error: `${e.kind}:${e.key} has no file "${file}". Files: ${Object.keys(e.files).sort().join(', ')}`,
        };
      return { ok: true, text };
    }
    const main = e.files[e.main] ?? '';
    const others = Object.keys(e.files)
      .filter((p) => p !== e.main)
      .sort();
    const tail = others.length
      ? `\n\n---\nMore files in ${e.kind}:${e.key} (read one with \`aom skill show ${e.kind}:${e.key} --file <path>\`):\n${others.map((p) => `- ${p}`).join('\n')}\n`
      : '';
    return { ok: true, text: main + tail };
  }

  /** `aom skill list`: kind, key and description of every effective capability. */
  list(kind?: string): string {
    const rows = this.entries().filter((e) => !kind || e.kind === kind);
    if (!rows.length) return 'No capabilities.';
    return rows
      .map(
        (e) => `${e.kind}:${e.key}${this.vault.includes(e) ? ' (organization vault)' : ''}\t${e.description}`,
      )
      .join('\n');
  }

  /** The "Capabilities" section of an agent's instructions for the names its role lists (empty when it lists none). */
  instructionsIndex(names: readonly string[]): string {
    return renderCapabilityIndex(names, this.meta());
  }
}

/** The `skill.show` and `skill.list` rpc methods, answered by the runner from its own registry (chats and shifts alike). */
export function skillRpc(
  registry: CapabilityRegistry | undefined,
  method: string,
  params: Record<string, unknown>,
): IpcRpcResponse {
  if (!registry) return { ok: false, error: 'the capability registry is not available on this workstation' };
  if (method === 'skill.list')
    return {
      ok: true,
      result: { text: registry.list(typeof params.kind === 'string' ? params.kind : undefined) },
    };
  const ref = typeof params.ref === 'string' ? params.ref.trim() : '';
  if (!ref) return { ok: false, error: 'usage: aom skill show <key> [--file <path>]' };
  const r = registry.show(ref, typeof params.file === 'string' && params.file ? params.file : undefined);
  return r.ok ? { ok: true, result: { text: r.text } } : { ok: false, error: r.error };
}

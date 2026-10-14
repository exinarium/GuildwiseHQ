import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig, type RunnerConfig, RunnerConfigSchema, saveConfig } from './config.ts';

/**
 * Pairings: one runner process on a machine can be paired with several workstations (one per account/organization,
 * on one server or several). `pairings.json` in the data directory lists them; every pairing keeps its own
 * `config.json` (server, token, settings, secrets), worktrees, agents, vault clones, outbox and logs in its own
 * directory, so organizations never share state. The first pairing lives in the data directory itself (`dir: "."`),
 * exactly where a single-pairing runner always kept it, so old data directories need no move: the index is created
 * around them on first use. Further pairings live in `pairings/<id>/`. docs/RUNNER.md "Several pairings".
 */

export const PAIRING_DIR_PATTERN = /^(\.|pairings\/[a-z0-9][a-z0-9-]{0,63})$/;

export const PairingEntrySchema = z.object({
  /** Stable short name used by `--pairing` and in logs: `<server host>-<last 8 characters of the workstation id>`. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  /** What the user called the workstation when pairing (`--name`); with the server it identifies the pairing. */
  label: z.string().min(1),
  /** Data directory of this pairing, relative to the runner data directory: "." or `pairings/<id>`. */
  dir: z.string().regex(PAIRING_DIR_PATTERN),
  serverUrl: z.string().min(1),
  workstationId: z.string().min(1),
  addedAt: z.string(),
  /** Set when the server reported the workstation unpaired: the runner stops trying until the user pairs again. */
  disabled: z.enum(['unpaired']).optional(),
});
export type PairingEntry = z.infer<typeof PairingEntrySchema>;

export const PairingIndexSchema = z.object({
  version: z.literal(1),
  /** Shifts the whole machine runs at once, across pairings (default: the largest `maxConcurrentShifts` of them). */
  maxConcurrentShifts: z.number().int().positive().optional(),
  /**
   * The pairing that may change machine-wide logins (`~/.claude`, `gh`, MCP sign-ins) from the web (docs/design/integrations-page.md
   * D8). Unset: the first pairing. Set with `aom-runner integrations machine-admin <pairing>`.
   */
  machineAdmin: z.string().optional(),
  pairings: z.array(PairingEntrySchema),
});
export type PairingIndex = z.infer<typeof PairingIndexSchema>;

export const pairingIndexPath = (root: string): string => join(root, 'pairings.json');
export const normalizeServerUrl = (url: string): string => url.trim().replace(/\/+$/, '');

export const entryDir = (root: string, e: PairingEntry): string =>
  e.dir === '.' ? root : resolve(root, e.dir);
export const entryConfigPath = (root: string, e: PairingEntry): string =>
  join(entryDir(root, e), 'config.json');

function hostSlug(serverUrl: string): string {
  let host = serverUrl;
  try {
    host = new URL(serverUrl).host;
  } catch {
    // not a URL: use the text
  }
  return (
    host
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'server'
  );
}

export function pairingId(serverUrl: string, workstationId: string): string {
  return `${hostSlug(serverUrl)}-${
    workstationId
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
      .slice(-8) || 'ws'
  }`;
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // not supported on every platform
  }
  renameSync(tmp, path);
}

export function saveIndex(root: string, index: PairingIndex): void {
  writeAtomic(pairingIndexPath(root), `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * Reads the pairing index. A data directory from before pairings (a `config.json` and no index) is migrated in
 * place: the index gains one entry for the existing config, which stays where it is. No data is moved or rewritten.
 * Returns an empty index when nothing is paired.
 */
/** Is this pairing the machine's primary one (the `machineAdmin` pairing, else the first enabled one)? */
export function isMachinePrimary(index: PairingIndex, entry: PairingEntry): boolean {
  if (index.machineAdmin && index.pairings.some((p) => p.id === index.machineAdmin))
    return index.machineAdmin === entry.id;
  return (index.pairings.find((p) => !p.disabled) ?? index.pairings[0])?.id === entry.id;
}

export function loadIndex(root: string): PairingIndex {
  const file = pairingIndexPath(root);
  if (existsSync(file)) return PairingIndexSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const legacy = join(root, 'config.json');
  if (!existsSync(legacy)) return { version: 1, pairings: [] };
  const c = loadConfig(legacy);
  const index: PairingIndex = {
    version: 1,
    pairings: [
      {
        id: pairingId(c.serverUrl, c.workstationId),
        label: 'primary',
        dir: '.',
        serverUrl: normalizeServerUrl(c.serverUrl),
        workstationId: c.workstationId,
        addedAt: new Date().toISOString(),
      },
    ],
  };
  saveIndex(root, index);
  return index;
}

/** Settings a new pairing inherits from the first one: machine-level, never a credential. */
function inheritedSettings(root: string, index: PairingIndex): Partial<RunnerConfig> {
  const first = index.pairings.find((p) => !p.disabled) ?? index.pairings[0];
  if (!first || !existsSync(entryConfigPath(root, first))) return {};
  try {
    const c = loadConfig(entryConfigPath(root, first));
    const cc = c.runtimes['claude-code'];
    const { oauthToken: _o, apiKey: _k, ...claude } = cc;
    return {
      repoRoots: c.repoRoots,
      maxConcurrentShifts: c.maxConcurrentShifts,
      vaultSyncIntervalSec: c.vaultSyncIntervalSec,
      runtimes: {
        // A credential belongs to the pairing it was entered for: the new one signs in on its own (or uses the
        // machine's `claude` login, authMode "default").
        'claude-code': {
          ...claude,
          authMode: cc.authMode === 'api_key' || cc.authMode === 'oauth' ? 'default' : cc.authMode,
        },
        ...(c.runtimes.mock ? { mock: c.runtimes.mock } : {}),
      },
    };
  } catch {
    return {};
  }
}

export interface AddPairingInput {
  serverUrl: string;
  /** The workstation name the user chose; with the server URL it identifies a pairing. */
  label: string;
  workstationId: string;
  runnerToken: string;
  mock?: boolean;
}

export interface AddPairingResult {
  entry: PairingEntry;
  /** The pairing replaced an earlier one for the same server and name (a re-pair); otherwise it was added. */
  replaced: boolean;
  /** Pairings on this machine after the change. */
  count: number;
  dir: string;
  configPath: string;
}

/**
 * Adds a pairing without touching the others. The same server and workstation name again replaces that pairing's
 * credentials (a re-pair after unlinking), keeping its settings and data.
 */
export function addPairing(root: string, input: AddPairingInput): AddPairingResult {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const index = loadIndex(root);
  const existing = index.pairings.find((p) => p.serverUrl === serverUrl && p.label === input.label);
  let entry: PairingEntry;
  let previous: Partial<RunnerConfig>;
  if (existing) {
    entry = { ...existing, workstationId: input.workstationId, disabled: undefined };
    if (!entry.disabled) delete entry.disabled;
    index.pairings = index.pairings.map((p) => (p === existing ? entry : p));
    try {
      previous = loadConfig(entryConfigPath(root, existing));
    } catch {
      previous = {};
    }
  } else {
    let id = pairingId(serverUrl, input.workstationId);
    for (let n = 2; index.pairings.some((p) => p.id === id); n++)
      id = `${pairingId(serverUrl, input.workstationId)}-${n}`;
    const first = index.pairings.length === 0;
    entry = {
      id,
      label: input.label,
      dir: first ? '.' : `pairings/${id}`,
      serverUrl,
      workstationId: input.workstationId,
      addedAt: new Date().toISOString(),
    };
    previous = first ? readLegacyConfig(root) : inheritedSettings(root, index);
    index.pairings.push(entry);
  }
  const config = RunnerConfigSchema.parse({
    ...previous,
    serverUrl,
    workstationId: input.workstationId,
    runnerToken: input.runnerToken,
    runtimes: {
      ...(previous.runtimes ?? {}),
      ...(input.mock ? { mock: { ...(previous.runtimes?.mock ?? {}), enabled: true } } : {}),
    },
  });
  const dir = entryDir(root, entry);
  const configPath = join(dir, 'config.json');
  // Config first, index second: a reader that sees the entry always finds its config.
  saveConfig(configPath, config);
  saveIndex(root, index);
  return { entry, replaced: !!existing, count: index.pairings.length, dir, configPath };
}

function readLegacyConfig(root: string): Partial<RunnerConfig> {
  try {
    return existsSync(join(root, 'config.json')) ? loadConfig(join(root, 'config.json')) : {};
  } catch {
    return {};
  }
}

/** Finds a pairing by id, label, workstation id or a unique prefix of the id. */
export function findPairing(index: PairingIndex, selector: string): PairingEntry {
  const s = selector.trim().toLowerCase();
  const exact = index.pairings.filter(
    (p) => p.id === s || p.label.toLowerCase() === s || p.workstationId.toLowerCase() === s,
  );
  const hits = exact.length ? exact : index.pairings.filter((p) => p.id.startsWith(s));
  if (hits.length === 1 && hits[0]) return hits[0];
  const known = index.pairings.map((p) => `${p.id} (${p.label})`).join(', ') || 'none';
  throw new Error(
    hits.length > 1
      ? `"${selector}" matches ${hits.length} pairings (${hits.map((p) => p.id).join(', ')}); use the id`
      : `no pairing "${selector}" (pairings: ${known})`,
  );
}

/**
 * Forgets a pairing on this machine. The server is not told (the workstation stays listed until it is unlinked in the
 * web app) and the pairing's data stays on disk unless `purge` is set (the credentials are dropped either way).
 */
export function removePairing(root: string, selector: string, purge = false): PairingEntry {
  const index = loadIndex(root);
  const entry = findPairing(index, selector);
  index.pairings = index.pairings.filter((p) => p !== entry);
  saveIndex(root, index);
  const dir = entryDir(root, entry);
  if (purge) {
    if (entry.dir === '.') rmSync(join(root, 'config.json'), { force: true });
    else rmSync(dir, { recursive: true, force: true });
  } else {
    // Keep the data, drop the credentials: nothing can reconnect with this directory by accident.
    try {
      const c = loadConfig(join(dir, 'config.json'));
      saveConfig(join(dir, 'config.json'), { ...c, runnerToken: 'aomr_removed' });
    } catch {
      // nothing to drop
    }
  }
  return entry;
}

/** Marks a pairing as unpaired by the server (or clears the mark), so the runner stops retrying it. */
export function setDisabled(root: string, id: string, disabled: 'unpaired' | undefined): void {
  const index = loadIndex(root);
  const e = index.pairings.find((p) => p.id === id);
  if (!e) return;
  if (disabled) e.disabled = disabled;
  else delete e.disabled;
  saveIndex(root, index);
}

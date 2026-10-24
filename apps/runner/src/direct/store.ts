import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BACKEND_IDS,
  type BackendId,
  backendDef,
  backendDetail,
  DIRECT_PROVIDER_IDS,
  type DirectProviderId,
  directProvider,
  type KeySource,
  type ProviderKeyClearPayload,
  type ProviderKeyId,
  type ProviderKeyResealResult,
  type ProviderKeyResult,
  type ProviderKeySetPayload,
  type ReportedBackend,
  type ReportedKey,
  type ReportedProvider,
  sealLarge,
  validateBackendFields,
} from '@aom/shared';
import type { RunnerKeys } from '../secrets/keys.ts';
import { registerSecret, unregisterSecret } from '../secrets/redact.ts';

/** One provider as stored: the key as the ciphertext the browser sealed (the plain key exists in memory only). */
interface StoredProvider {
  ciphertext?: string;
  baseUrl?: string;
  /** Extra model ids the owner added (besides the built-in list). */
  models: string[];
  setAt: string;
}

type SlotFileContent = Partial<Record<ProviderKeyId, StoredProvider>>;

/** What the adapter needs to call a provider. The key is plain text: never log it, never put it in an event. */
export interface ProviderConfig {
  id: DirectProviderId;
  apiKey?: string;
  baseUrl?: string;
  models: string[];
  /** Whose key this is: the workstation's own, else the organization's (absent: the workstation's). */
  source?: KeySource;
}

/** A Claude Code backend credential, opened: the flat field map of `backends.ts`. The secrets are in memory only. */
export interface BackendConfig {
  id: BackendId;
  fields: Record<string, string>;
  models: string[];
  source: KeySource;
}

/** Refuses an endpoint that carries credentials, a query or a non-http scheme (it is shown in the UI and logged). */
export function validateBaseUrl(
  raw: string,
): { ok: true; url: string; warning?: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: 'the endpoint is not a valid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    return { ok: false, error: 'the endpoint must start with http:// or https://' };
  if (u.username || u.password) return { ok: false, error: 'put the key in the key field, not in the URL' };
  if (u.search || u.hash) return { ok: false, error: 'the endpoint must not have a query or a fragment' };
  const loopback =
    /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i.test(u.hostname) || u.hostname.endsWith('.localhost');
  return {
    ok: true,
    url: u.toString().replace(/\/+$/, ''),
    ...(u.protocol === 'http:' && !loopback
      ? {
          warning:
            'This endpoint uses plain http:// away from this machine: the key and every prompt travel unencrypted. Use https:// unless the network is trusted.',
        }
      : {}),
  };
}

/**
 * Provider credentials of this workstation (docs/ARCHITECTURE.md sections 38.3 and 38.5), the way the sudo password and the test
 * accounts are kept. There are two slots per provider: `<data dir>/secrets/providers.json` holds the owner's own keys (the
 * workstation's), `providers-org.json` the organization's key that an Owner or Admin sealed to this runner (mode 0600 both). The
 * browser sealed the key with this runner's public key; the server relayed the ciphertext and never saw the key. A workstation key
 * overrides the organization's. The key is decrypted in memory when a turn needs it and registered with the redaction registry, so
 * logs, tool summaries and error messages never show it. Only names, models and whose key is in effect leave this machine.
 */
export class ProviderStore {
  private changed: Array<() => void> = [];
  private readonly orgFile: string;

  constructor(
    private readonly deps: {
      file: string;
      /** The organization slot's file (default: `providers-org.json` next to `file`). */
      orgFile?: string;
      keys: Pick<RunnerKeys, 'decrypt'> & {
        decryptAny?: (value: string) => string;
        publicKey: { keyId: string };
      };
    },
  ) {
    this.orgFile = deps.orgFile ?? join(dirname(deps.file), 'providers-org.json');
    // After a restart, redaction must know the keys before the first log line.
    for (const source of ['workstation', 'org'] as const)
      for (const p of Object.values(this.all(source))) if (p.ciphertext) this.register(p.ciphertext);
  }

  onChange(fn: () => void): void {
    this.changed.push(fn);
  }

  private open(ciphertext: string): string {
    const k = this.deps.keys;
    return k.decryptAny ? k.decryptAny(ciphertext) : k.decrypt(ciphertext);
  }

  private fileOf(source: KeySource): string {
    return source === 'org' ? this.orgFile : this.deps.file;
  }

  private all(source: KeySource): SlotFileContent {
    const file = this.fileOf(source);
    if (!existsSync(file)) return {};
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return j && typeof j === 'object' ? (j as SlotFileContent) : {};
    } catch {
      return {};
    }
  }

  private save(source: KeySource, all: SlotFileContent): void {
    const file = this.fileOf(source);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows
    }
  }

  /** Registers every secret in a sealed value: a plain key, or each secret field of a backend credential. */
  private secretsOf(ciphertext: string): string[] {
    let plain: string;
    try {
      plain = this.open(ciphertext);
    } catch {
      return []; // sealed for another key: unreadable anyway
    }
    const out = [plain];
    try {
      const j = JSON.parse(plain) as unknown;
      if (j && typeof j === 'object')
        for (const v of Object.values(j as Record<string, unknown>))
          if (typeof v === 'string' && v.length >= 3) out.push(v.trim());
    } catch {
      // a plain key
    }
    return out;
  }

  private register(ciphertext: string): void {
    for (const x of this.secretsOf(ciphertext)) registerSecret(x);
  }

  private unregister(ciphertext: string | undefined): void {
    if (!ciphertext) return;
    for (const x of this.secretsOf(ciphertext)) unregisterSecret(x);
  }

  /** `provider.key.set`. Never returns or logs the key. */
  set(p: ProviderKeySetPayload): ProviderKeyResult {
    const source: KeySource = p.source ?? 'workstation';
    if (p.keyId !== this.deps.keys.publicKey.keyId)
      return {
        stored: false,
        error: 'the key was encrypted for another runner key (the runner key changed): enter it again',
      };
    if ((BACKEND_IDS as readonly string[]).includes(p.provider))
      return this.setBackend(p, source, p.provider as BackendId);
    const def = directProvider(p.provider);
    if (!def) return { stored: false, error: 'unknown provider' };
    let plain: string | undefined;
    if (p.ciphertext) {
      try {
        plain = this.open(p.ciphertext);
      } catch {
        return { stored: false, error: 'the key could not be decrypted: enter it again' };
      }
      plain = plain.trim();
      if (!plain) return { stored: false, error: 'empty key' };
    } else if (!def.keyOptional) {
      return { stored: false, error: `${def.label} needs an API key` };
    }
    let baseUrl: string | undefined;
    let warning: string | undefined;
    if (def.needsBaseUrl) {
      if (!p.baseUrl?.trim()) return { stored: false, error: 'enter the endpoint (base URL)' };
      const v = validateBaseUrl(p.baseUrl);
      if (!v.ok) return { stored: false, error: v.error };
      baseUrl = v.url;
      warning = v.warning;
    }
    const all = this.all(source);
    this.unregister(all[p.provider]?.ciphertext);
    all[p.provider] = {
      ...(p.ciphertext ? { ciphertext: p.ciphertext } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      models: [...new Set(p.models.map((m) => m.trim()).filter(Boolean))],
      setAt: new Date().toISOString(),
    };
    this.save(source, all);
    if (plain) registerSecret(plain);
    for (const f of this.changed) f();
    return { stored: true, ...(warning ? { warning } : {}) };
  }

  private setBackend(p: ProviderKeySetPayload, source: KeySource, id: BackendId): ProviderKeyResult {
    if (!p.ciphertext)
      return { stored: false, error: `${backendDef(id)?.label ?? id} needs its credentials` };
    let fields: Record<string, string>;
    try {
      const parsed = JSON.parse(this.open(p.ciphertext)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      fields = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '').trim()]),
      );
    } catch {
      return { stored: false, error: 'the credentials could not be decrypted: enter them again' };
    }
    const bad = validateBackendFields(id, fields);
    if (bad) return { stored: false, error: bad };
    const all = this.all(source);
    this.unregister(all[id]?.ciphertext);
    all[id] = {
      ciphertext: p.ciphertext,
      models: [...new Set(p.models.map((m) => m.trim()).filter(Boolean))],
      setAt: new Date().toISOString(),
    };
    this.save(source, all);
    this.register(p.ciphertext);
    for (const f of this.changed) f();
    const warning =
      fields.baseUrl?.startsWith('http://') && !/^http:\/\/(localhost|127\.|\[::1\])/.test(fields.baseUrl)
        ? 'This endpoint uses plain http:// away from this machine: the credentials and every prompt travel unencrypted. Use https:// unless the network is trusted.'
        : undefined;
    return { stored: true, ...(warning ? { warning } : {}) };
  }

  /** `provider.key.clear`: forget the key and the endpoint of one slot (default: the workstation's own). */
  clear(provider: ProviderKeyId, source: KeySource = 'workstation'): void {
    const all = this.all(source);
    if (!all[provider]) return;
    this.unregister(all[provider]?.ciphertext);
    delete all[provider];
    this.save(source, all);
    for (const f of this.changed) f();
  }

  clearPayload(p: ProviderKeyClearPayload): void {
    this.clear(p.provider, p.source ?? 'workstation');
  }

  /** The slot in effect for a provider: the workstation's own key, else the organization's. */
  private slotOf(
    provider: string,
  ): { source: KeySource; stored: StoredProvider; orgAlso: boolean } | undefined {
    const own = this.all('workstation')[provider as ProviderKeyId];
    const org = this.all('org')[provider as ProviderKeyId];
    if (own) return { source: 'workstation', stored: own, orgAlso: !!org };
    if (org) return { source: 'org', stored: org, orgAlso: true };
    return undefined;
  }

  /** The configuration of one provider with its key decrypted, or undefined when it is not set (or its key is unreadable). */
  get(provider: string): ProviderConfig | undefined {
    if (!(DIRECT_PROVIDER_IDS as readonly string[]).includes(provider)) return undefined;
    const slot = this.slotOf(provider);
    if (!slot) return undefined;
    const s = slot.stored;
    let apiKey: string | undefined;
    if (s.ciphertext) {
      try {
        apiKey = this.open(s.ciphertext);
      } catch {
        return undefined;
      }
    }
    return {
      id: provider as DirectProviderId,
      ...(apiKey ? { apiKey } : {}),
      ...(s.baseUrl ? { baseUrl: s.baseUrl } : {}),
      models: s.models ?? [],
      source: slot.source,
    };
  }

  /** The providers that are set, with their keys readable. */
  configured(): ProviderConfig[] {
    return DIRECT_PROVIDER_IDS.map((id) => this.get(id)).filter((c): c is ProviderConfig => !!c);
  }

  /** A backend's credential opened, or undefined when it is not set or unreadable. */
  getBackend(id: BackendId): BackendConfig | undefined {
    const slot = this.slotOf(id);
    if (!slot?.stored.ciphertext) return undefined;
    try {
      const j = JSON.parse(this.open(slot.stored.ciphertext)) as Record<string, unknown>;
      return {
        id,
        fields: Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? '')])),
        models: slot.stored.models ?? [],
        source: slot.source,
      };
    } catch {
      return undefined;
    }
  }

  configuredBackends(): BackendConfig[] {
    return BACKEND_IDS.map((id) => this.getBackend(id)).filter((c): c is BackendConfig => !!c);
  }

  /** Whose key is in effect for a provider, or null. */
  sourceOf(provider: string): KeySource | null {
    return this.slotOf(provider)?.source ?? null;
  }

  /** Claude Code backends with a credential here: names, models and whose credential it is. */
  reportBackends(): ReportedBackend[] {
    return this.configuredBackends().map((c) => {
      const def = backendDef(c.id);
      const ids = new Map<string, { id: string; label: string; tier?: 'small' | 'medium' | 'large' }>();
      for (const m of def?.models ?? []) ids.set(m.id, { id: m.id, label: m.label, tier: m.tier });
      for (const id of c.models) if (!ids.has(id)) ids.set(id, { id, label: id });
      const detail = backendDetail(c.id, c.fields);
      return {
        id: c.id,
        label: def?.label ?? c.id,
        models: [...ids.values()].map(({ tier, ...m }) => ({ ...m, ...(tier ? { tier } : {}) })),
        ...(detail ? { detail } : {}),
        keySource: c.source,
        ...(this.slotOf(c.id)?.orgAlso ? { orgKey: true } : {}),
      };
    });
  }

  /** Every stored key and whose it is, for the server's resolution and caps. */
  reportKeys(): ReportedKey[] {
    const out: ReportedKey[] = [];
    for (const id of [...DIRECT_PROVIDER_IDS, ...BACKEND_IDS] as ProviderKeyId[]) {
      const slot = this.slotOf(id);
      if (!slot) continue;
      out.push({
        provider: id,
        source: slot.source,
        ...(slot.orgAlso ? { orgKey: true } : {}),
      });
    }
    return out;
  }

  /** Is the organization's key stored here (it may be overridden by the workstation's own)? */
  hasOrgKey(provider: ProviderKeyId): boolean {
    return !!this.all('org')[provider];
  }

  /**
   * `provider.key.reseal`: opens the organization's key and seals it to another runner's public key, for an Owner or Admin who
   * approved sharing it. The plain key exists in this function only; the answer is the ciphertext for the target.
   */
  async reseal(
    provider: ProviderKeyId,
    target: { keyId: string; publicKey: string },
  ): Promise<ProviderKeyResealResult> {
    const stored = this.all('org')[provider];
    if (!stored) return { ok: false, error: 'this workstation does not hold the organization key' };
    // keyless endpoints have nothing to seal: the server shares the settings itself
    if (!stored.ciphertext) return { ok: false, error: 'this key has no secret to share' };
    let plain: string;
    try {
      plain = this.open(stored.ciphertext);
    } catch {
      return { ok: false, error: 'the stored key could not be opened' };
    }
    return { ok: true, ciphertext: await sealLarge(target.publicKey, plain) };
  }

  /**
   * What the server may know: provider ids, labels, models, the endpoint's host, whose key it is and a problem text. `listed` holds
   * model ids fetched from an OpenAI-compatible endpoint (`models.ts`), `problems` the last failed check per provider.
   */
  report(
    listed: Partial<Record<string, string[]>> = {},
    problems: Partial<Record<string, string>> = {},
  ): ReportedProvider[] {
    return this.configured().map((c) => {
      const def = directProvider(c.id);
      const ids = new Map<string, { id: string; label: string; tier?: 'small' | 'medium' | 'large' }>();
      for (const m of def?.models ?? []) ids.set(m.id, { id: m.id, label: m.label, tier: m.tier });
      for (const id of [...c.models, ...(listed[c.id] ?? [])])
        if (!ids.has(id)) ids.set(id, { id, label: id });
      let endpointHost: string | undefined;
      if (c.baseUrl) {
        try {
          endpointHost = new URL(c.baseUrl).host;
        } catch {
          // validated on set
        }
      }
      return {
        id: c.id,
        label: def?.label ?? c.id,
        models: [...ids.values()].map(({ tier, ...m }) => ({ ...m, ...(tier ? { tier } : {}) })),
        ...(endpointHost ? { endpointHost } : {}),
        ...(problems[c.id] ? { problem: problems[c.id] as string } : {}),
        keySource: c.source,
        ...(this.slotOf(c.id)?.orgAlso ? { orgKey: true } : {}),
      };
    });
  }
}

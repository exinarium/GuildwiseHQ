import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BACKEND_IDS,
  type BackendId,
  backendDef,
  backendDetail,
  baseUrlEndpointProblem,
  DIRECT_PROVIDER_IDS,
  type DirectProviderId,
  directProvider,
  type KeySource,
  keyIdOfSpki,
  normalizeEndpoint,
  normalizePrivateEndpoints,
  orgCredentialEndpointProblem,
  type ProviderKeyBinding,
  type ProviderKeyClearPayload,
  type ProviderKeyId,
  type ProviderKeyResealResult,
  type ProviderKeyResult,
  type ProviderKeySetPayload,
  providerKeyAad,
  RESEAL_APPROVAL_MAX_MS,
  type ReportedBackend,
  type ReportedKey,
  type ReportedProvider,
  ResealApprovalSchema,
  resealApprovalAad,
  sealProviderKey,
  spkiSha256,
  validateBackendFields,
} from '@aom/shared';
import { ReplayCache } from '../integrations/seen.ts';
import type { RunnerKeys } from '../secrets/keys.ts';
import { registerSecret, unregisterSecret } from '../secrets/redact.ts';

/** One provider as stored: the key as the ciphertext the browser sealed (the plain key exists in memory only). */
interface StoredProvider {
  ciphertext?: string;
  baseUrl?: string;
  /** Extra model ids the owner added (besides the built-in list). */
  models: string[];
  setAt: string;
  /**
   * The credential is sealed `h2` and bound to this slot (provider, organization, `endpoint`, `generation`, this runner's key):
   * it is opened only with the associated data rebuilt from these fields. Absent on a credential stored before runner 0.1.56.
   */
  bound?: true;
  /** The endpoint the sealed credential is bound to (normalised; empty when it has none). */
  endpoint?: string;
  /** An organization key's generation (`org_providers.key_generation`). */
  generation?: number;
}

type SlotFileContent = Partial<Record<ProviderKeyId, StoredProvider>>;
/** The organizations' slots: `{ [orgId]: { [provider]: StoredProvider } }`. */
type OrgFileContent = Record<string, SlotFileContent>;

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
  private readonly endpointsFile: string;
  /** The highest generation of each organization key that was revoked or replaced here: never accepted again. */
  private readonly floorFile: string;
  private readonly approvals: ReplayCache;

  constructor(
    private readonly deps: {
      file: string;
      /** The organization slot's file (default: `providers-org.json` next to `file`). */
      orgFile?: string;
      keys: Pick<RunnerKeys, 'decrypt'> & {
        decryptAny?: (value: string, aad?: string, opts?: { requireBound?: boolean }) => string;
        publicKey: { keyId: string };
      };
      /** Clock for the approval's expiry (tests). */
      now?: () => number;
    },
  ) {
    this.orgFile = deps.orgFile ?? join(dirname(deps.file), 'providers-org.json');
    this.endpointsFile = join(dirname(deps.file), 'private-endpoints.json');
    this.floorFile = join(dirname(deps.file), 'providers-org-floor.json');
    this.approvals = new ReplayCache(join(dirname(deps.file), 'reseal-approvals.json'), deps.now ?? Date.now);
    // After a restart, redaction must know the keys before the first log line.
    for (const [id, p] of Object.entries(this.own()))
      if (p.ciphertext) this.register(p.ciphertext, this.aadOf('workstation', undefined, id, p));
    for (const [orgId, slot] of Object.entries(this.orgs()))
      for (const [id, p] of Object.entries(slot))
        if (p.ciphertext && p.bound) this.register(p.ciphertext, this.aadOf('org', orgId, id, p));
  }

  /** The private-endpoint allow-list (exact `host:port`, set by the workstation's owner; empty by default). */
  endpoints(): string[] {
    const j = this.readJson(this.endpointsFile);
    const list = (j as { endpoints?: unknown } | null)?.endpoints;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  }

  /** Replaces the allow-list. Every entry is checked again here: the server's answer is not trusted. */
  setEndpoints(list: readonly string[]): { stored: boolean; error?: string } {
    const n = normalizePrivateEndpoints(list);
    if (!n.ok) return { stored: false, error: n.error };
    this.write(this.endpointsFile, { endpoints: n.entries });
    for (const f of this.changed) f();
    return { stored: true };
  }

  onChange(fn: () => void): void {
    this.changed.push(fn);
  }

  /** Opens a sealed value. A bound (`h2`) one needs the associated data; `requireBound` refuses the older forms. */
  private open(ciphertext: string, aad?: string, requireBound = false): string {
    const k = this.deps.keys;
    return k.decryptAny ? k.decryptAny(ciphertext, aad, { requireBound }) : k.decrypt(ciphertext);
  }

  /** What a stored credential is bound to, rebuilt from its slot (undefined for a credential stored before binding existed). */
  private aadOf(
    source: KeySource,
    orgId: string | undefined,
    provider: string,
    s: Pick<StoredProvider, 'bound' | 'endpoint' | 'generation' | 'baseUrl'>,
  ): string | undefined {
    if (!s.bound) return undefined;
    const b: ProviderKeyBinding = {
      scope: source,
      orgId,
      provider,
      endpoint: s.endpoint ?? s.baseUrl ?? '',
      generation: s.generation ?? 0,
      keyId: this.deps.keys.publicKey.keyId,
    };
    return providerKeyAad(b);
  }

  private floorOf(orgId: string, provider: string): number {
    const j = this.readJson(this.floorFile) as Record<string, Record<string, unknown>> | null;
    const n = j?.[orgId]?.[provider];
    return typeof n === 'number' ? n : 0;
  }

  private raiseFloor(orgId: string, provider: string, generation: number): void {
    const j = (this.readJson(this.floorFile) as Record<string, Record<string, number>> | null) ?? {};
    const slot = j[orgId] ?? {};
    slot[provider] = Math.max(slot[provider] ?? 0, generation);
    j[orgId] = slot;
    this.write(this.floorFile, j);
  }

  private readJson(file: string): unknown {
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch {
      return {};
    }
  }

  /** The workstation's own keys. */
  private own(): SlotFileContent {
    const j = this.readJson(this.deps.file);
    return j && typeof j === 'object' ? (j as SlotFileContent) : {};
  }

  /** The organizations' keys, by organization. */
  private orgs(): OrgFileContent {
    const j = this.readJson(this.orgFile);
    return j && typeof j === 'object' ? (j as OrgFileContent) : {};
  }

  private write(file: string, data: object): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows
    }
  }

  /** The slot a key is written to or read from: the workstation's, or one organization's. */
  private slotFor(source: KeySource, orgId: string | undefined): SlotFileContent {
    if (source === 'workstation') return this.own();
    return (orgId ? this.orgs()[orgId] : undefined) ?? {};
  }

  private saveSlot(source: KeySource, orgId: string | undefined, slot: SlotFileContent): void {
    if (source === 'workstation') {
      this.write(this.deps.file, slot);
      return;
    }
    if (!orgId) throw new Error('an organization key needs its organization');
    const all = this.orgs();
    if (Object.keys(slot).length === 0) delete all[orgId];
    else all[orgId] = slot;
    this.write(this.orgFile, all);
  }

  /** Registers every secret in a sealed value: a plain key, or each secret field of a backend credential. */
  private secretsOf(ciphertext: string, aad?: string): string[] {
    let plain: string;
    try {
      plain = this.open(ciphertext, aad);
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

  private register(ciphertext: string, aad?: string): void {
    for (const x of this.secretsOf(ciphertext, aad)) registerSecret(x);
  }

  private unregister(ciphertext: string | undefined, aad?: string): void {
    if (!ciphertext) return;
    for (const x of this.secretsOf(ciphertext, aad)) unregisterSecret(x);
  }

  /**
   * How a sealed blob of a `provider.key.set` is opened. Bound (`h2`) blobs are opened with the associated data rebuilt from the
   * command; an organization's key must be bound (the older forms are refused: ask the admin to enter the key again), a
   * workstation's own may still be an older form (with a warning), unless the slot already holds a bound one (no downgrade).
   */
  private openSet(
    p: ProviderKeySetPayload,
    source: KeySource,
    endpoint: string,
  ): { plain: string; bound: boolean; warning?: string } | { error: string } {
    const ct = p.ciphertext as string;
    if (ct.startsWith('h2.')) {
      const aad = providerKeyAad({
        scope: source,
        orgId: p.orgId,
        provider: p.provider,
        endpoint,
        generation: source === 'org' ? (p.generation ?? 0) : 0,
        keyId: p.keyId,
      });
      try {
        return { plain: this.open(ct, aad, true), bound: true };
      } catch {
        return {
          error:
            'the key could not be opened: it was sealed for another provider, organization, endpoint or key version. Enter it again.',
        };
      }
    }
    if (source === 'org')
      return {
        error:
          'this organization key was sealed in the older form that is not tied to its purpose. Ask the Owner or an Admin to enter the key again (Settings, Model providers).',
      };
    const held = this.own()[p.provider as ProviderKeyId];
    if (held?.bound)
      return { error: 'this key was sealed in the older form; reload the web app and enter it again' };
    try {
      return {
        plain: this.open(ct),
        bound: false,
        warning:
          'This key was sealed in the older form that is not tied to its purpose. Update the web app and enter it again to bind it to this provider and endpoint.',
      };
    } catch {
      return { error: 'the key could not be decrypted: enter it again' };
    }
  }

  /** `provider.key.set`. Never returns or logs the key. */
  set(p: ProviderKeySetPayload): ProviderKeyResult {
    const source: KeySource = p.source ?? 'workstation';
    if (source === 'org' && !p.orgId)
      return { stored: false, error: 'an organization key needs its organization' };
    if (p.keyId !== this.deps.keys.publicKey.keyId)
      return {
        stored: false,
        error: 'the key was encrypted for another runner key (the runner key changed): enter it again',
      };
    if (source === 'org') {
      const refused = this.generationProblem(p.orgId as string, p.provider, p.generation);
      if (refused) return { stored: false, error: refused };
    }
    if ((BACKEND_IDS as readonly string[]).includes(p.provider))
      return this.setBackend(p, source, p.provider as BackendId);
    const def = directProvider(p.provider);
    if (!def) return { stored: false, error: 'unknown provider' };
    // what a sealed key is bound to: the endpoint the server named (checked below, and again against the blob)
    const endpoint = normalizeEndpoint(p.baseUrl);
    let baseUrl: string | undefined;
    let warning: string | undefined;
    if (def.needsBaseUrl) {
      if (!p.baseUrl?.trim()) return { stored: false, error: 'enter the endpoint (base URL)' };
      const v = validateBaseUrl(p.baseUrl);
      if (!v.ok) return { stored: false, error: v.error };
      // a private-network address is reachable only when the workstation's owner listed that exact host:port; an organization's
      // endpoint is untrusted on a member's machine: https to a public address, or listed (loopback is not exempt)
      const blocked =
        source === 'org'
          ? orgCredentialEndpointProblem(v.url, this.endpoints())
          : baseUrlEndpointProblem(v.url, this.endpoints());
      if (blocked) return { stored: false, error: blocked };
      baseUrl = v.url;
      warning = v.warning;
    }
    let plain: string | undefined;
    let bound = false;
    if (p.ciphertext) {
      const r = this.openSet(p, source, endpoint);
      if ('error' in r) return { stored: false, error: r.error };
      plain = r.plain.trim();
      bound = r.bound;
      if (r.warning) warning = warning ? `${warning} ${r.warning}` : r.warning;
      if (!plain) return { stored: false, error: 'empty key' };
    } else if (!def.keyOptional) {
      return { stored: false, error: `${def.label} needs an API key` };
    }
    const all = this.slotFor(source, p.orgId);
    const old = all[p.provider];
    this.unregister(old?.ciphertext, old && this.aadOf(source, p.orgId, p.provider, old));
    all[p.provider] = {
      ...(p.ciphertext ? { ciphertext: p.ciphertext } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      models: [...new Set(p.models.map((m) => m.trim()).filter(Boolean))],
      setAt: new Date().toISOString(),
      ...(bound
        ? { bound: true as const, endpoint, ...(source === 'org' ? { generation: p.generation } : {}) }
        : {}),
    };
    this.saveSlot(source, p.orgId, all);
    if (plain) registerSecret(plain);
    for (const f of this.changed) f();
    return { stored: true, ...(warning ? { warning } : {}) };
  }

  /** An organization key is accepted only at a generation newer than any revoked here and not older than the one held. */
  private generationProblem(
    orgId: string,
    provider: string,
    generation: number | undefined,
  ): string | undefined {
    if (!generation)
      return 'this organization key does not say which version it is: update the web app and enter it again';
    if (generation <= this.floorOf(orgId, provider))
      return 'this organization key was revoked or replaced: it is not accepted again';
    const held = this.orgs()[orgId]?.[provider as ProviderKeyId]?.generation;
    if (held && generation < held) return 'a newer version of this organization key is already stored';
    return undefined;
  }

  private setBackend(p: ProviderKeySetPayload, source: KeySource, id: BackendId): ProviderKeyResult {
    if (!p.ciphertext)
      return { stored: false, error: `${backendDef(id)?.label ?? id} needs its credentials` };
    // the credential's endpoint is inside the blob: the command names it, the blob is opened bound to it, and the fields must agree
    const endpoint = normalizeEndpoint(p.baseUrl);
    const opened = this.openSet(p, source, endpoint);
    if ('error' in opened)
      return { stored: false, error: opened.error.replace('the key could', 'the credentials could') };
    let fields: Record<string, string>;
    try {
      const parsed = JSON.parse(opened.plain) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      fields = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '').trim()]),
      );
    } catch {
      return { stored: false, error: 'the credentials could not be decrypted: enter them again' };
    }
    const bad = validateBackendFields(id, fields);
    if (bad) return { stored: false, error: bad };
    if (opened.bound && normalizeEndpoint(fields.baseUrl) !== endpoint)
      return {
        stored: false,
        error: 'the credentials are for another endpoint than the one named: enter them again',
      };
    if (source === 'org' && fields.baseUrl) {
      const blocked = orgCredentialEndpointProblem(fields.baseUrl, this.endpoints());
      if (blocked) return { stored: false, error: blocked };
    }
    const all = this.slotFor(source, p.orgId);
    const old = all[id];
    this.unregister(old?.ciphertext, old && this.aadOf(source, p.orgId, id, old));
    all[id] = {
      ciphertext: p.ciphertext,
      models: [...new Set(p.models.map((m) => m.trim()).filter(Boolean))],
      setAt: new Date().toISOString(),
      ...(opened.bound
        ? { bound: true as const, endpoint, ...(source === 'org' ? { generation: p.generation } : {}) }
        : {}),
    };
    this.saveSlot(source, p.orgId, all);
    this.register(p.ciphertext, this.aadOf(source, p.orgId, id, all[id] as StoredProvider));
    for (const f of this.changed) f();
    const plainHttp =
      fields.baseUrl?.startsWith('http://') && !/^http:\/\/(localhost|127\.|\[::1\])/.test(fields.baseUrl)
        ? 'This endpoint uses plain http:// away from this machine: the credentials and every prompt travel unencrypted. Use https:// unless the network is trusted.'
        : undefined;
    const warning = [plainHttp, opened.warning].filter(Boolean).join(' ');
    return { stored: true, ...(warning ? { warning } : {}) };
  }

  /**
   * `provider.key.clear`: forget the key and the endpoint of one slot (default: the workstation's own). An organization key's
   * generation is remembered as revoked, so a replayed copy of it is refused later.
   */
  clear(
    provider: ProviderKeyId,
    source: KeySource = 'workstation',
    orgId?: string,
    generation?: number,
  ): void {
    const all = this.slotFor(source, orgId);
    const old = all[provider];
    if (source === 'org' && orgId) {
      const g = Math.max(generation ?? 0, old?.generation ?? 0);
      if (g > 0) this.raiseFloor(orgId, provider, g);
    }
    if (!old) return;
    this.unregister(old.ciphertext, this.aadOf(source, orgId, provider, old));
    delete all[provider];
    this.saveSlot(source, orgId, all);
    for (const f of this.changed) f();
  }

  clearPayload(p: ProviderKeyClearPayload): void {
    this.clear(p.provider, p.source ?? 'workstation', p.orgId, p.generation);
  }

  /**
   * The slot in effect for a provider: the workstation's own key, else the key of `orgId`. Without an organization (a caller that
   * does not know it) only the workstation's own key counts: an organization key is never picked for a run that does not name its
   * organization. An organization key stored before keys were bound to their purpose is not used (it has to be entered again).
   */
  private slotOf(
    provider: string,
    orgId?: string,
  ): { source: KeySource; stored: StoredProvider; orgId?: string } | undefined {
    const own = this.own()[provider as ProviderKeyId];
    if (own) return { source: 'workstation', stored: own };
    if (!orgId) return undefined;
    const org = this.orgs()[orgId]?.[provider as ProviderKeyId];
    return org?.bound ? { source: 'org', stored: org, orgId } : undefined;
  }

  /** For the report only (names, models, whose key): the workstation's own, else the first organization that holds a bound one. */
  private reportSlotOf(
    provider: string,
  ): { source: KeySource; stored: StoredProvider; orgId?: string; orgAlso: boolean } | undefined {
    const holders = Object.entries(this.orgs()).filter(([, slot]) => slot[provider as ProviderKeyId]?.bound);
    const own = this.own()[provider as ProviderKeyId];
    if (own) return { source: 'workstation', stored: own, orgAlso: holders.length > 0 };
    const first = holders[0];
    if (!first) return undefined;
    return {
      source: 'org',
      stored: first[1][provider as ProviderKeyId] as StoredProvider,
      orgId: first[0],
      orgAlso: true,
    };
  }

  private configOf(
    provider: string,
    slot: { source: KeySource; stored: StoredProvider; orgId?: string },
  ): ProviderConfig | undefined {
    const s = slot.stored;
    // An endpoint on a private network stops working when its entry is removed from the allow-list.
    if (s.baseUrl) {
      const problem =
        slot.source === 'org'
          ? orgCredentialEndpointProblem(s.baseUrl, this.endpoints())
          : baseUrlEndpointProblem(s.baseUrl, this.endpoints());
      if (problem) return undefined;
    }
    let apiKey: string | undefined;
    if (s.ciphertext) {
      try {
        apiKey = this.open(s.ciphertext, this.aadOf(slot.source, slot.orgId, provider, s));
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

  /** The configuration of one provider with its key decrypted, or undefined when it is not set (or its key is unreadable). */
  get(provider: string, orgId?: string): ProviderConfig | undefined {
    if (!(DIRECT_PROVIDER_IDS as readonly string[]).includes(provider)) return undefined;
    const slot = this.slotOf(provider, orgId);
    return slot ? this.configOf(provider, slot) : undefined;
  }

  /** The providers that are set for a run of `orgId` (the workstation's own, else that organization's), with their keys readable. */
  configured(orgId?: string): ProviderConfig[] {
    return DIRECT_PROVIDER_IDS.map((id) => this.get(id, orgId)).filter((c): c is ProviderConfig => !!c);
  }

  private backendOf(
    id: BackendId,
    slot: { source: KeySource; stored: StoredProvider; orgId?: string },
  ): BackendConfig | undefined {
    if (!slot.stored.ciphertext) return undefined;
    try {
      const j = JSON.parse(
        this.open(slot.stored.ciphertext, this.aadOf(slot.source, slot.orgId, id, slot.stored)),
      ) as Record<string, unknown>;
      const fields = Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? '')]));
      if (
        slot.source === 'org' &&
        fields.baseUrl &&
        orgCredentialEndpointProblem(fields.baseUrl, this.endpoints())
      )
        return undefined;
      return { id, fields, models: slot.stored.models ?? [], source: slot.source };
    } catch {
      return undefined;
    }
  }

  /**
   * For availability reports only (no run, no organization in hand): the providers that have a readable key here, the workstation's
   * own or any organization's, WITHOUT the key. Never use this to run something: a run names its organization and calls `get`.
   */
  reportConfigured(): ProviderConfig[] {
    const out: ProviderConfig[] = [];
    for (const id of DIRECT_PROVIDER_IDS) {
      const slot = this.reportSlotOf(id);
      const c = slot ? this.configOf(id, slot) : undefined;
      if (c) {
        const { apiKey: _key, ...rest } = c;
        out.push(rest);
      }
    }
    return out;
  }

  /** Is a readable key for the provider held here (the workstation's own or an organization's)? For availability reports only. */
  holds(provider: string): boolean {
    return this.reportConfigured().some((c) => c.id === provider);
  }

  /** A backend's credential opened, or undefined when it is not set or unreadable. */
  getBackend(id: BackendId, orgId?: string): BackendConfig | undefined {
    const slot = this.slotOf(id, orgId);
    return slot ? this.backendOf(id, slot) : undefined;
  }

  configuredBackends(orgId?: string): BackendConfig[] {
    return BACKEND_IDS.map((id) => this.getBackend(id, orgId)).filter((c): c is BackendConfig => !!c);
  }

  /** Whose key is in effect for a provider, or null. */
  sourceOf(provider: string, orgId?: string): KeySource | null {
    return this.slotOf(provider, orgId)?.source ?? null;
  }

  /** Claude Code backends with a credential here: names, models and whose credential it is. */
  reportBackends(): ReportedBackend[] {
    const out: ReportedBackend[] = [];
    for (const id of BACKEND_IDS) {
      const slot = this.reportSlotOf(id);
      const c = slot ? this.backendOf(id, slot) : undefined;
      if (!slot || !c) continue;
      const def = backendDef(c.id);
      const ids = new Map<string, { id: string; label: string; tier?: 'small' | 'medium' | 'large' }>();
      for (const m of def?.models ?? []) ids.set(m.id, { id: m.id, label: m.label, tier: m.tier });
      for (const mid of c.models) if (!ids.has(mid)) ids.set(mid, { id: mid, label: mid });
      const detail = backendDetail(c.id, c.fields);
      out.push({
        id: c.id,
        label: def?.label ?? c.id,
        models: [...ids.values()].map(({ tier, ...m }) => ({ ...m, ...(tier ? { tier } : {}) })),
        ...(detail ? { detail } : {}),
        keySource: c.source,
        ...(slot.orgAlso ? { orgKey: true } : {}),
      });
    }
    return out;
  }

  /** Every stored key and whose it is, for the server's resolution and caps. */
  reportKeys(): ReportedKey[] {
    const out: ReportedKey[] = [];
    const orgs = this.orgs();
    for (const id of [...DIRECT_PROVIDER_IDS, ...BACKEND_IDS] as ProviderKeyId[]) {
      const own = !!this.own()[id];
      const orgIds = Object.entries(orgs)
        .filter(([, slot]) => slot[id]?.bound)
        .map(([o]) => o);
      if (!own && orgIds.length === 0) continue;
      out.push({
        provider: id,
        source: own ? 'workstation' : 'org',
        ...(orgIds.length ? { orgKey: true, orgIds: orgIds.slice(0, 50) } : {}),
      });
    }
    return out;
  }

  /** Is the organization's key stored here (it may be overridden by the workstation's own)? */
  hasOrgKey(provider: ProviderKeyId, orgId: string): boolean {
    return !!this.orgs()[orgId]?.[provider]?.bound;
  }

  /** Organization keys stored in the older, unbound form: they are not used until the admin enters them again. */
  legacyOrgKeys(): Array<{ orgId: string; provider: string }> {
    return Object.entries(this.orgs()).flatMap(([orgId, slot]) =>
      Object.entries(slot)
        .filter(([, v]) => v?.ciphertext && !v.bound)
        .map(([provider]) => ({ orgId, provider })),
    );
  }

  /**
   * `provider.key.reseal`: opens the organization's key and seals it to another runner's public key, for an Owner or Admin who
   * approved sharing it. The approval is made in the admin's browser and sealed to THIS runner: it names the target runner's key
   * id and the hash of its public key, and this function recomputes both from the public key it is asked to seal to, so a server
   * that swaps in another key (or sends no approval) gets nothing. Each approval works once, for this key generation only. The
   * plain key exists in this function only; the answer is the ciphertext for the target.
   */
  async reseal(p: {
    provider: ProviderKeyId;
    orgId: string;
    targetKeyId: string;
    targetPublicKey: string;
    approval?: string;
    generation?: number;
  }): Promise<ProviderKeyResealResult> {
    const { provider, orgId } = p;
    const stored = this.orgs()[orgId]?.[provider];
    if (!stored?.bound) return { ok: false, error: 'this workstation does not hold the organization key' };
    // keyless endpoints have nothing to seal: the server shares the settings itself
    if (!stored.ciphertext) return { ok: false, error: 'this key has no secret to share' };
    if (!p.approval)
      return { ok: false, error: 'sharing needs the approval of an Owner or Admin made in the web app' };
    const own = this.deps.keys.publicKey.keyId;
    const now = (this.deps.now ?? Date.now)();
    let approval: ReturnType<typeof ResealApprovalSchema.parse>;
    try {
      approval = ResealApprovalSchema.parse(
        JSON.parse(this.open(p.approval, resealApprovalAad({ orgId, provider, sourceKeyId: own }), true)),
      );
    } catch {
      return {
        ok: false,
        error: 'the approval could not be opened: approve the sharing again in the web app',
      };
    }
    if (approval.orgId !== orgId || approval.provider !== provider || approval.sourceKeyId !== own)
      return { ok: false, error: 'the approval is for another key or workstation' };
    if (approval.exp <= now || approval.exp > now + RESEAL_APPROVAL_MAX_MS)
      return { ok: false, error: 'the approval expired: approve the sharing again' };
    if (approval.generation !== stored.generation || (p.generation && p.generation !== stored.generation))
      return { ok: false, error: 'the approval is for another version of the key' };
    // the key the server wants us to seal to must be the one the admin was shown
    let spkiHash: string;
    let spkiKeyId: string;
    try {
      spkiHash = await spkiSha256(p.targetPublicKey);
      spkiKeyId = await keyIdOfSpki(p.targetPublicKey);
    } catch {
      return { ok: false, error: 'the target workstation’s public key is not valid' };
    }
    if (
      spkiKeyId !== p.targetKeyId ||
      approval.targetKeyId !== spkiKeyId ||
      approval.targetPublicKeySha256 !== spkiHash
    )
      return { ok: false, error: 'the target workstation’s key is not the one that was approved' };
    if (spkiKeyId === own) return { ok: false, error: 'the target is this workstation' };
    if (!this.approvals.claim(`reseal:${approval.nonce}`, approval.exp))
      return { ok: false, error: 'this approval was already used: approve the sharing again' };
    let plain: string;
    try {
      plain = this.open(stored.ciphertext, this.aadOf('org', orgId, provider, stored));
    } catch {
      return { ok: false, error: 'the stored key could not be opened' };
    }
    const generation = stored.generation as number;
    return {
      ok: true,
      generation,
      ciphertext: await sealProviderKey(p.targetPublicKey, plain, {
        scope: 'org',
        orgId,
        provider,
        endpoint: stored.endpoint ?? '',
        generation,
        keyId: spkiKeyId,
      }),
    };
  }

  /**
   * What the server may know: provider ids, labels, models, the endpoint's host, whose key it is and a problem text. `listed` holds
   * model ids fetched from an OpenAI-compatible endpoint (`models.ts`), `problems` the last failed check per provider.
   */
  report(
    listed: Partial<Record<string, string[]>> = {},
    problems: Partial<Record<string, string>> = {},
  ): ReportedProvider[] {
    const reportable: Array<{ c: ProviderConfig; orgAlso: boolean }> = [];
    for (const id of DIRECT_PROVIDER_IDS) {
      const slot = this.reportSlotOf(id);
      const c = slot ? this.configOf(id, slot) : undefined;
      if (slot && c) reportable.push({ c, orgAlso: slot.orgAlso });
    }
    return reportable.map(({ c, orgAlso }) => {
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
        ...(orgAlso ? { orgKey: true } : {}),
      };
    });
  }
}

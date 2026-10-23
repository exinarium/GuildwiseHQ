import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DIRECT_PROVIDER_IDS,
  type DirectProviderId,
  directProvider,
  type ProviderKeyResult,
  type ProviderKeySetPayload,
  type ReportedProvider,
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

/** What the adapter needs to call a provider. The key is plain text: never log it, never put it in an event. */
export interface ProviderConfig {
  id: DirectProviderId;
  apiKey?: string;
  baseUrl?: string;
  models: string[];
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
 * Provider credentials of the direct-model runtime (docs/ARCHITECTURE.md section 38.3), the way the sudo password and the test
 * accounts are kept: `<data dir>/secrets/providers.json` (mode 0600) holds `{provider: {ciphertext, baseUrl, models}}`. The
 * browser sealed the key with this runner's public key; the server relayed the ciphertext and never saw the key. The key is
 * decrypted in memory when a turn needs it and registered with the redaction registry, so logs, tool summaries and error
 * messages never show it. Only names and models leave this machine (`report`).
 */
export class ProviderStore {
  private changed: Array<() => void> = [];

  constructor(
    private readonly deps: {
      file: string;
      keys: Pick<RunnerKeys, 'decrypt'> & { publicKey: { keyId: string } };
    },
  ) {
    // After a restart, redaction must know the keys before the first log line.
    for (const p of Object.values(this.all())) if (p.ciphertext) this.register(p.ciphertext);
  }

  onChange(fn: () => void): void {
    this.changed.push(fn);
  }

  private all(): Partial<Record<DirectProviderId, StoredProvider>> {
    if (!existsSync(this.deps.file)) return {};
    try {
      const j = JSON.parse(readFileSync(this.deps.file, 'utf8')) as unknown;
      return j && typeof j === 'object' ? (j as Partial<Record<DirectProviderId, StoredProvider>>) : {};
    } catch {
      return {};
    }
  }

  private save(all: Partial<Record<DirectProviderId, StoredProvider>>): void {
    mkdirSync(dirname(this.deps.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.deps.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, this.deps.file);
    try {
      chmodSync(this.deps.file, 0o600);
    } catch {
      // Windows
    }
  }

  private register(ciphertext: string): void {
    try {
      registerSecret(this.deps.keys.decrypt(ciphertext));
    } catch {
      // sealed for another key: unreadable anyway
    }
  }

  private unregister(ciphertext: string | undefined): void {
    if (!ciphertext) return;
    try {
      unregisterSecret(this.deps.keys.decrypt(ciphertext));
    } catch {
      // unreadable
    }
  }

  /** `provider.key.set`. Never returns or logs the key. */
  set(p: ProviderKeySetPayload): ProviderKeyResult {
    const def = directProvider(p.provider);
    if (!def) return { stored: false, error: 'unknown provider' };
    if (p.keyId !== this.deps.keys.publicKey.keyId)
      return {
        stored: false,
        error: 'the key was encrypted for another runner key (the runner key changed): enter it again',
      };
    let plain: string | undefined;
    if (p.ciphertext) {
      try {
        plain = this.deps.keys.decrypt(p.ciphertext);
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
    const all = this.all();
    this.unregister(all[p.provider]?.ciphertext);
    all[p.provider] = {
      ...(p.ciphertext ? { ciphertext: p.ciphertext } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      models: [...new Set(p.models.map((m) => m.trim()).filter(Boolean))],
      setAt: new Date().toISOString(),
    };
    this.save(all);
    if (plain) registerSecret(plain);
    for (const f of this.changed) f();
    return { stored: true, ...(warning ? { warning } : {}) };
  }

  /** `provider.key.clear`: forget the key and the endpoint. */
  clear(provider: DirectProviderId): void {
    const all = this.all();
    if (!all[provider]) return;
    this.unregister(all[provider]?.ciphertext);
    delete all[provider];
    this.save(all);
    for (const f of this.changed) f();
  }

  /** The configuration of one provider with its key decrypted, or undefined when it is not set (or its key is unreadable). */
  get(provider: string): ProviderConfig | undefined {
    const s = this.all()[provider as DirectProviderId];
    if (!s || !(DIRECT_PROVIDER_IDS as readonly string[]).includes(provider)) return undefined;
    let apiKey: string | undefined;
    if (s.ciphertext) {
      try {
        apiKey = this.deps.keys.decrypt(s.ciphertext);
      } catch {
        return undefined;
      }
    }
    return {
      id: provider as DirectProviderId,
      ...(apiKey ? { apiKey } : {}),
      ...(s.baseUrl ? { baseUrl: s.baseUrl } : {}),
      models: s.models ?? [],
    };
  }

  /** The providers that are set, with their keys readable. */
  configured(): ProviderConfig[] {
    return DIRECT_PROVIDER_IDS.map((id) => this.get(id)).filter((c): c is ProviderConfig => !!c);
  }

  /**
   * What the server may know: provider ids, labels, models, the endpoint's host and a problem text. `listed` holds model ids
   * fetched from an OpenAI-compatible endpoint (`models.ts`), `problems` the last failed check per provider.
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
      };
    });
  }
}

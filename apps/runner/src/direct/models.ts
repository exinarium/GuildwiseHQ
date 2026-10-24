import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { splitDirectModel } from '@aom/shared';
import type { LanguageModel } from 'ai';
import { redact } from '../secrets/redact.ts';
import { parseServiceAccount, serviceAccountFetch } from './google-sa.ts';
import type { ProviderConfig } from './store.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Builds the AI SDK language model for `provider:model` (a choice's model id) from a stored provider. Tests inject their own. */
export type ModelFactory = (choiceModel: string, cfg: ProviderConfig, fetch?: FetchLike) => LanguageModel;

export const defaultModelFactory: ModelFactory = (choiceModel, cfg, fetch) => {
  const d = splitDirectModel(choiceModel);
  if (!d) throw new Error(`"${choiceModel}" is not a provider:model id`);
  const common = fetch ? { fetch: fetch as unknown as typeof globalThis.fetch } : {};
  switch (d.provider) {
    case 'anthropic':
      return createAnthropic({ ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}), ...common })(d.model);
    case 'openai':
      return createOpenAI({ ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}), ...common })(d.model);
    case 'google': {
      // a service-account JSON is exchanged for a bearer token on each call; an API key is sent as is
      const sa = parseServiceAccount(cfg.apiKey);
      if (sa)
        return createGoogleGenerativeAI({
          apiKey: 'service-account',
          fetch: serviceAccountFetch(
            sa,
            (fetch ?? globalThis.fetch) as FetchLike,
          ) as unknown as typeof globalThis.fetch,
        })(d.model);
      return createGoogleGenerativeAI({ ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}), ...common })(d.model);
    }
    case 'openai-compatible': {
      if (!cfg.baseUrl) throw new Error('the OpenAI-compatible endpoint has no base URL');
      return createOpenAICompatible({
        name: 'openai-compatible',
        baseURL: cfg.baseUrl,
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        includeUsage: true,
        ...common,
      })(d.model);
    }
  }
};

const LIST_TTL_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 5_000;
/** The most of a `/models` answer that is read: a real list is a few tens of KB. */
export const MODEL_LIST_MAX_BYTES = 1_000_000;

/** The body of a response as text, never more than `max` bytes (the rest is not read). Undefined: it was larger. */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return undefined;
  if (!res.body) {
    const t = await res.text();
    return t.length > max ? undefined : t;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Model ids an OpenAI-compatible endpoint offers (`GET <base>/models`), cached for ten minutes and refreshed when the provider
 * changes. A failure is a short problem text (never the key) and an empty list: the owner's own extra model ids still work.
 */
export class ModelLister {
  private cache = new Map<string, { at: number; ids: string[]; problem?: string }>();
  /** A list being fetched, per provider: concurrent callers wait for it instead of starting their own request. */
  private readonly inflight = new Map<string, Promise<{ ids: string[]; problem?: string }>>();

  constructor(private readonly deps: { fetch?: FetchLike; now?: () => number } = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Bumped when a provider's settings change: a fetch that started before must not fill the cache with the old answer. */
  private generation = 0;

  invalidate(provider?: string): void {
    this.generation++;
    if (provider) {
      this.cache.delete(provider);
      this.inflight.delete(provider);
    } else {
      this.cache.clear();
      this.inflight.clear();
    }
  }

  /** What is cached for a provider and whether it is still fresh (a stale or missing list is refreshed in the background). */
  peek(provider: string): { ids: string[]; problem?: string; fresh: boolean } {
    const hit = this.cache.get(provider);
    return hit
      ? {
          ids: hit.ids,
          ...(hit.problem ? { problem: hit.problem } : {}),
          fresh: this.now() - hit.at < LIST_TTL_MS,
        }
      : { ids: [], fresh: false };
  }

  async refresh(cfg: ProviderConfig, force = false): Promise<{ ids: string[]; problem?: string }> {
    if (cfg.id !== 'openai-compatible' || !cfg.baseUrl) return { ids: [] };
    const hit = this.cache.get(cfg.id);
    if (!force && hit && this.now() - hit.at < LIST_TTL_MS)
      return { ids: hit.ids, ...(hit.problem ? { problem: hit.problem } : {}) };
    const running = this.inflight.get(cfg.id);
    if (running) return running;
    const p: Promise<{ ids: string[]; problem?: string }> = this.fetchList(cfg).finally(() => {
      if (this.inflight.get(cfg.id) === p) this.inflight.delete(cfg.id);
    });
    this.inflight.set(cfg.id, p);
    return p;
  }

  private async fetchList(cfg: ProviderConfig): Promise<{ ids: string[]; problem?: string }> {
    const gen = this.generation;
    const f = this.deps.fetch ?? ((url, init) => fetch(url, init));
    let out: { ids: string[]; problem?: string };
    try {
      const res = await f(`${cfg.baseUrl}/models`, {
        headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      if (!res.ok) {
        out = {
          ids: [],
          problem:
            res.status === 401 || res.status === 403
              ? 'the endpoint refused the key'
              : `the endpoint's model list answered HTTP ${res.status}`,
        };
      } else {
        const text = await readCapped(res, MODEL_LIST_MAX_BYTES);
        if (text === undefined) throw new Error('the model list is too large');
        const body = JSON.parse(text) as { data?: Array<{ id?: unknown }> };
        const ids = (Array.isArray(body.data) ? body.data : [])
          .map((m) => (typeof m.id === 'string' ? m.id : ''))
          .filter((id) => id && id.length <= 120)
          .slice(0, 200);
        out = { ids };
      }
    } catch (err) {
      out = {
        ids: [],
        problem: redact(
          `cannot reach the endpoint: ${err instanceof Error ? err.message : String(err)}`,
        ).slice(0, 200),
      };
    }
    if (gen === this.generation) this.cache.set(cfg.id, { at: this.now(), ...out });
    return out;
  }
}

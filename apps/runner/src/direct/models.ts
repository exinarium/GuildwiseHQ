import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { splitDirectModel } from '@aom/shared';
import type { LanguageModel } from 'ai';
import { redact } from '../secrets/redact.ts';
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
    case 'google':
      return createGoogleGenerativeAI({ ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}), ...common })(d.model);
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

/**
 * Model ids an OpenAI-compatible endpoint offers (`GET <base>/models`), cached for ten minutes and refreshed when the provider
 * changes. A failure is a short problem text (never the key) and an empty list: the owner's own extra model ids still work.
 */
export class ModelLister {
  private cache = new Map<string, { at: number; ids: string[]; problem?: string }>();

  constructor(private readonly deps: { fetch?: FetchLike; now?: () => number } = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  invalidate(provider?: string): void {
    if (provider) this.cache.delete(provider);
    else this.cache.clear();
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
        const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
        const ids = (body.data ?? [])
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
    this.cache.set(cfg.id, { at: this.now(), ...out });
    return out;
  }
}

import { createHash } from 'node:crypto';
import type { ModelMessage, SystemModelMessage } from 'ai';

type ProviderOptions = Record<string, Record<string, unknown>>;

export interface CachedPrompt {
  system: string | SystemModelMessage;
  messages: ModelMessage[];
  providerOptions: ProviderOptions;
}

/**
 * Prompt caching for the direct-model runtime. The prompt is already ordered stable-first (instructions, then the tool list,
 * then the conversation), which is what every provider's cache keys on: the prefix has to be byte-identical between calls.
 *
 * - Anthropic caches only what is marked: a breakpoint on the system prompt (it covers the tool definitions before it) and, in a
 *   chat that has earlier messages, on the last of them, so the next turn re-reads the whole history at the cache-read price.
 * - OpenAI caches a long enough prefix by itself; `promptCacheKey` (stable for one persona/instructions text) steers requests
 *   with the same prefix to the same cache.
 * - Gemini 2.5 caches an identical prefix implicitly: nothing to set.
 * - Any other endpoint gets the prompt as it is.
 *
 * What the provider reports (cache reads and writes) is booked in the turn's usage and priced from the model's cache prices.
 */
export function withPromptCaching(
  provider: string,
  instructions: string,
  messages: ModelMessage[],
  priorCount: number,
): CachedPrompt {
  if (provider === 'anthropic' && instructions) {
    const mark = { anthropic: { cacheControl: { type: 'ephemeral' } } };
    const out = messages.map((m, i) => (i === priorCount - 1 ? { ...m, providerOptions: mark } : m));
    return {
      system: { role: 'system', content: instructions, providerOptions: mark },
      messages: out as ModelMessage[],
      providerOptions: {},
    };
  }
  if (provider === 'openai' && instructions) {
    const key = `aom-${createHash('sha256').update(instructions).digest('hex').slice(0, 24)}`;
    return { system: instructions, messages, providerOptions: { openai: { promptCacheKey: key } } };
  }
  return { system: instructions, messages, providerOptions: {} };
}

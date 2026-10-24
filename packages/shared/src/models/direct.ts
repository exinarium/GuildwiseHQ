import { z } from 'zod';
import { BACKEND_IDS } from './backends.ts';

/**
 * The direct-model runtime (docs/ARCHITECTURE.md section 38.3): one runner adapter that talks to a provider's API with the
 * Vercel AI SDK. It has no shell, no edit tool and no files; it speaks in session turns and plain chats. The provider keys
 * live on the runner only. This module is the data both sides share: the providers, their built-in models, the price table.
 */
export const DIRECT_RUNTIME = 'direct-model';
/** Announced in `hello.capabilities` by runners that have the direct-model adapter. */
export const DIRECT_MODEL_CAPABILITY = 'direct-model:1';

export const DIRECT_PROVIDER_IDS = ['anthropic', 'openai', 'google', 'openai-compatible'] as const;
export const DirectProviderIdSchema = z.enum(DIRECT_PROVIDER_IDS);
export type DirectProviderId = z.infer<typeof DirectProviderIdSchema>;

/**
 * Every id a provider key or credential is stored under on a workstation: the direct-model providers and the Claude Code
 * backends (`bedrock`, `vertex`, `gateway`; see backends.ts).
 */
export const PROVIDER_KEY_IDS = [...DIRECT_PROVIDER_IDS, ...BACKEND_IDS] as const;
export const ProviderKeyIdSchema = z.enum(PROVIDER_KEY_IDS);
export type ProviderKeyId = z.infer<typeof ProviderKeyIdSchema>;

/**
 * Whose key a call used: the organization's (sealed to this workstation by an Owner or Admin, subject to the monthly cap) or the
 * workstation's own (which overrides it and is not subject to the cap).
 */
export const KeySourceSchema = z.enum(['org', 'workstation']);
export type KeySource = z.infer<typeof KeySourceSchema>;

/** Announced in `hello.capabilities` by runners that keep an organization key beside the workstation's own and know the backends. */
export const PROVIDER_KEYS_CAPABILITY = 'provider-keys:2';

export type ModelTier = 'small' | 'medium' | 'large';

export interface DirectModelDef {
  id: string;
  label: string;
  tier: ModelTier;
  /** USD per million tokens. Absent: the price is unknown and a turn on it is flagged "cost unknown", never priced at zero. */
  price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

export interface DirectProviderDef {
  id: DirectProviderId;
  label: string;
  /** What the key field is called in the settings. */
  keyLabel: string;
  /** The endpoint is typed in (OpenAI-compatible: OpenRouter, Ollama, LiteLLM, LM Studio). */
  needsBaseUrl: boolean;
  /** An API key is optional (a local Ollama or LM Studio needs none). */
  keyOptional: boolean;
  baseUrlHint?: string;
  /** Shown beside the provider in settings and in the legal list: where the data goes. */
  dataNote: string;
  /** Built-in models. A runner may add more (`providers.json` custom list; a model list fetched from an OpenAI-compatible endpoint). */
  models: readonly DirectModelDef[];
}

/**
 * Providers and their built-in models. Prices are list prices in USD per million tokens as checked in October 2026; they are
 * DEFAULTS, not billing data (see `DEFAULT_MODEL_PRICES` in costs). Anthropic models are priced from that table, so there is
 * one place for Claude prices. A model that is not here and not in `DEFAULT_MODEL_PRICES` is "cost unknown".
 */
export const DIRECT_PROVIDERS: readonly DirectProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic API',
    keyLabel: 'Anthropic API key',
    needsBaseUrl: false,
    keyOptional: false,
    dataNote:
      "Calls go from this workstation straight to Anthropic's API with your own key. Guildwise never sees the key or the traffic.",
    models: [
      { id: 'claude-haiku-5-5', label: 'Claude Haiku', tier: 'small' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet', tier: 'medium' },
      { id: 'claude-opus-5-5', label: 'Claude Opus', tier: 'large' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    keyLabel: 'OpenAI API key',
    needsBaseUrl: false,
    keyOptional: false,
    dataNote:
      "Calls go from this workstation straight to OpenAI's API with your own key. Guildwise never sees the key or the traffic.",
    models: [
      {
        id: 'gpt-5-nano',
        label: 'GPT-5 nano',
        tier: 'small',
        price: { input: 0.05, output: 0.4, cacheRead: 0.005 },
      },
      {
        id: 'gpt-5-mini',
        label: 'GPT-5 mini',
        tier: 'medium',
        price: { input: 0.25, output: 2, cacheRead: 0.025 },
      },
      {
        id: 'gpt-4.1',
        label: 'GPT-4.1',
        tier: 'medium',
        price: { input: 2, output: 8, cacheRead: 0.5 },
      },
      {
        id: 'gpt-5',
        label: 'GPT-5',
        tier: 'large',
        price: { input: 1.25, output: 10, cacheRead: 0.125 },
      },
    ],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    keyLabel: 'Gemini API key',
    needsBaseUrl: false,
    keyOptional: false,
    dataNote:
      "Calls go from this workstation straight to Google's Gemini API with your own key. Guildwise never sees the key or the traffic.",
    models: [
      {
        id: 'gemini-2.5-flash-lite',
        label: 'Gemini 2.5 Flash-Lite',
        tier: 'small',
        price: { input: 0.1, output: 0.4, cacheRead: 0.025 },
      },
      {
        id: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        tier: 'medium',
        price: { input: 0.3, output: 2.5, cacheRead: 0.075 },
      },
      {
        id: 'gemini-2.5-pro',
        label: 'Gemini 2.5 Pro',
        tier: 'large',
        price: { input: 1.25, output: 10, cacheRead: 0.31 },
      },
    ],
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    keyLabel: 'API key (if the endpoint needs one)',
    needsBaseUrl: true,
    keyOptional: true,
    baseUrlHint:
      'For example https://openrouter.ai/api/v1, http://localhost:11434/v1 (Ollama) or your LiteLLM URL',
    dataNote:
      'Calls go from this workstation straight to the endpoint you enter (OpenRouter, Ollama, LiteLLM, LM Studio, ...). That endpoint and whatever it forwards to are outside Guildwise.',
    models: [],
  },
];

export const directProvider = (id: string): DirectProviderDef | undefined =>
  DIRECT_PROVIDERS.find((p) => p.id === id);

/** A direct-model choice names its model as `<provider>:<model id>` (the model id may itself contain `:` or `/`). */
export function directModelId(provider: string, model: string): string {
  return `${provider}:${model}`;
}
export function splitDirectModel(id: string): { provider: DirectProviderId; model: string } | null {
  const i = id.indexOf(':');
  if (i < 1) return null;
  const provider = id.slice(0, i);
  const model = id.slice(i + 1);
  return model && (DIRECT_PROVIDER_IDS as readonly string[]).includes(provider)
    ? { provider: provider as DirectProviderId, model }
    : null;
}

/** What a runner tells the server about one configured provider: names and models only, never a key or an endpoint secret. */
export const ReportedProviderModelSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
  tier: z.enum(['small', 'medium', 'large']).optional(),
});
export const ReportedProviderSchema = z.object({
  id: DirectProviderIdSchema,
  label: z.string().max(80),
  models: z.array(ReportedProviderModelSchema).max(200),
  /** The endpoint host of an OpenAI-compatible provider (no path, no credentials), so the owner can tell setups apart. */
  endpointHost: z.string().max(200).optional(),
  /** The last check of the key or endpoint failed (the text is short and never contains the key). */
  problem: z.string().max(300).optional(),
  /** Whose key is in effect here (workstation key over organization key). Absent from older runners: the workstation's. */
  keySource: KeySourceSchema.optional(),
  /** An organization key is also stored here (it is overridden when `keySource` is `workstation`). */
  orgKey: z.boolean().optional(),
});
export type ReportedProvider = z.infer<typeof ReportedProviderSchema>;

// ------------------------------------------------------------------------------------------------- prices

/**
 * The price of a direct model, USD per million tokens, or null when unknown. Anthropic: from `anthropicPrice` (the default
 * table; pass the lookup so this module needs no import of it). Others: longest known model id that is a prefix of `model`
 * (a dated snapshot `gpt-5-mini-2025-08-07` is priced like `gpt-5-mini`).
 */
export function directPrice(
  provider: string,
  model: string,
  anthropicPrice?: (model: string) => DirectModelDef['price'] | null,
): DirectModelDef['price'] | null {
  if (provider === 'anthropic') return anthropicPrice?.(model) ?? null;
  const def = directProvider(provider);
  if (!def) return null;
  const m = model.toLowerCase();
  const hit = [...def.models]
    .filter((x) => x.price)
    .sort((a, b) => b.id.length - a.id.length)
    .find((x) => m === x.id || m.startsWith(`${x.id}-`));
  return hit?.price ?? null;
}

// ------------------------------------------------------------------------------------------------- provider keys

/**
 * `provider.key.set` (durable command, an envelope command like `env.secret.set`): one provider's API key sealed in the browser
 * with the runner's public key (RSA-OAEP, the same key as the sudo password). The server relays the ciphertext, empties the
 * payload once the runner answered, and never holds the key. `baseUrl` is the endpoint of an OpenAI-compatible provider
 * (it holds no secret; credentials in the URL are refused). `models` adds model ids to the provider's built-in list.
 */
export const ProviderKeySetPayloadSchema = z.object({
  provider: ProviderKeyIdSchema,
  keyId: z.string().min(1).max(64),
  /**
   * Absent: no key (only an OpenAI-compatible endpoint may be keyless, e.g. a local Ollama). A Claude Code backend's credential is
   * a sealed JSON of its fields (backends.ts) and always present. Sealed with RSA-OAEP (short keys) or `sealLarge` (`h1.`).
   */
  ciphertext: z.string().min(1).max(20000).optional(),
  /** Whose slot this fills. Absent (an older server): the workstation's own key. */
  source: KeySourceSchema.optional(),
  baseUrl: z.string().max(300).optional(),
  models: z.array(z.string().min(1).max(120)).max(50).default([]),
});
export type ProviderKeySetPayload = z.infer<typeof ProviderKeySetPayloadSchema>;
export type ProviderKeyClearPayload = z.infer<typeof ProviderKeyClearPayloadSchema>;
export const ProviderKeyClearPayloadSchema = z.object({
  provider: ProviderKeyIdSchema,
  /** Which slot to empty. Absent: the workstation's own key. */
  source: KeySourceSchema.optional(),
});
export const ProviderKeyResultSchema = z.object({
  stored: z.boolean(),
  error: z.string().max(500).optional(),
  /** The key was stored, but something deserves a second look (a plain-http endpoint that is not on this machine). */
  warning: z.string().max(500).optional(),
});
export type ProviderKeyResult = z.infer<typeof ProviderKeyResultSchema>;

/** `PUT /api/workstations/:id/providers/:provider`: the browser's sealed key (same shape as the command payload). */
export const SetProviderKeyRequestSchema = ProviderKeySetPayloadSchema.omit({ provider: true });
export type SetProviderKeyRequest = z.infer<typeof SetProviderKeyRequestSchema>;

/** `GET /api/workstations/:id/providers`: what the runner reports (names and models), and what the catalogue offers. */
export const WorkstationProvidersResponseSchema = z.object({
  workstationId: z.uuid(),
  /** The runner has the direct-model adapter (`direct-model:1`); an older one is told to update. */
  supported: z.boolean(),
  /** The workstation is connected right now (a key is stored only while it is). */
  online: z.boolean(),
  providers: z.array(ReportedProviderSchema),
  /** The last `provider.key.set` or `.clear` answer of the runner in this server process (transient). */
  lastResult: z
    .object({
      provider: ProviderKeyIdSchema,
      stored: z.boolean(),
      error: z.string().optional(),
      warning: z.string().optional(),
      at: z.iso.datetime(),
    })
    .nullable(),
});
export type WorkstationProvidersResponse = z.infer<typeof WorkstationProvidersResponseSchema>;

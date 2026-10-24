import { z } from 'zod';
import { BACKEND_IDS, BackendIdSchema, splitBackendModel } from './backends.ts';
import {
  DIRECT_PROVIDER_IDS,
  DIRECT_RUNTIME,
  type KeySource,
  KeySourceSchema,
  type ProviderKeyId,
  ProviderKeyIdSchema,
  splitDirectModel,
} from './direct.ts';
import { GEMINI_RUNTIME, OPENCODE_RUNTIME } from './runtimes.ts';

/** A model a runtime reports (the pickers list what each workstation really offers). */
export const ReportedModelSchema = z.object({
  id: z.string().min(1).max(160),
  label: z.string().min(1).max(160),
  tier: z.enum(['small', 'medium', 'large']).optional(),
});
export type ReportedModel = z.infer<typeof ReportedModelSchema>;

/** A Claude Code backend with a credential on this workstation, with the models it offers. Names only, never a secret. */
export const ReportedBackendSchema = z.object({
  id: BackendIdSchema,
  label: z.string().max(80),
  models: z.array(ReportedModelSchema).max(100),
  /** Region, project or gateway host, so setups can be told apart. */
  detail: z.string().max(200).optional(),
  keySource: KeySourceSchema.optional(),
  orgKey: z.boolean().optional(),
  problem: z.string().max(300).optional(),
});
export type ReportedBackend = z.infer<typeof ReportedBackendSchema>;

/** One stored credential and whose it is (the facts the server needs to resolve and cap: never the credential). */
export const ReportedKeySchema = z.object({
  provider: ProviderKeyIdSchema,
  /** The slot in effect on this workstation: its own key, else the organization's. */
  source: KeySourceSchema,
  /** An organization's key is stored here too (overridden when `source` is `workstation`). */
  orgKey: z.boolean().optional(),
  /** The organizations whose key is stored here: one workstation can serve several, each with its own key and cap. */
  orgIds: z.array(z.uuid()).max(50).optional(),
  /** Short note about the setup (region, endpoint host); no secret. */
  detail: z.string().max(200).optional(),
});
export type ReportedKey = z.infer<typeof ReportedKeySchema>;

/** `workstation key > organization key > none`. */
export function effectiveKeySource(slots: { workstation?: boolean; org?: boolean }): KeySource | null {
  return slots.workstation ? 'workstation' : slots.org ? 'org' : null;
}

/**
 * The provider key a model spends, or null when it spends none (a subscription login, a local model). The cap and the key source
 * attribute by this id. Claude Code with a backend qualifier names the backend; the direct-model runtime its provider; opencode
 * names the provider before the `/`; the Gemini CLI uses the `google` key only in API-key mode (the runner reports that).
 */
export function providerOfChoice(runtime: string, model: string): ProviderKeyId | null {
  if (runtime === 'claude-code') return splitBackendModel(model)?.backend ?? null;
  if (runtime === DIRECT_RUNTIME) return splitDirectModel(model)?.provider ?? null;
  if (runtime === GEMINI_RUNTIME) return 'google';
  if (runtime === OPENCODE_RUNTIME) {
    const head = model.split('/')[0] ?? '';
    return (DIRECT_PROVIDER_IDS as readonly string[]).includes(head) ? (head as ProviderKeyId) : null;
  }
  return null;
}

export interface KeyUseReport {
  id: string;
  available?: boolean;
  keys?: ReportedKey[];
  /** Gemini: how this workstation signs the runtime in (`key` spends the `google` key; `login` spends nothing). */
  authVia?: 'login' | 'key';
}

/**
 * Which stored key a run of this choice would spend on a workstation that reported `reports`, or null when none. The server uses
 * it before dispatch (a capped organization key refuses the run) and the pickers use it to show whose key pays.
 */
export function choiceKeyUse(
  reports: readonly KeyUseReport[],
  choice: { runtime: string; model: string },
  /** The organization the work belongs to: an organization key counts only when it is that organization's. */
  orgId?: string,
): { provider: ProviderKeyId; source: KeySource } | null {
  const provider = providerOfChoice(choice.runtime, choice.model);
  if (!provider) return null;
  if (choice.runtime === GEMINI_RUNTIME) {
    const rt = reports.find((r) => r.id === GEMINI_RUNTIME);
    if (rt?.authVia !== 'key') return null;
  }
  const keys = reports.find((r) => r.id === DIRECT_RUNTIME)?.keys ?? [];
  const k = keys.find((x) => x.provider === provider);
  if (!k) return null;
  // the key in effect is an organization's but not this organization's: this work has no key here. A report that does not say
  // which organizations the key belongs to proves nothing (a runner could claim it to pause or count against any organization).
  if (k.source === 'org' && orgId && !k.orgIds?.includes(orgId)) return null;
  return { provider, source: k.source };
}

/** Provider ids an organization key can be set for (every key this product holds). */
export const ORG_KEY_PROVIDERS: readonly ProviderKeyId[] = [...DIRECT_PROVIDER_IDS, ...BACKEND_IDS];

/** Display names for the provider ids (the org page and notices). */
export const PROVIDER_KEY_LABEL: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic API',
  openai: 'OpenAI',
  google: 'Google Gemini',
  'openai-compatible': 'OpenAI-compatible endpoint',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  gateway: 'Anthropic-compatible gateway',
};

/**
 * `provider.key.reseal`: an Owner or Admin approved sharing the organization key from this workstation (which holds it) to another.
 * The runner opens its own copy, seals the key to `targetPublicKey` (hybrid, RSA-OAEP + AES-GCM) and answers with the ciphertext;
 * the server stores it as the target's share and sends it on in a `provider.key.set`. The key is never plain outside the two runners.
 */
export const ProviderKeyResealPayloadSchema = z.object({
  provider: ProviderKeyIdSchema,
  /** Whose organization key to share. */
  orgId: z.uuid(),
  /** The target workstation's runner key (its id and SPKI public key), as the server knows them. */
  targetKeyId: z.string().min(1).max(64),
  targetPublicKey: z.string().min(1).max(2000),
  /** Who approved sharing, and to which workstation: for the server's bookkeeping when the answer arrives. */
  targetWorkstationId: z.uuid().optional(),
  approvedBy: z.uuid().optional(),
  /** The generation of the organization key the admin approved sharing (`org_providers.key_generation`). */
  generation: z.number().int().min(1).max(2_000_000_000).optional(),
  /**
   * `sealResealApproval` output: the admin's approval, sealed in their browser to THIS runner's key. The runner opens it and
   * shares only to the target key it names (recomputed from `targetPublicKey`). Without a valid one it refuses.
   */
  approval: z.string().max(8000).optional(),
});
export const ProviderKeyResealResultSchema = z.object({
  ok: z.boolean(),
  ciphertext: z.string().max(20000).optional(),
  /** The generation of the key that was sealed (the runner's own record): the server drops the answer if it is no longer current. */
  generation: z.number().int().optional(),
  error: z.string().max(300).optional(),
});
export type ProviderKeyResealResult = z.infer<typeof ProviderKeyResealResultSchema>;

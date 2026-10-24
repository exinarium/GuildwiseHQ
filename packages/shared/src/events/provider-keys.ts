import { z } from 'zod';
import { DirectProviderIdSchema, ProviderKeyIdSchema } from '../models/direct.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Organization-wide provider keys and their monthly spend caps (docs/ARCHITECTURE.md section 38.5). An event holds the FACTS
 * about a key (which provider, who set it, for which workstations), never the key: the sealed copies per workstation live in
 * `org_provider_key_shares`, outside the event store, so a revocation really deletes them. Spend itself is not an event: it is
 * `shift_costs` rows whose `key_source` is `org`.
 */
const Month = z.string().regex(/^\d{4}-\d{2}$/);

export const providerKeyEvents = [
  /** An Owner or Admin set (or replaced) the organization's key for a provider and sealed it to these workstations. */
  defineEvent(
    'OrgProviderKeySet',
    z.object({
      orgId: Id,
      provider: ProviderKeyIdSchema,
      by: Id,
      /** What the page shows beside the provider (region, project, endpoint host): never a secret. */
      detail: z.string().max(200).nullable(),
      /** The endpoint of an OpenAI-compatible provider or a gateway (credentials are refused in it); null for the others. */
      baseUrl: z.string().max(300).nullable().default(null),
      /** Extra model ids that go with the key (a gateway's models, an OpenAI-compatible endpoint's). */
      models: z.array(z.string().min(1).max(120)).max(50),
      workstationIds: z.array(Id).max(500),
      /** The generation this key got (`org_providers.key_generation`, one more than the one it replaces); 0 on older events. */
      generation: z.number().int().min(0).default(0),
    }),
  ),
  /** The key was sealed to one more workstation (the admin entered it again, or a runner that holds it re-sealed it). */
  defineEvent(
    'OrgProviderKeyShared',
    z.object({
      orgId: Id,
      provider: ProviderKeyIdSchema,
      workstationId: Id,
      by: Id,
      via: z.enum(['browser', 'runner']),
    }),
  ),
  /** The organization's key was revoked: every workstation forgets it. The cap setting stays. */
  defineEvent('OrgProviderKeyRevoked', z.object({ orgId: Id, provider: ProviderKeyIdSchema, by: Id })),
  /**
   * An Owner or Admin set (or removed, with null) the monthly cap of a provider, in USD micros. `clearWarned` / `clearPaused` are
   * computed by the command from the month's spend, like `ProjectBudgetSet`, so a replay needs no spend to reproduce them.
   */
  defineEvent(
    'OrgProviderCapSet',
    z.object({
      orgId: Id,
      provider: ProviderKeyIdSchema,
      monthlyMicros: z.number().int().positive().nullable(),
      by: Id,
      clearWarned: z.boolean().default(false),
      clearPaused: z.boolean().default(false),
    }),
  ),
  /** The month's spend on the organization's key reached the 80% or 100% threshold (once per month and level). */
  defineEvent(
    'OrgProviderCapThresholdReached',
    z.object({
      orgId: Id,
      provider: ProviderKeyIdSchema,
      month: Month,
      level: z.enum(['warning', 'paused']),
      spendMicros: z.number().int().nonnegative(),
      capMicros: z.number().int().positive(),
      /** Turns and shifts of the month whose cost is unknown (no price): they are not in the spend, and the cap cannot count them. */
      unknownCostTurns: z.number().int().nonnegative().default(0),
      deskItemId: Id.optional(),
    }),
  ),
  /** "Override for this month": runs on the organization's key go on although the cap is reached; the next month starts fresh. */
  defineEvent(
    'OrgProviderCapOverridden',
    z.object({ orgId: Id, provider: ProviderKeyIdSchema, month: Month, by: Id }),
  ),
  /**
   * The Owner set the price of a model that has none in the built-in tables (a local Ollama model, a new release): USD per million
   * tokens. Used from then on to price its turns, which are marked as owner-priced; it never changes a past turn's stamped cost.
   */
  defineEvent(
    'OrgModelPriceSet',
    z.object({
      orgId: Id,
      provider: DirectProviderIdSchema,
      model: z.string().min(1).max(120),
      inputPerMtok: z.number().min(0).max(100_000),
      outputPerMtok: z.number().min(0).max(100_000),
      cacheReadPerMtok: z.number().min(0).max(100_000).nullable().default(null),
      by: Id,
    }),
  ),
  defineEvent(
    'OrgModelPriceRemoved',
    z.object({ orgId: Id, provider: DirectProviderIdSchema, model: z.string().min(1).max(120), by: Id }),
  ),
] as const;

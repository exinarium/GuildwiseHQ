import { z } from 'zod';
import { ProviderKeyIdSchema } from '../models/direct.ts';

/**
 * Organization-wide provider keys (docs/ARCHITECTURE.md section 38.5). The Owner or an Admin seals a key in the browser to each
 * target workstation's public key and sends the ciphertexts; the server stores only those, per workstation, and relays them.
 */
export const OrgProviderShareStatusSchema = z.enum(['stored', 'queued', 'failed', 'not_shared', 'too_old']);
export type OrgProviderShareStatus = z.infer<typeof OrgProviderShareStatusSchema>;

export const OrgProviderWorkstationSchema = z.object({
  workstationId: z.uuid(),
  name: z.string(),
  ownerName: z.string(),
  online: z.boolean(),
  /** The runner knows organization keys (`provider-keys:2`). An older runner is told to update. */
  supported: z.boolean(),
  status: OrgProviderShareStatusSchema,
  error: z.string().optional(),
  /** The workstation's owner has a key of their own for this provider: it is in effect, and not subject to the cap. */
  overriddenByOwn: z.boolean(),
  /** The runner's key (for sealing a key to it); null until the runner announced one. */
  keyId: z.string().nullable(),
  publicKey: z.string().nullable(),
  /** This runner holds the organization's key and is online: it can re-seal it to another workstation. */
  canShare: z.boolean(),
});
export type OrgProviderWorkstation = z.infer<typeof OrgProviderWorkstationSchema>;

export const ProviderCapStateSchema = z.enum(['none', 'ok', 'warning', 'paused', 'overridden']);

export const OrgProviderCapSchema = z.object({
  /** The monthly cap in USD micros, or null (no cap). */
  monthlyMicros: z.number().int().nullable(),
  /** This calendar month's spend on the organization's key (shift, session and delegate costs), USD micros. */
  spendMicros: z.number().int(),
  /** Turns and shifts of the month on the organization's key whose cost is unknown (no price): not in the spend, not enforceable. */
  unknownCostTurns: z.number().int(),
  percent: z.number().nullable(),
  state: ProviderCapStateSchema,
  /** `YYYY-MM` in the organization's time zone. */
  month: z.string(),
  resetsAt: z.iso.datetime(),
});

export const OrgProviderSchema = z.object({
  provider: ProviderKeyIdSchema,
  label: z.string(),
  configured: z.boolean(),
  detail: z.string().nullable(),
  baseUrl: z.string().nullable(),
  models: z.array(z.string()),
  setAt: z.iso.datetime().nullable(),
  setByName: z.string().nullable(),
  cap: OrgProviderCapSchema,
  workstations: z.array(OrgProviderWorkstationSchema),
});
export type OrgProvider = z.infer<typeof OrgProviderSchema>;

export const OrgProvidersResponseSchema = z.object({ providers: z.array(OrgProviderSchema) });
export type OrgProvidersResponse = z.infer<typeof OrgProvidersResponseSchema>;

const Sealed = z.object({
  workstationId: z.uuid(),
  /** The runner key id the browser sealed for (the server checks it is still the runner's). */
  keyId: z.string().min(1).max(64),
  /** RSA-OAEP for a short key, `sealLarge` (`h1.`) for a credential. */
  ciphertext: z.string().min(1).max(20000),
});

/** `PUT /api/org/providers/:provider`: set or replace the key; `shares` is the full set of workstations that should hold it. */
export const SetOrgProviderKeyRequestSchema = z.object({
  /** Region, project or endpoint host for the page: not a secret and not trusted for anything else. */
  detail: z.string().max(200).optional(),
  baseUrl: z.string().max(300).optional(),
  models: z.array(z.string().min(1).max(120)).max(50).default([]),
  shares: z.array(Sealed).min(1).max(500),
});
export type SetOrgProviderKeyRequest = z.infer<typeof SetOrgProviderKeyRequestSchema>;

/** `PUT /api/org/providers/:provider/shares`: seal the key to one more workstation (the admin entered it again). */
export const ShareOrgProviderKeyRequestSchema = Sealed;
export type ShareOrgProviderKeyRequest = z.infer<typeof ShareOrgProviderKeyRequestSchema>;

/** `POST /api/org/providers/:provider/reshare`: a runner that holds the key re-seals it to another workstation. */
export const ReshareOrgProviderKeyRequestSchema = z.object({
  sourceWorkstationId: z.uuid(),
  targetWorkstationId: z.uuid(),
});
export type ReshareOrgProviderKeyRequest = z.infer<typeof ReshareOrgProviderKeyRequestSchema>;

/** `PUT /api/org/providers/:provider/cap`: the monthly cap in USD, or null to remove it. */
export const SetOrgProviderCapRequestSchema = z.object({
  monthlyUsd: z.number().min(0.01).max(10_000_000).nullable(),
});
export type SetOrgProviderCapRequest = z.infer<typeof SetOrgProviderCapRequestSchema>;

/** The error code of a run refused because the provider's cap on the organization's key is reached. */
export const PROVIDER_CAP_REACHED = 'provider_cap_reached';

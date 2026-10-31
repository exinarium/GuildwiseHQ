import { z } from 'zod';

/**
 * Inbound webhook relay (business mode). The server is only a messenger between an outside provider and the org's
 * runner: it forwards each request raw over the runner socket and stores nothing of its content. The name `relay`
 * is deliberate: `integration` is already taken (workstation sign-ins, test environments).
 */
export const RELAY_KINDS = ['whatsapp_cloud', 'form_webhook', 'webhook_in', 'calendar_push', 'generic'] as const;
export const RelayKindSchema = z.enum(RELAY_KINDS);
export type RelayKind = z.infer<typeof RelayKindSchema>;

export const RELAY_PATH_PREFIX = '/relay/in/';
export const RELAY_TOKEN_PREFIX = 'rly_';
/** Announced in `welcome.features` by servers that accept `relay.serve`. */
export const RELAY_FEATURE = 'relay:1';
export const RELAY_RESPONSE_MAX_BYTES = 64 * 1024;
/** Upper bound of the configurable body limit (a runner frame is capped at 8 MiB; base64 adds a third). */
export const RELAY_BODY_HARD_MAX_BYTES = 4 * 1024 * 1024;
export const RELAY_OUTCOMES = [
  'forwarded',
  'runner_offline',
  'timeout',
  'rejected_size',
  'rejected_rate',
  'unknown_path',
] as const;
export type RelayOutcome = (typeof RELAY_OUTCOMES)[number];
/** Response headers the runner may set; anything else is dropped. */
export const RELAY_RESPONSE_HEADERS = ['content-type', 'retry-after', 'cache-control'] as const;
/**
 * Request headers never forwarded: hop-by-hop, proxy internals and GuildWise's own session cookie. Also dropped: any
 * `x-aom-*` header and every name listed in the `Connection` header. `authorization` IS forwarded: a generic webhook
 * may carry its own bearer secret that the runner checks.
 */
export const RELAY_STRIPPED_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'cookie',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
] as const;

/** `.strict()`: a provider secret (app secret, verify token, access token) in the body is a 400, never stored. */
export const RelayIntegrationCreateSchema = z
  .object({ kind: RelayKindSchema, label: z.string().trim().min(1).max(80) })
  .strict();
export type RelayIntegrationCreate = z.infer<typeof RelayIntegrationCreateSchema>;

export const RelayIntegrationDtoSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  kind: RelayKindSchema,
  label: z.string(),
  status: z.enum(['active', 'revoked']),
  createdAt: z.iso.datetime(),
  rotatedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type RelayIntegrationDto = z.infer<typeof RelayIntegrationDtoSchema>;

/** The answer of create and rotate: the URL is shown once and never stored. */
export const RelayIntegrationWithUrlSchema = z.object({
  integration: RelayIntegrationDtoSchema,
  url: z.string(),
});
export type RelayIntegrationWithUrl = z.infer<typeof RelayIntegrationWithUrlSchema>;

export const RelayIntegrationStatusSchema = z.object({
  integrationId: z.uuid(),
  /** A serving runner is connected now. */
  connected: z.boolean(),
  servingWorkstations: z.number().int(),
  everServed: z.boolean(),
  /** Null while connected, or when no runner ever served it. */
  offlineSince: z.iso.datetime().nullable(),
  refusedSinceOffline: z.object({ count: z.number().int(), lastAt: z.iso.datetime().nullable() }),
});
export type RelayIntegrationStatus = z.infer<typeof RelayIntegrationStatusSchema>;

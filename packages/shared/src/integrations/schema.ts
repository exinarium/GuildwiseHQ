import { z } from 'zod';

/**
 * Integrations (docs/design/integrations-page.md): the one fact record a runner reports per (kind, instance), the
 * interactive sign-in session shapes, the sealed envelope and the command payloads. Nothing in these shapes can carry a
 * secret in the clear: the only secret-bearing field is the opaque, encrypted `envelope`.
 */

export const INTEGRATION_KIND_IDS = [
  'claude-code',
  'github',
  'gitlab',
  'bitbucket-cloud',
  'azure-devops',
  'ssh',
  'jira',
  'mcp',
] as const;
export const IntegrationKindIdSchema = z.enum(INTEGRATION_KIND_IDS);
export type IntegrationKindId = z.infer<typeof IntegrationKindIdSchema>;

/** The version of the integrations protocol a runner announces in `hello.integrationsVersion`. */
export const INTEGRATIONS_VERSION = 1;

export const INTEGRATION_STATES = [
  'connected',
  'not_connected',
  'refused',
  'expired',
  'needs_sign_in',
  'unreachable',
  'unavailable',
  'not_needed',
] as const;
export const IntegrationStateSchema = z.enum(INTEGRATION_STATES);
export type IntegrationState = z.infer<typeof IntegrationStateSchema>;

export const INTEGRATION_STATE_LABELS: Record<IntegrationState, string> = {
  connected: 'Connected',
  not_connected: 'Not connected',
  refused: 'Refused',
  expired: 'Expired',
  needs_sign_in: 'Needs sign-in',
  unreachable: 'Unreachable',
  unavailable: 'Tool missing',
  not_needed: 'Not needed',
};

/** Where a credential lives: this pairing's data dir, or the whole machine (`gh`, `~/.claude`, `~/.ssh`). */
export const IntegrationScopeSchema = z.enum(['workstation', 'machine']);
export type IntegrationScope = z.infer<typeof IntegrationScopeSchema>;

/** Instance names: '' (single), a host, an organization, a plugin MCP server name, `provider@host`. */
export const INTEGRATION_INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,198}$/;
export const IntegrationInstanceSchema = z.union([z.literal(''), z.string().regex(INTEGRATION_INSTANCE_RE)]);

/** The one fact record a runner reports per (kind, instance). Facts only: never a token, key or code. */
export const IntegrationStatusSchema = z.object({
  kind: IntegrationKindIdSchema,
  instance: z.string().max(200),
  state: IntegrationStateSchema,
  /** `token`, `cli`, `oauth_token`, `api_key`, `default_login`, `ssh`, ... */
  method: z.string().max(40).optional(),
  /** Login, display name or e-mail as the provider reports it. */
  account: z.string().max(200).optional(),
  scopes: z.array(z.string().max(80)).max(50).optional(),
  missingScopes: z.array(z.string().max(80)).max(50).optional(),
  expiresAt: z.iso.datetime().optional(),
  savedAt: z.iso.datetime().optional(),
  checkedAt: z.iso.datetime(),
  scope: IntegrationScopeSchema,
  /** One sentence: why it is not connected, or what to do next. */
  detail: z.string().max(400).optional(),
  /** SSH only: the PUBLIC half of the key. */
  publicKey: z.string().max(1000).optional(),
  /** Jira base URL, GitLab host, Azure organization. */
  site: z.string().max(300).optional(),
});
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

export const MAX_INTEGRATION_STATUSES = 100;

// ---------------------------------------------------------------------------------------------- sessions

export const INTEGRATION_SESSION_STATES = [
  'starting',
  'awaiting_user',
  'awaiting_code',
  'completing',
  'connected',
  'failed',
  'cancelled',
  'expired',
] as const;
export const IntegrationSessionStateSchema = z.enum(INTEGRATION_SESSION_STATES);
export type IntegrationSessionState = z.infer<typeof IntegrationSessionStateSchema>;

export const isTerminalSessionState = (s: IntegrationSessionState): boolean =>
  s === 'connected' || s === 'failed' || s === 'cancelled' || s === 'expired';

/** What the page shows during an interactive sign-in. Extracted fields only; raw CLI output never leaves the runner. */
export const IntegrationPromptSchema = z.object({
  url: z.string().max(2000).optional(),
  /** The host of `url`, shown prominently ("You are signing in to auth.atlassian.com"). */
  urlHost: z.string().max(200).optional(),
  /** A device code the user types at the provider (GitHub). */
  userCode: z.string().max(40).optional(),
  inputLabel: z.string().max(200).optional(),
  /** `code`: paste the code the page shows; `redirect_url`: paste the address you landed on; `none`: nothing to paste. */
  inputKind: z.enum(['code', 'redirect_url', 'none']).optional(),
});
export type IntegrationPrompt = z.infer<typeof IntegrationPromptSchema>;

/** Runner to server: progress of an interactive sign-in. */
export const IntegrationSessionMsgSchema = z.object({
  sessionId: z.string().min(1).max(64),
  kind: IntegrationKindIdSchema,
  instance: z.string().max(200),
  state: IntegrationSessionStateSchema,
  prompt: IntegrationPromptSchema.optional(),
  status: IntegrationStatusSchema.optional(),
  error: z.string().max(300).optional(),
});
export type IntegrationSessionMsg = z.infer<typeof IntegrationSessionMsgSchema>;

// ---------------------------------------------------------------------------------------------- the sealed envelope

export const INTEGRATION_ENVELOPE_ALG = 'RSA-OAEP-256+A256GCM';
export const MAX_ENVELOPE_FIELDS_BYTES = 8 * 1024;

/** Hybrid RSA-OAEP-256 + AES-256-GCM envelope. The server relays it and cannot read it. */
export const SealedEnvelopeSchema = z.object({
  v: z.literal(1),
  alg: z.literal(INTEGRATION_ENVELOPE_ALG),
  keyId: z.string().min(1).max(64),
  wrappedKey: z.string().min(1).max(1024),
  iv: z.string().min(1).max(64),
  ct: z.string().min(1).max(24_000),
});
export type SealedEnvelope = z.infer<typeof SealedEnvelopeSchema>;

export const INTEGRATION_OPS = ['connect', 'input'] as const;
export type IntegrationEnvelopeOp = (typeof INTEGRATION_OPS)[number];

/** What is inside the ciphertext. The runner checks every outer field against it. */
export const SealedPlaintextSchema = z.object({
  v: z.literal(1),
  ref: z.string().min(1).max(64),
  workstationId: z.string().min(1).max(64),
  kind: IntegrationKindIdSchema,
  instance: z.string().max(200),
  op: z.enum(INTEGRATION_OPS),
  method: z.string().max(40).optional(),
  /** Epoch milliseconds: the envelope is refused after this. */
  exp: z.number().int(),
  fields: z.record(z.string().max(100), z.string().max(8000)),
});
export type SealedPlaintext = z.infer<typeof SealedPlaintextSchema>;

/** The additional authenticated data: binds the ciphertext to one workstation, request, kind, instance and op. */
export function integrationAad(p: {
  workstationId: string;
  ref: string;
  kind: string;
  instance: string;
  op: string;
}): string {
  return `guildwise-integration-v1\n${p.workstationId}\n${p.ref}\n${p.kind}\n${p.instance}\n${p.op}`;
}

/** How long a sealed envelope is valid (browser side) and the most the runner accepts ahead of its own clock. */
export const ENVELOPE_TTL_MS = 10 * 60_000;
export const ENVELOPE_MAX_AHEAD_MS = 15 * 60_000;

// ---------------------------------------------------------------------------------------------- commands

export const IntegrationConnectPayloadSchema = z.object({
  requestId: z.string().min(1).max(64),
  kind: IntegrationKindIdSchema,
  instance: z.string().max(200),
  method: z.string().min(1).max(40),
  envelope: SealedEnvelopeSchema,
});
export type IntegrationConnectPayload = z.infer<typeof IntegrationConnectPayloadSchema>;

export const IntegrationBeginPayloadSchema = z.object({
  sessionId: z.string().min(1).max(64),
  kind: IntegrationKindIdSchema,
  instance: z.string().max(200),
  method: z.string().min(1).max(40),
  /** Non-secret fields that start the flow (a host, an organization). */
  pre: z.record(z.string().max(100), z.string().max(300)).optional(),
});
export type IntegrationBeginPayload = z.infer<typeof IntegrationBeginPayloadSchema>;

export const IntegrationInputPayloadSchema = z.object({
  sessionId: z.string().min(1).max(64),
  kind: IntegrationKindIdSchema,
  instance: z.string().max(200),
  envelope: SealedEnvelopeSchema,
});
export type IntegrationInputPayload = z.infer<typeof IntegrationInputPayloadSchema>;

export const IntegrationCancelPayloadSchema = z.object({ sessionId: z.string().min(1).max(64) });
export const IntegrationRequestPayloadSchema = z.object({
  requestId: z.string().min(1).max(64),
  kind: IntegrationKindIdSchema,
  instance: z.string().max(200),
});
export type IntegrationRequestPayload = z.infer<typeof IntegrationRequestPayloadSchema>;

/** The `command.result` of the integration commands: a status, an acceptance, or a reason. Never a secret. */
export const IntegrationCommandResultSchema = z.object({
  accepted: z.boolean().optional(),
  status: IntegrationStatusSchema.optional(),
  error: z.string().max(400).optional(),
  /** `allow_web_off`, `machine_scope`, `replayed`, `expired`, `key`, `busy`, `unsupported`, `failed`. */
  code: z.string().max(40).optional(),
});
export type IntegrationCommandResult = z.infer<typeof IntegrationCommandResultSchema>;

// ---------------------------------------------------------------------------------------------- runner report

/** Local policy the runner announces with its report (D8): shown on the page so a refusal is explained. */
export const IntegrationsPolicySchema = z.object({
  allowWeb: z.boolean(),
  /** This pairing is the machine's primary one: it may change machine-wide logins from the web. */
  primaryPairing: z.boolean(),
  machineScopeFromWeb: z.enum(['primary', 'never']),
});
export type IntegrationsPolicy = z.infer<typeof IntegrationsPolicySchema>;

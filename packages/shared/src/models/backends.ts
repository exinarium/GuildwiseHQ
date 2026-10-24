import { z } from 'zod';
import type { ModelTier } from './direct.ts';
import {
  baseUrlEndpointProblem,
  isForbiddenEndpointHost,
  orgCredentialEndpointProblem,
} from './private-endpoints.ts';

/**
 * Claude Code against another backend (docs/RUNNER.md, "Claude Code on Bedrock, Vertex AI or a gateway"): the same harness and
 * sandbox, with the model served by Amazon Bedrock, Google Vertex AI or an Anthropic-compatible gateway (LiteLLM, OpenRouter's
 * Anthropic endpoint, ...). The credential is sealed to the runner like a provider key and put into that agent's process
 * environment only. An agent's model names the backend: `bedrock:<model id>`, `vertex:<model id>`, `gateway:<model id>`.
 */
export const BACKEND_IDS = ['bedrock', 'vertex', 'gateway'] as const;
export const BackendIdSchema = z.enum(BACKEND_IDS);
export type BackendId = z.infer<typeof BackendIdSchema>;

export interface CredentialFieldDef {
  key: string;
  label: string;
  /** The value is a secret: never shown again, never reported, redacted from logs. */
  secret: boolean;
  optional?: boolean;
  multiline?: boolean;
  hint?: string;
  placeholder?: string;
}

export interface BackendModelDef {
  id: string;
  label: string;
  tier: ModelTier;
}

export interface BackendDef {
  id: BackendId;
  /** "Amazon Bedrock". */
  label: string;
  /** What the credential field group is called in settings. */
  credentialLabel: string;
  fields: readonly CredentialFieldDef[];
  /** Shown beside the backend: where the data goes. */
  dataNote: string;
  /** A caution shown wherever a model of this backend is picked. */
  warning?: string;
  /** Built-in model ids (the owner can add more). Empty: the owner types the model ids (a gateway serves what it is set up with). */
  models: readonly BackendModelDef[];
}

/** Shown wherever a model behind a gateway is picked (Anthropic does not support non-Claude models behind Claude Code). */
export const GATEWAY_WARNING =
  'Claude Code is built for Claude models. Other models behind a gateway may follow its tools and instructions less reliably, and Anthropic does not support that setup. Check the first results before you rely on it.';

export const BACKENDS: readonly BackendDef[] = [
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    credentialLabel: 'AWS credentials',
    fields: [
      {
        key: 'region',
        label: 'AWS region',
        secret: false,
        placeholder: 'us-east-1',
        hint: 'Where Bedrock runs your models',
      },
      {
        key: 'bearerToken',
        label: 'Bedrock API key',
        secret: true,
        optional: true,
        hint: 'Use this, or the access key below',
      },
      { key: 'accessKeyId', label: 'AWS access key id', secret: true, optional: true },
      { key: 'secretAccessKey', label: 'AWS secret access key', secret: true, optional: true },
      {
        key: 'sessionToken',
        label: 'AWS session token',
        secret: true,
        optional: true,
        hint: 'Only for temporary credentials',
      },
      {
        key: 'baseUrl',
        label: 'Bedrock endpoint URL',
        secret: false,
        optional: true,
        hint: 'Only for a VPC endpoint or a gateway that speaks the Bedrock API',
      },
    ],
    dataNote:
      "Requests go from this workstation straight to Amazon Bedrock in your AWS account with the credentials you enter. Guildwise never sees them or the traffic. Anthropic's usage limits of a Claude subscription do not apply; AWS bills the tokens.",
    models: [
      { id: 'us.anthropic.claude-opus-5-5', label: 'Claude Opus 5.5 (US profile)', tier: 'large' },
      { id: 'us.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (US profile)', tier: 'medium' },
      {
        id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        label: 'Claude Haiku 4.5 (US profile)',
        tier: 'small',
      },
    ],
  },
  {
    id: 'vertex',
    label: 'Google Vertex AI',
    credentialLabel: 'Google Cloud credentials',
    fields: [
      { key: 'projectId', label: 'Google Cloud project id', secret: false },
      {
        key: 'region',
        label: 'Region',
        secret: false,
        optional: true,
        placeholder: 'global',
        hint: 'global, a multi-region such as eu or us, or a region such as us-east5',
      },
      {
        key: 'serviceAccountJson',
        label: 'Service account key (JSON)',
        secret: true,
        multiline: true,
        hint: 'The JSON key file of a service account with the Vertex AI User role',
      },
      { key: 'baseUrl', label: 'Vertex endpoint URL', secret: false, optional: true },
    ],
    dataNote:
      'Requests go from this workstation straight to Google Vertex AI in your Google Cloud project with the service account you enter. Guildwise never sees the key or the traffic. Google Cloud bills the tokens.',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', tier: 'large' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tier: 'medium' },
      { id: 'claude-haiku-4-5@20251001', label: 'Claude Haiku 4.5', tier: 'small' },
    ],
  },
  {
    id: 'gateway',
    label: 'Anthropic-compatible gateway',
    credentialLabel: 'Gateway',
    fields: [
      {
        key: 'baseUrl',
        label: 'Gateway URL',
        secret: false,
        placeholder: 'https://litellm.example.com',
        hint: 'A gateway that speaks the Anthropic Messages API (LiteLLM, OpenRouter https://openrouter.ai/api, ...)',
      },
      {
        key: 'authToken',
        label: 'Gateway key',
        secret: true,
        optional: true,
        hint: 'Sent as "Authorization: Bearer <key>". Leave empty for a gateway that needs none',
      },
      {
        key: 'authStyle',
        label: 'Send the key as',
        secret: false,
        optional: true,
        hint: 'bearer (default) or x-api-key',
      },
    ],
    dataNote:
      'Requests go from this workstation to the gateway you enter. The gateway, and whichever provider it forwards to, are outside Guildwise and see your prompts and code.',
    warning: GATEWAY_WARNING,
    models: [],
  },
];

export const backendDef = (id: string): BackendDef | undefined => BACKENDS.find((b) => b.id === id);

/** The agent's model for a backend: `bedrock:us.anthropic...` (the model id may itself contain `:`, `/` or `@`). */
export const backendModelId = (backend: BackendId, model: string): string => `${backend}:${model}`;

export function splitBackendModel(id: string): { backend: BackendId; model: string } | null {
  const i = id.indexOf(':');
  if (i < 1) return null;
  const head = id.slice(0, i);
  const model = id.slice(i + 1);
  return model && (BACKEND_IDS as readonly string[]).includes(head)
    ? { backend: head as BackendId, model }
    : null;
}

/** The credential of a backend as the browser seals it and the runner opens it: a flat map of the fields above. */
export const BackendCredentialSchema = z.record(z.string().min(1).max(40), z.string().max(8000));
export type BackendCredential = z.infer<typeof BackendCredentialSchema>;

/** Where a backend credential came from and the workstation owner's private-endpoint allow-list (for the endpoint checks). */
export interface BackendEndpointOptions {
  /** The credential is an organization's: its URL must be https to a public address or a listed private endpoint. */
  orgSourced?: boolean;
  /** The workstation owner's private endpoints (`host:port`). Absent: only the checks that need no list (metadata, link-local). */
  endpoints?: readonly string[];
}

/**
 * Why a backend's endpoint URL (`baseUrl` of a gateway, Bedrock or Vertex) must not be used, or null. Metadata and link-local
 * addresses are refused for every credential; an organization's URL is also refused when it is plain http, on this machine or on a
 * private network, unless the workstation owner listed it (orgCredentialEndpointProblem); the workstation's own URL follows
 * baseUrlEndpointProblem when the allow-list is known.
 */
export function backendEndpointProblem(
  id: BackendId,
  fields: Record<string, string>,
  o: BackendEndpointOptions = {},
): string | null {
  const raw = (fields.baseUrl ?? '').trim();
  if (!raw || !backendDef(id)) return null;
  if (o.orgSourced) return orgCredentialEndpointProblem(raw, o.endpoints ?? []) ?? null;
  if (o.endpoints) return baseUrlEndpointProblem(raw, o.endpoints) ?? null;
  try {
    const h = new URL(raw).hostname;
    return isForbiddenEndpointHost(h)
      ? 'link-local and metadata addresses cannot be used as an endpoint'
      : null;
  } catch {
    return null; // the URL check reports it
  }
}

/** Why these field values cannot work, or null. Used by the page before sealing and by the runner before storing. */
export function validateBackendFields(
  id: BackendId,
  fields: Record<string, string>,
  endpointOpts: BackendEndpointOptions = {},
): string | null {
  const def = backendDef(id);
  if (!def) return 'unknown backend';
  const v = (k: string) => (fields[k] ?? '').trim();
  for (const f of def.fields) if (!f.optional && !v(f.key)) return `${f.label} is required`;
  const url = (k: string, label: string): string | null => {
    if (!v(k)) return null;
    try {
      const u = new URL(v(k));
      if (u.protocol !== 'http:' && u.protocol !== 'https:')
        return `${label} must start with http:// or https://`;
      if (u.username || u.password) return `${label} must not contain a user name or password`;
      if (u.search || u.hash) return `${label} must not have a query or a fragment`;
    } catch {
      return `${label} is not a valid URL`;
    }
    const where = backendEndpointProblem(id, fields, endpointOpts);
    return where ? `${label}: ${where}` : null;
  };
  if (id === 'bedrock') {
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(v('region')))
      return 'the AWS region looks wrong (for example us-east-1)';
    const hasKeys = !!v('accessKeyId') && !!v('secretAccessKey');
    const someKey = !!v('accessKeyId') || !!v('secretAccessKey');
    if (v('bearerToken') && someKey) return 'enter either a Bedrock API key or an AWS access key, not both';
    if (someKey && !hasKeys) return 'an AWS access key needs both the key id and the secret';
    if (!v('bearerToken') && !hasKeys)
      return 'enter a Bedrock API key, or an AWS access key id and secret access key';
    return url('baseUrl', 'the Bedrock endpoint URL');
  }
  if (id === 'vertex') {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(v('projectId'))) return 'the project id looks wrong';
    if (v('region') && !/^[a-z0-9-]{2,40}$/.test(v('region'))) return 'the region looks wrong';
    try {
      const j = JSON.parse(v('serviceAccountJson')) as { type?: unknown; private_key?: unknown };
      if (j.type !== 'service_account' || typeof j.private_key !== 'string')
        return 'this is not a service account key file';
    } catch {
      return 'the service account key must be the JSON file as is';
    }
    return url('baseUrl', 'the Vertex endpoint URL');
  }
  const bad = url('baseUrl', 'the gateway URL');
  if (bad) return bad;
  if (v('authStyle') && !['bearer', 'x-api-key'].includes(v('authStyle')))
    return 'send the key as "bearer" or "x-api-key"';
  return null;
}

/** What the server may know of a stored backend credential: names, never a secret. */
export function backendDetail(id: BackendId, fields: Record<string, string>): string {
  if (id === 'bedrock') return fields.region ?? '';
  if (id === 'vertex') return [fields.projectId, fields.region || 'global'].filter(Boolean).join(' / ');
  try {
    return new URL(fields.baseUrl ?? '').host;
  } catch {
    return '';
  }
}

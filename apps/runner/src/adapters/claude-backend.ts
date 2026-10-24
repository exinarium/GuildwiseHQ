import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BackendId, splitBackendModel, type Usage } from '@aom/shared';
import type { BackendConfig } from '../direct/store.ts';

/**
 * Claude Code against Amazon Bedrock, Google Vertex AI or an Anthropic-compatible gateway (docs/RUNNER.md, "Claude Code on
 * Bedrock, Vertex AI or a gateway"). The harness, the sandbox and the permission settings are the ones of every Claude Code shift;
 * only the environment of the claude process changes. Variable names are from code.claude.com/docs (amazon-bedrock,
 * google-vertex-ai, llm-gateway, env-vars), checked on 2026-10-24.
 */

/** The agent's model as the backend and the plain model id it names, or null for a subscription model (`sonnet`). */
export const backendOfModel = (model: string): { backend: BackendId; model: string } | null =>
  splitBackendModel(model);

/** Roles that never take a backend credential: the CEO and the DevOps engineer run on the owner's own Claude login. */
export function backendRoleProblem(agent: { roleKey: string; isDevops?: boolean }): string | null {
  if (agent.isDevops || agent.roleKey === 'devops' || agent.roleKey === 'ceo')
    return `the ${agent.roleKey} role works with the owner's own Claude login and full workstation access, which a backend credential cannot give: use a Claude model`;
  return null;
}

const FIELD = (c: BackendConfig, k: string): string => (c.fields[k] ?? '').trim();

/**
 * The variables that point Claude Code at the backend, as the claude process sees them (the agent's shell does not: Claude Code
 * strips credentials from it with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, and the sandbox hides the runner's secret folder). Every model alias is pinned to the agent's model: a background call or a subagent that
 * asked for `haiku` or `sonnet` must reach a model this credential can use.
 */
export function backendProcessEnv(
  cred: BackendConfig,
  model: string,
  files: { vertexKeyFile?: string } = {},
): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    // A backend session talks to the backend only: no telemetry, update checks or survey calls to Anthropic.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    // The credential is for the model calls: Claude Code strips it (by variable name and value) from the Bash commands, hooks and
    // MCP servers it starts. Always on for a backend, whatever `scrubSubprocessEnv` says.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  };
  if (cred.id === 'bedrock') {
    env.CLAUDE_CODE_USE_BEDROCK = '1';
    env.AWS_REGION = FIELD(cred, 'region');
    if (FIELD(cred, 'bearerToken')) env.AWS_BEARER_TOKEN_BEDROCK = FIELD(cred, 'bearerToken');
    else {
      env.AWS_ACCESS_KEY_ID = FIELD(cred, 'accessKeyId');
      env.AWS_SECRET_ACCESS_KEY = FIELD(cred, 'secretAccessKey');
      if (FIELD(cred, 'sessionToken')) env.AWS_SESSION_TOKEN = FIELD(cred, 'sessionToken');
    }
    // The credentials are given: do not let the SDK probe the instance metadata service for others.
    env.AWS_EC2_METADATA_DISABLED = 'true';
    if (FIELD(cred, 'baseUrl')) env.ANTHROPIC_BEDROCK_BASE_URL = FIELD(cred, 'baseUrl');
  } else if (cred.id === 'vertex') {
    env.CLAUDE_CODE_USE_VERTEX = '1';
    env.CLOUD_ML_REGION = FIELD(cred, 'region') || 'global';
    env.ANTHROPIC_VERTEX_PROJECT_ID = FIELD(cred, 'projectId');
    if (files.vertexKeyFile) env.GOOGLE_APPLICATION_CREDENTIALS = files.vertexKeyFile;
    if (FIELD(cred, 'baseUrl')) env.ANTHROPIC_VERTEX_BASE_URL = FIELD(cred, 'baseUrl');
  } else {
    env.ANTHROPIC_BASE_URL = FIELD(cred, 'baseUrl').replace(/\/+$/, '');
    const token = FIELD(cred, 'authToken');
    if (token) {
      if (FIELD(cred, 'authStyle') === 'x-api-key') env.ANTHROPIC_API_KEY = token;
      else env.ANTHROPIC_AUTH_TOKEN = token;
    }
    // A gateway in front of a non-Anthropic model rejects pre-release `anthropic-beta` headers and the fields that pair with them.
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  }
  return env;
}

/**
 * The Vertex service account key, written for the claude process only: `<secrets dir>/vertex-<session>-<random>.json` (mode 0600,
 * created exclusively: an existing file is never reused). The secrets folder is hidden from every agent's shell. The caller removes
 * it when the session ends (`removeVertexKey`) or fails to start; `sweepVertexKeys` removes what a crash left behind.
 */
export function writeVertexKey(secretsDir: string, session: string, json: string): string {
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const file = join(
    secretsDir,
    `vertex-${session.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-${randomBytes(8).toString('hex')}.json`,
  );
  writeFileSync(file, json, { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(file, 0o600);
  } catch {
    // not supported everywhere
  }
  return file;
}

export const removeVertexKey = (file: string | undefined): void => {
  if (file) rmSync(file, { force: true });
};

/**
 * Removes every `vertex-*.json` in the secrets folder. Called when the runner starts: no claude process survives the runner (they
 * are killed with it), so a key file found then belongs to a session that ended abnormally.
 */
export function sweepVertexKeys(secretsDir: string): number {
  let n = 0;
  try {
    for (const f of readdirSync(secretsDir))
      if (/^vertex-.*\.json$/.test(f)) {
        rmSync(join(secretsDir, f), { force: true });
        n++;
      }
  } catch {
    // no secrets folder yet
  }
  return n;
}

/**
 * Usage of a backend session: which key paid (the server counts the organization's against its cap) and a model name the cost
 * tables can judge. Claude Code prices its own tokens with Anthropic's list; for a model behind a gateway that figure is made
 * up, so `costUsd` is dropped there and `gateway:<model>` lets the server flag a non-Claude model "cost unknown".
 */
export function stampBackendUsage(
  u: Usage,
  b: { backend: BackendId; model: string; source: 'org' | 'workstation' },
): Usage {
  const out: Usage = { ...u, keySource: b.source, keyProvider: b.backend };
  if (b.backend === 'gateway') {
    out.model = `gateway:${u.model ?? b.model}`;
    delete out.costUsd;
  } else if (!out.model) {
    out.model = b.model;
  }
  return out;
}

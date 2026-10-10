import { hostname, platform } from 'node:os';
import { RunnerEnrollRequestSchema, RunnerPairRequestSchema, RunnerPairResponseSchema } from '@aom/shared';
import { loadConfig, saveConfig } from './config.ts';
import { addPairing, entryConfigPath, loadIndex, normalizeServerUrl } from './pairings.ts';
import { resolveDataDir } from './paths.ts';
import { RUNNER_VERSION } from './version.ts';

/**
 * `aom-runner up`: pair if needed, then start. Idempotent, for machines nobody sits at (a VPS after the installer, a
 * Codespace's postStartCommand, a boot script). Settings come from flags or from the environment:
 *
 *   GUILDWISE_SERVER      the server URL
 *   GUILDWISE_PAIR_CODE   a pairing code from the Workstations page (used only when this machine is not paired yet)
 *   GUILDWISE_NAME        the workstation name (default: the host name)
 *   CODESPACE_NAME + GITHUB_TOKEN   set inside every Codespace: enrolls a codespace the server created (no code needed)
 *   ANTHROPIC_API_KEY     the customer's API key, written to this machine's config (mode 0600) and used by agents
 *   CLAUDE_CODE_OAUTH_TOKEN   a subscription token from `claude setup-token` (individual use only)
 *
 * The server never receives the Claude credentials.
 */
export interface UpOptions {
  server?: string;
  code?: string;
  name?: string;
  dataDir?: string;
  mock?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface UpResult {
  /** `already` the machine was paired for this server; `code`/`enroll` it paired now. */
  paired: 'already' | 'code' | 'enroll';
  workstationId: string;
  authApplied: 'api_key' | 'oauth' | null;
}

export async function preparePairing(opts: UpOptions): Promise<UpResult> {
  const env = opts.env ?? process.env;
  const server = normalizeServerUrl(opts.server ?? env.GUILDWISE_SERVER ?? '');
  const root = resolveDataDir(opts.dataDir);
  const f = opts.fetchImpl ?? fetch;
  const name = (opts.name ?? env.GUILDWISE_NAME ?? '').trim() || hostname();
  const code = (opts.code ?? env.GUILDWISE_PAIR_CODE ?? '').trim();

  let index = loadIndex(root);
  // Already paired with this server (any name): nothing to do, and the (single-use) code is ignored.
  let entry = server
    ? index.pairings.find((p) => p.serverUrl === server && !p.disabled)
    : index.pairings.find((p) => !p.disabled);
  let how: UpResult['paired'] = 'already';

  if (!entry) {
    if (!server)
      throw new Error(
        'Not paired yet: give the server with --server or GUILDWISE_SERVER (and a pairing code).',
      );
    let paired: { workstationId: string; runnerToken: string };
    if (code) {
      const body = RunnerPairRequestSchema.parse({
        code,
        name,
        platform: platform(),
        hostname: hostname(),
        runnerVersion: RUNNER_VERSION,
      });
      paired = await post(f, `${server}/api/runner/pair`, body);
      how = 'code';
    } else if (env.CODESPACE_NAME && env.GITHUB_TOKEN) {
      const body = RunnerEnrollRequestSchema.parse({
        codespaceName: env.CODESPACE_NAME,
        githubToken: env.GITHUB_TOKEN,
        name,
        platform: platform(),
        hostname: hostname(),
        runnerVersion: RUNNER_VERSION,
      });
      paired = await post(f, `${server}/api/runner/enroll`, body);
      how = 'enroll';
    } else {
      throw new Error(
        'Not paired yet and no pairing code: set GUILDWISE_PAIR_CODE (a code from the Workstations page) or run inside a Codespace the server created.',
      );
    }
    addPairing(root, {
      serverUrl: server,
      label: name,
      workstationId: paired.workstationId,
      runnerToken: paired.runnerToken,
      mock: opts.mock === true || env.AOM_RUNNER_MOCK === '1',
    });
    index = loadIndex(root);
    entry = index.pairings.find((p) => p.serverUrl === server && p.workstationId === paired.workstationId);
  }
  if (!entry) throw new Error('pairing was written but could not be found again');

  // The customer's own Claude credential, kept only in this machine's config.
  const file = entryConfigPath(root, entry);
  const config = loadConfig(file);
  const cc = config.runtimes['claude-code'];
  let authApplied: UpResult['authApplied'] = null;
  if (env.ANTHROPIC_API_KEY && !(cc.authMode === 'api_key' && cc.apiKey === env.ANTHROPIC_API_KEY)) {
    config.runtimes['claude-code'] = { ...cc, authMode: 'api_key', apiKey: env.ANTHROPIC_API_KEY };
    saveConfig(file, config);
    authApplied = 'api_key';
  } else if (
    !env.ANTHROPIC_API_KEY &&
    env.CLAUDE_CODE_OAUTH_TOKEN &&
    !(cc.authMode === 'oauth' && cc.oauthToken === env.CLAUDE_CODE_OAUTH_TOKEN)
  ) {
    config.runtimes['claude-code'] = { ...cc, authMode: 'oauth', oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN };
    saveConfig(file, config);
    authApplied = 'oauth';
  }
  return { paired: how, workstationId: entry.workstationId, authApplied };
}

async function post(
  f: typeof fetch,
  url: string,
  body: unknown,
): Promise<{ workstationId: string; runnerToken: string }> {
  const res = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`pairing failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  return RunnerPairResponseSchema.parse(await res.json());
}

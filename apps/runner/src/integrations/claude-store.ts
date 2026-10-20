import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { RunnerConfig } from '../config.ts';
import { registerSecret } from '../secrets/redact.ts';

/**
 * The Claude credential of this workstation (D9): `secrets/claude.json`, mode 0600. It is written by the Integrations
 * page (setup-token, API key, token made elsewhere) and by `aom-runner auth api-key|oauth-token`, and read by the Claude
 * adapter at every session start, so changing it needs no restart. The `claude-code` block of config.json is the older
 * place and is the fallback when this file has no credential.
 */
export const claudeFile = (secretsDir: string): string => join(secretsDir, 'claude.json');

/** The credential of an additional token account (`secrets/claude-accounts/<key>.json`, same format as `claude.json`). */
export const claudeAccountFile = (secretsDir: string, key: string): string =>
  join(secretsDir, 'claude-accounts', `${key}.json`);

export const ClaudeCredentialSchema = z.object({
  authMode: z.enum(['oauth', 'api_key']),
  oauthToken: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  savedAt: z.iso.datetime(),
  /** How it got here: `web` (Integrations page) or `cli`. */
  via: z.enum(['web', 'cli']).default('cli'),
  /** `setup_token`, `oauth_token` or `api_key`. */
  method: z.string().max(40).optional(),
});
export type ClaudeCredential = z.infer<typeof ClaudeCredentialSchema>;

/** The year a `claude setup-token` token lasts. */
export const SETUP_TOKEN_DAYS = 365;

export class ClaudeCredentialStore {
  constructor(private readonly file: string) {}

  load(): ClaudeCredential | undefined {
    try {
      if (!existsSync(this.file)) return undefined;
      const parsed = ClaudeCredentialSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (!parsed.success) return undefined;
      const c = parsed.data;
      if (c.authMode === 'oauth' ? !c.oauthToken : !c.apiKey) return undefined;
      return c;
    } catch {
      return undefined;
    }
  }

  save(c: Omit<ClaudeCredential, 'savedAt'> & { savedAt?: string }): ClaudeCredential {
    const full = ClaudeCredentialSchema.parse({ ...c, savedAt: c.savedAt ?? new Date().toISOString() });
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
      chmodSync(dirname(this.file), 0o700);
    } catch {
      // Windows
    }
    const secret = full.oauthToken ?? full.apiKey;
    if (secret) registerSecret(secret);
    return full;
  }

  remove(): boolean {
    if (!existsSync(this.file)) return false;
    rmSync(this.file, { force: true });
    return true;
  }
}

/** The credential in force: the secrets file first, else config.json's `claude-code` block. */
export function resolveClaudeCredential(
  store: ClaudeCredentialStore,
  config: RunnerConfig['runtimes']['claude-code'],
): {
  authMode: 'oauth' | 'api_key' | 'default';
  oauthToken?: string;
  apiKey?: string;
  from: 'secrets' | 'config' | 'none';
} {
  const c = store.load();
  if (c)
    return {
      authMode: c.authMode,
      ...(c.oauthToken ? { oauthToken: c.oauthToken } : {}),
      ...(c.apiKey ? { apiKey: c.apiKey } : {}),
      from: 'secrets',
    };
  if (config.authMode === 'oauth' && config.oauthToken)
    return { authMode: 'oauth', oauthToken: config.oauthToken, from: 'config' };
  if (config.authMode === 'api_key' && config.apiKey)
    return { authMode: 'api_key', apiKey: config.apiKey, from: 'config' };
  return { authMode: 'default', from: 'none' };
}

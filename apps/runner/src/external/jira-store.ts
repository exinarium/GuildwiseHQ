import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type JiraConfig, JiraConfigSchema } from '../config.ts';

/**
 * Jira credentials of this workstation (docs/RUNNER.md "Jira on the runner"). `aom-runner jira-connect` writes them to
 * `<data dir>/secrets/jira.json`, mode 0600 in a 0700 directory, like the git tokens: never into config.json, and never
 * anywhere an agent can read (`secrets/` is private to the runner). The older form, a `jira` block in config.json, is
 * still read when no secrets file exists.
 */
export const jiraFile = (secretsDir: string): string => join(secretsDir, 'jira.json');

export class JiraCredentialStore {
  constructor(private readonly file: string) {}

  load(): JiraConfig | undefined {
    try {
      if (!existsSync(this.file)) return undefined;
      const parsed = JiraConfigSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  save(cfg: JiraConfig): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // not supported on every platform
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // not supported on every platform
    }
    renameSync(tmp, this.file);
  }

  remove(): boolean {
    if (!existsSync(this.file)) return false;
    rmSync(this.file, { force: true });
    return true;
  }
}

/** The credentials in force: the secrets file first, else the `jira` block of config.json (older form). */
export function resolveJira(secretsDir: string, fromConfig: JiraConfig | undefined): JiraConfig | undefined {
  return new JiraCredentialStore(jiraFile(secretsDir)).load() ?? fromConfig;
}

export type JiraProvider = JiraConfig | (() => JiraConfig | undefined) | undefined;
export const jiraOf = (p: JiraProvider): JiraConfig | undefined => (typeof p === 'function' ? p() : p);

/** `https://acme.atlassian.net/` -> `https://acme.atlassian.net`; null when it is not an http(s) URL. */
export function normalizeJiraBaseUrl(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  try {
    const u = new URL(text);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

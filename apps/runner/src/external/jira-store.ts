import { join } from 'node:path';
import { type JiraConfig, JiraConfigSchema } from '../config.ts';
import { SealedFile, type SealedRead, unreadableMessage } from '../secrets/sealed-file.ts';

/**
 * Jira credentials of this workstation (docs/RUNNER.md "Jira on the runner"). `aom-runner jira-connect` writes them to
 * `<data dir>/secrets/jira.json`, encrypted with this runner's key (mode 0600 in a 0700 directory), like the git
 * tokens: never into config.json, and never anywhere an agent can read (`secrets/` is private to the runner). A
 * plaintext file from an older runner is sealed in place on first read. The older form, a `jira` block in config.json,
 * is still read when no secrets file exists.
 */
export const jiraFile = (secretsDir: string): string => join(secretsDir, 'jira.json');

export const JIRA_UNREADABLE = unreadableMessage(
  'Jira credentials',
  'Connect Jira again (Integrations page or `guildwise-runner jira-connect`).',
);

const legacyJira = (raw: unknown): JiraConfig | undefined => {
  const p = JiraConfigSchema.safeParse(raw);
  return p.success ? p.data : undefined;
};

export class JiraCredentialStore {
  private readonly sealed: SealedFile<JiraConfig>;

  constructor(file: string, keyOf: (fileName: string) => Buffer) {
    // only the API token is a secret to redact: the e-mail is sealed on disk but stays readable in logs (git authorship)
    this.sealed = new SealedFile(file, keyOf, JiraConfigSchema, (c) => [c.apiToken]);
  }

  read(): SealedRead<JiraConfig> {
    return this.sealed.open({ legacy: legacyJira });
  }

  load(): JiraConfig | undefined {
    const r = this.read();
    return r.state === 'ok' ? r.value : undefined;
  }

  /** Why the saved credentials are not available (the file cannot be read), if so. Never holds a secret. */
  problem(): string | undefined {
    return this.read().state === 'unreadable' ? JIRA_UNREADABLE : undefined;
  }

  save(cfg: JiraConfig): void {
    // never overwrite a file that cannot be read: move it aside, still encrypted
    if (this.read().state === 'unreadable') this.sealed.quarantine();
    this.sealed.save(cfg);
  }

  remove(): boolean {
    return this.sealed.remove();
  }
}

/**
 * The credentials in force: the secrets file first, else the `jira` block of config.json (older form). The config.json
 * block is used only when there is no secrets file, never when that file cannot be read: a runner key that changed must
 * not quietly switch to older credentials.
 */
export function resolveJira(
  secretsDir: string,
  fromConfig: JiraConfig | undefined,
  keyOf: (fileName: string) => Buffer,
): JiraConfig | undefined {
  const r = new JiraCredentialStore(jiraFile(secretsDir), keyOf).read();
  if (r.state === 'ok') return r.value;
  if (r.state === 'unreadable') return undefined;
  return fromConfig;
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

import { type ExternalAdapter, type ExternalRef, type ExternalSource, parseExternalRef } from '@aom/shared';
import { type Exec, GithubAdapter, PostError, SourceReadError } from './github.ts';
import { JiraAdapter } from './jira.ts';
import type { JiraProvider } from './jira-store.ts';

export type { Exec };
export { GithubAdapter, JiraAdapter, PostError, SourceReadError };

/** The adapters of this workstation, by system. */
export class ExternalAdapters {
  private readonly byName = new Map<string, ExternalAdapter>();

  constructor(adapters: ExternalAdapter[] = []) {
    for (const a of adapters) this.byName.set(a.system, a);
  }

  static defaults(
    opts: {
      ghBin?: string;
      exec?: Exec;
      jira?: JiraProvider;
      jiraFetch?: (url: string, init: RequestInit) => Promise<Response>;
    } = {},
  ): ExternalAdapters {
    return new ExternalAdapters([
      new GithubAdapter({
        ...(opts.ghBin ? { bin: opts.ghBin } : {}),
        ...(opts.exec ? { exec: opts.exec } : {}),
      }),
      new JiraAdapter({ config: opts.jira, ...(opts.jiraFetch ? { fetch: opts.jiraFetch } : {}) }),
    ]);
  }

  /** The Jira adapter (attachments, status); undefined only in tests that inject their own adapters. */
  get jira(): JiraAdapter | undefined {
    const a = this.byName.get('jira');
    return a instanceof JiraAdapter ? a : undefined;
  }

  get(system: string): ExternalAdapter | undefined {
    return this.byName.get(system);
  }

  async readSource(ref: ExternalRef): Promise<ExternalSource> {
    const a = this.byName.get(ref.system);
    if (!a) throw new SourceReadError(`no adapter for ${ref.system}`);
    return a.readSource(ref);
  }

  /** `aom source read --ref ...`: the ref text may be a key, `owner/repo#n` or a URL. */
  async readText(text: string): Promise<ExternalSource> {
    const ref = parseExternalRef(text);
    if (!ref)
      throw new SourceReadError(
        `'${text}' does not look like a Jira key (ABC-123), a GitHub issue (owner/repo#12) or a ticket URL`,
      );
    return this.readSource(ref);
  }
}

/** The ticket as plain text for the agent's terminal. */
export function formatSource(s: ExternalSource): string {
  const lines = [
    `${s.ref.key}: ${s.title}`,
    ...(s.status ? [`Status: ${s.status}`] : []),
    ...(s.labels.length ? [`Labels: ${s.labels.join(', ')}`] : []),
    ...(s.url ? [`URL: ${s.url}`] : []),
    '',
    s.body.trim() || '(no description)',
  ];
  if (s.comments.length) {
    lines.push('', 'Comments:');
    for (const c of s.comments)
      lines.push(
        `- ${c.author ?? 'someone'}${c.at ? ` (${c.at})` : ''}: ${c.body.trim().replace(/\n/g, '\n  ')}`,
      );
  }
  return lines.join('\n');
}

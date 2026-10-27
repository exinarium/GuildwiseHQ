import { existsSync, readFileSync } from 'node:fs';
import {
  type IntegrationRunPayload,
  type IntegrationRunResult,
  type PolledIssue,
  PolledIssueSchema,
} from '@aom/shared';
import { z } from 'zod';
import { defaultExec, type Exec } from '../external/github.ts';
import { type JiraProvider, jiraOf } from '../external/jira-store.ts';

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const MockFixtureSchema = z.object({
  github: z.array(PolledIssueSchema).default([]),
  jira: z.array(PolledIssueSchema).default([]),
});

/**
 * Polls GitHub (with this machine's `gh` login) or Jira (the REST token in the runner config) for open issues
 * (docs/ARCHITECTURE.md section 10.4). Credentials never leave the workstation; the server only receives the issues.
 * In the mock runtime a fixture file (`mock-issues.json` in the data dir) stands in for both systems, so no test ever
 * reaches GitHub or Jira.
 */
export class IntegrationPoller {
  constructor(
    private readonly opts: {
      ghBin?: string;
      exec?: Exec;
      jira?: JiraProvider;
      fetch?: FetchFn;
      /** Mock runtime: read the issues from this file when it exists. */
      mockFile?: string | undefined;
    } = {},
  ) {}

  async run(p: IntegrationRunPayload): Promise<IntegrationRunResult> {
    try {
      const mocked = this.fromFixture(p);
      if (mocked) return { ok: true, issues: mocked.slice(0, p.limit) };
      const issues = p.integration === 'github' ? await this.github(p) : await this.jira(p);
      return { ok: true, issues: issues.slice(0, p.limit) };
    } catch (err) {
      return {
        ok: false,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 1500),
        issues: [],
      };
    }
  }

  private fromFixture(p: IntegrationRunPayload): PolledIssue[] | null {
    const f = this.opts.mockFile;
    if (!f || !existsSync(f)) return null;
    const fixture = MockFixtureSchema.parse(JSON.parse(readFileSync(f, 'utf8')));
    const list = fixture[p.integration];
    return p.label ? list.filter((i) => i.labels.includes(p.label as string)) : list;
  }

  private async github(p: IntegrationRunPayload): Promise<PolledIssue[]> {
    const exec = this.opts.exec ?? defaultExec;
    const args = [
      'issue',
      'list',
      '--repo',
      p.query.trim(),
      '--state',
      'open',
      '--limit',
      String(p.limit),
      '--json',
      'number,title,body,url,labels',
      ...(p.label ? ['--label', p.label] : []),
    ];
    let r: Awaited<ReturnType<Exec>>;
    try {
      r = await exec(this.opts.ghBin ?? 'gh', args);
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT')
        throw new Error('the GitHub CLI (`gh`) is not installed on this workstation');
      throw err;
    }
    if (r.exitCode !== 0)
      throw new Error(
        `gh issue list failed: ${(r.stderr || r.stdout).trim().slice(0, 500) || `exit ${r.exitCode}`}`,
      );
    const list = JSON.parse(r.stdout) as Array<{
      number: number;
      title?: string;
      body?: string;
      url?: string;
      labels?: Array<{ name?: string }>;
    }>;
    return list.map((i) => ({
      key: `${p.query.trim()}#${i.number}`,
      title: (i.title ?? '').slice(0, 500),
      ...(i.url ? { url: i.url } : {}),
      body: (i.body ?? '').slice(0, 20000),
      labels: (i.labels ?? []).flatMap((l) => (l.name ? [l.name] : [])),
    }));
  }

  private async jira(p: IntegrationRunPayload): Promise<PolledIssue[]> {
    const cfg = jiraOf(this.opts.jira);
    if (!cfg) throw new Error('no Jira credentials on this workstation: run `guildwise-runner jira-connect`');
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const auth = cfg.email
      ? `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')}`
      : `Bearer ${cfg.apiToken}`;
    const label = p.label ? ` AND labels = "${p.label.replace(/"/g, '')}"` : '';
    const jql = `(${p.query.trim()})${label} ORDER BY created DESC`;
    const url = `${base}/rest/api/2/search?${new URLSearchParams({ jql, maxResults: String(p.limit), fields: 'summary,description,labels' })}`;
    const send = this.opts.fetch ?? ((u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(30_000) }));
    const res = await send(url, {
      method: 'GET',
      headers: { authorization: auth, accept: 'application/json' },
    });
    if (res.status < 200 || res.status >= 300) {
      const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
      throw new Error(`Jira answered ${res.status}${text ? `: ${text}` : ''}`);
    }
    const out = (await res.json()) as {
      issues?: Array<{
        key: string;
        fields?: { summary?: string; description?: unknown; labels?: string[] };
      }>;
    };
    return (out.issues ?? []).map((i) => ({
      key: i.key,
      title: (i.fields?.summary ?? '').slice(0, 500),
      url: `${base}/browse/${encodeURIComponent(i.key)}`,
      body: typeof i.fields?.description === 'string' ? i.fields.description.slice(0, 20000) : '',
      labels: i.fields?.labels ?? [],
    }));
  }
}

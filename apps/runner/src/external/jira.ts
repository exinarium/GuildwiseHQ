import {
  type ApprovedDraft,
  type ExternalAdapter,
  type ExternalRef,
  type ExternalSource,
  ExternalSourceSchema,
  type JiraStatus,
  type PostResult,
} from '@aom/shared';
import { PostError, SourceReadError } from './github.ts';
import { type JiraProvider, jiraOf } from './jira-store.ts';

/**
 * `readSource` reads a ticket (fields, description, comments) through Jira's REST API with the runner's own saved
 * connection (`aom-runner jira-connect`), the same credentials as the attachments; a runtime that can read Jira on the
 * runner's behalf may still plug in as `reader`.
 *
 * Posting an approved update (M8) is different: it is a fixed, mechanical call, so it does not need an agent session.
 * The runner posts the approved text exactly as it stands through Jira's REST API (`POST /rest/api/2/issue/{key}/comment`,
 * plain-text body) with the API token in this workstation's runner config (`jira`: baseUrl, email, apiToken), mode 0600.
 * The token is the card owner's own and never leaves this machine. Without it the post fails with a message that says
 * so, and the failure lands on the manager's desk. A resolution is posted as a comment: the ticket's transitions are
 * workflow-specific, so the manager closes it in Jira.
 */
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class JiraAdapter implements ExternalAdapter {
  readonly system = 'jira' as const;

  constructor(
    private readonly opts: {
      reader?: (ref: ExternalRef) => Promise<ExternalSource>;
      /** The credentials, or a function that reads them fresh (`aom-runner jira-connect` needs no restart). */
      config?: JiraProvider;
      /** A seam so tests never reach Jira (undici MockAgent). */
      fetch?: FetchFn;
    } = {},
  ) {}

  readSource(ref: ExternalRef): Promise<ExternalSource> {
    if (this.opts.reader) return this.opts.reader(ref);
    return this.readIssue(ref);
  }

  private async readIssue(ref: ExternalRef): Promise<ExternalSource> {
    const c = this.creds();
    if (!c)
      throw new SourceReadError(
        'Jira is not connected on this workstation: ask the manager to run `aom-runner jira-connect`',
      );
    const key = ref.key;
    const res = await this.send(
      `${c.base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${JIRA_READ_FIELDS}`,
      { method: 'GET', headers: { authorization: c.auth, accept: 'application/json' } },
    );
    if (res.status === 401 || res.status === 403)
      throw new SourceReadError(
        `Jira refused the saved credentials (HTTP ${res.status}): the manager must run \`aom-runner jira-connect\` again`,
      );
    if (res.status === 404)
      throw new SourceReadError(`Jira has no ticket ${key} (or this account cannot see it)`);
    if (res.status < 200 || res.status >= 300)
      throw new SourceReadError(`Jira answered ${res.status} for ${key}`);
    const issue = (await res.json().catch(() => null)) as JiraIssue | null;
    if (!issue || typeof issue !== 'object')
      throw new SourceReadError('Jira returned something that is not JSON');
    const f = issue.fields ?? {};
    const name = (v: { displayName?: string; name?: string } | null | undefined): string | undefined =>
      v?.displayName ?? v?.name;
    const facts: string[] = [];
    const add = (label: string, value: string | undefined | null) => {
      if (value) facts.push(`${label}: ${value}`);
    };
    add('Type', f.issuetype?.name);
    add('Priority', f.priority?.name);
    add('Reporter', name(f.reporter));
    add('Assignee', name(f.assignee));
    add(
      'Components',
      (f.components ?? [])
        .map((x) => x.name)
        .filter(Boolean)
        .join(', '),
    );
    if (f.parent?.key)
      add('Parent', `${f.parent.key}${f.parent.fields?.summary ? ` ${f.parent.fields.summary}` : ''}`);
    const links = (f.issuelinks ?? []).flatMap((l) => {
      const other = l.outwardIssue ?? l.inwardIssue;
      if (!other?.key) return [];
      const rel = l.outwardIssue ? l.type?.outward : l.type?.inward;
      return [
        `${rel ?? l.type?.name ?? 'relates to'} ${other.key}${other.fields?.summary ? ` (${other.fields.summary})` : ''}`,
      ];
    });
    add('Links', links.join('; '));
    const description = jiraText(f.description).trim();
    return ExternalSourceSchema.parse({
      ref,
      title: f.summary ?? '',
      body: [facts.join('\n'), description].filter(Boolean).join('\n\n'),
      ...(f.status?.name ? { status: f.status.name } : {}),
      labels: (f.labels ?? []).filter((l): l is string => typeof l === 'string'),
      url: `${c.base}/browse/${encodeURIComponent(key)}`,
      comments: (f.comment?.comments ?? []).map((cm) => ({
        ...(name(cm.author) ? { author: name(cm.author) } : {}),
        body: jiraText(cm.body),
        ...(cm.created ? { at: cm.created } : {}),
      })),
    });
  }

  private creds(): { base: string; auth: string } | null {
    const cfg = jiraOf(this.opts.config);
    if (!cfg) return null;
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const auth = cfg.email
      ? `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')}`
      : `Bearer ${cfg.apiToken}`;
    return { base, auth };
  }

  private api(key: string): { url: string; headers: Record<string, string>; browse: string } {
    const c = this.creds();
    if (!c)
      throw new PostError(
        'no Jira credentials on this workstation: run `aom-runner jira-connect` (the API token stays on this machine), then retry',
      );
    const { base, auth } = c;
    return {
      url: `${base}/rest/api/2/issue/${encodeURIComponent(key)}/comment`,
      headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' },
      browse: `${base}/browse/${encodeURIComponent(key)}`,
    };
  }

  private send(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
    return (this.opts.fetch ?? ((u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(timeoutMs) })))(
      url,
      init,
    );
  }

  async postApproved(draft: ApprovedDraft): Promise<PostResult> {
    const api = this.api(draft.ref.key);
    const res = await this.send(api.url, {
      method: 'POST',
      headers: api.headers,
      body: JSON.stringify({ body: draft.body }),
    });
    if (res.status < 200 || res.status >= 300) {
      const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
      throw new PostError(`Jira answered ${res.status} for ${draft.ref.key}${text ? `: ${text}` : ''}`);
    }
    const out = (await res.json().catch(() => ({}))) as { id?: string };
    return { externalRef: out.id ? `${api.browse}?focusedCommentId=${out.id}` : api.browse };
  }

  /** Is a comment with exactly this text already on the ticket? (A retry after an ambiguous failure.) */
  async findPosted(draft: ApprovedDraft): Promise<PostResult | null> {
    const api = this.api(draft.ref.key);
    const res = await this.send(`${api.url}?maxResults=100&orderBy=-created`, {
      method: 'GET',
      headers: api.headers,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const out = (await res.json().catch(() => ({}))) as { comments?: Array<{ id?: string; body?: unknown }> };
    const hit = (out.comments ?? []).find(
      (c) => typeof c.body === 'string' && c.body.trim() === draft.body.trim(),
    );
    return hit ? { externalRef: hit.id ? `${api.browse}?focusedCommentId=${hit.id}` : api.browse } : null;
  }

  // ------------------------------------------------------------------------------------------------ attachments

  private needCreds(): { base: string; auth: string } {
    const c = this.creds();
    if (!c)
      throw new SourceReadError(
        'this workstation has no Jira credentials: ask the manager to run `aom-runner jira-connect` on it (the API token stays on the machine and is never shown to you)',
      );
    return c;
  }

  /** The files attached to a ticket (metadata only). */
  async listAttachments(key: string): Promise<JiraAttachmentInfo[]> {
    const { base, auth } = this.needCreds();
    const res = await this.send(`${base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=attachment`, {
      method: 'GET',
      headers: { authorization: auth, accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403)
      throw new SourceReadError(
        `Jira refused the saved credentials (HTTP ${res.status}): the manager must run \`aom-runner jira-connect\` again`,
      );
    if (res.status === 404)
      throw new SourceReadError(`Jira has no ticket ${key} (or this account cannot see it)`);
    if (res.status < 200 || res.status >= 300)
      throw new SourceReadError(`Jira answered ${res.status} for ${key}`);
    const body = (await res.json().catch(() => ({}))) as {
      fields?: {
        attachment?: Array<{
          id?: string | number;
          filename?: string;
          size?: number;
          mimeType?: string;
          created?: string;
          author?: { displayName?: string };
        }>;
      };
    };
    return (body.fields?.attachment ?? []).flatMap((a) =>
      a.id !== undefined && a.filename
        ? [
            {
              id: String(a.id),
              filename: a.filename,
              size: typeof a.size === 'number' ? a.size : 0,
              mimeType: a.mimeType ?? 'application/octet-stream',
              ...(a.created ? { created: a.created } : {}),
              ...(a.author?.displayName ? { author: a.author.displayName } : {}),
            },
          ]
        : [],
    );
  }

  /**
   * One attachment's bytes. The URL is built from the configured base URL and the attachment id, never taken from Jira's
   * answer, so the credentials can only go to the Jira host they were saved for. Stops reading past `maxBytes`.
   */
  async downloadAttachment(att: JiraAttachmentInfo, maxBytes: number): Promise<Buffer> {
    const { base, auth } = this.needCreds();
    const res = await this.send(
      `${base}/rest/api/2/attachment/content/${encodeURIComponent(att.id)}`,
      {
        method: 'GET',
        headers: { authorization: auth, accept: '*/*' },
      },
      120_000,
    );
    if (res.status < 200 || res.status >= 300)
      throw new SourceReadError(`Jira answered ${res.status} for ${att.filename}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes)
      throw new SourceReadError(`${att.filename} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) return Buffer.from(await res.arrayBuffer());
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SourceReadError(`${att.filename} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  /** Does Jira accept the saved credentials? (Facts only: never the token.) */
  async checkStatus(): Promise<JiraStatus> {
    const c = this.creds();
    const cfg = jiraOf(this.opts.config);
    if (!c || !cfg) return { state: 'not_connected' };
    try {
      const res = await this.send(`${c.base}/rest/api/2/myself`, {
        method: 'GET',
        headers: { authorization: c.auth, accept: 'application/json' },
      });
      if (res.status === 401 || res.status === 403)
        return {
          state: 'refused',
          baseUrl: c.base,
          detail: `Jira answered ${res.status}: the token is wrong or expired`,
        };
      if (res.status < 200 || res.status >= 300)
        return { state: 'refused', baseUrl: c.base, detail: `Jira answered ${res.status}` };
      const me = (await res.json().catch(() => ({}))) as { displayName?: string };
      return { state: 'connected', baseUrl: c.base, ...(me.displayName ? { account: me.displayName } : {}) };
    } catch (err) {
      return {
        state: 'refused',
        baseUrl: c.base,
        detail: `cannot reach Jira: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      };
    }
  }
}

const JIRA_READ_FIELDS =
  'summary,description,issuetype,status,priority,labels,components,reporter,assignee,parent,issuelinks,comment';

type JiraPerson = { displayName?: string; name?: string } | null;
interface JiraIssue {
  fields?: {
    summary?: string;
    description?: unknown;
    issuetype?: { name?: string };
    status?: { name?: string };
    priority?: { name?: string };
    labels?: unknown[];
    components?: Array<{ name?: string }>;
    reporter?: JiraPerson;
    assignee?: JiraPerson;
    parent?: { key?: string; fields?: { summary?: string } };
    issuelinks?: Array<{
      type?: { name?: string; inward?: string; outward?: string };
      inwardIssue?: { key?: string; fields?: { summary?: string } };
      outwardIssue?: { key?: string; fields?: { summary?: string } };
    }>;
    comment?: { comments?: Array<{ author?: JiraPerson; body?: unknown; created?: string }> };
  };
}

/** Jira API v2 sends wiki markup as a string (kept as it is); an Atlassian Document (v3) is flattened to its text. */
function jiraText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return '';
  const node = v as { type?: string; text?: string; content?: unknown[] };
  if (typeof node.text === 'string') return node.text;
  const inner = (node.content ?? [])
    .map(jiraText)
    .join(node.type === 'doc' || node.type === 'bulletList' ? '\n' : '');
  return node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem'
    ? `${inner}\n`
    : inner;
}

export interface JiraAttachmentInfo {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  created?: string;
  author?: string;
}

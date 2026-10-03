import {
  type ApprovedDraft,
  type ExternalAdapter,
  type ExternalRef,
  type ExternalSource,
  JIRA_SKILL_PATH,
  type PostResult,
} from '@aom/shared';
import type { JiraConfig } from '../config.ts';
import { PostError, SourceReadError } from './github.ts';

/** Thrown when Jira is asked to be read by the runner: the BA reads it itself, with the Jira skill, inside its session. */
export class SkillMediatedError extends SourceReadError {
  constructor(key: string) {
    super(
      `Jira ticket ${key} is read by you, inside this conversation, with the Jira skill (the "Jira skill" section of your instructions; vault file ${JIRA_SKILL_PATH}) and the Jira tool of your runtime. The runner holds no Jira credentials for intake.`,
    );
    this.name = 'SkillMediatedError';
  }
}

/**
 * Jira on the read side is the agent's own skill/MCP (docs/PLAN.md M7): the credentials live in the runtime's tool
 * configuration on this workstation, so the runner has nothing to fetch itself. `readSource` says so; a runtime that
 * can read Jira on the runner's behalf (a later milestone) plugs in as `reader`.
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
      config?: JiraConfig | undefined;
      /** A seam so tests never reach Jira (undici MockAgent). */
      fetch?: FetchFn;
    } = {},
  ) {}

  readSource(ref: ExternalRef): Promise<ExternalSource> {
    if (this.opts.reader) return this.opts.reader(ref);
    return Promise.reject(new SkillMediatedError(ref.key));
  }

  private api(key: string): { url: string; headers: Record<string, string>; browse: string } {
    const cfg = this.opts.config;
    if (!cfg)
      throw new PostError(
        'no Jira credentials on this workstation: add "jira": { "baseUrl", "email", "apiToken" } to the runner config (config.json), then retry',
      );
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const auth = cfg.email
      ? `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')}`
      : `Bearer ${cfg.apiToken}`;
    return {
      url: `${base}/rest/api/2/issue/${encodeURIComponent(key)}/comment`,
      headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' },
      browse: `${base}/browse/${encodeURIComponent(key)}`,
    };
  }

  private send(url: string, init: RequestInit): Promise<Response> {
    return (this.opts.fetch ?? ((u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(30_000) })))(
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
}

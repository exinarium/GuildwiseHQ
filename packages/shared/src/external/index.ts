import { z } from 'zod';
import { ExternalSystem } from '../events/intake.ts';

/**
 * External systems (docs/SPEC.md "External systems boundary"; docs/ARCHITECTURE.md section 16.5). Company systems such as
 * Jira are clients of the organization: inbound is read-only (the BA reads a ticket during intake and keeps its key on
 * the card) and every outbound write needs the manager's approval. Credentials live only on workstations, so adapters run
 * on the runner. M7 implements `readSource` (Jira through the agent's Jira skill, GitHub through `gh`); M8 implements
 * `postApproved` against this same interface.
 */

/** A ticket: Jira `ABC-123`, or a GitHub issue `owner/repo#12`. */
export const ExternalRefSchema = z.object({
  system: ExternalSystem,
  /** `ABC-123` (Jira) or `owner/repo#12` (GitHub). */
  key: z.string().min(1).max(200),
  /** The ticket's URL when the manager pasted one. */
  url: z.string().optional(),
});
export type ExternalRef = z.infer<typeof ExternalRefSchema>;

const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;
const GITHUB_SHORT = /\b([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#(\d+)\b/;
const GITHUB_URL =
  /https?:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)/;
const JIRA_URL = /https?:\/\/[^\s/]+\/browse\/([A-Z][A-Z0-9]{1,9}-\d+)/;

/** Finds the ticket a piece of pasted text refers to (a URL, `owner/repo#12` or `ABC-123`), or null. */
export function parseExternalRef(text: string): ExternalRef | null {
  const gh = GITHUB_URL.exec(text);
  if (gh) return { system: 'github', key: `${gh[1]}#${gh[2]}`, url: gh[0] };
  const jiraUrl = JIRA_URL.exec(text);
  if (jiraUrl) return { system: 'jira', key: jiraUrl[1] as string, url: jiraUrl[0] };
  const short = GITHUB_SHORT.exec(text);
  if (short) return { system: 'github', key: `${short[1]}#${short[2]}` };
  const jira = JIRA_KEY.exec(text);
  if (jira) return { system: 'jira', key: jira[1] as string };
  return null;
}

/** `owner/repo#12` -> `{ repo: 'owner/repo', number: 12 }`; null for anything else. */
export function parseGithubKey(key: string): { repo: string; number: number } | null {
  const m = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(key);
  return m ? { repo: m[1] as string, number: Number(m[2]) } : null;
}

/** What `readSource` returns: the ticket as the BA reads it (never written back automatically). */
export const ExternalSourceSchema = z.object({
  ref: ExternalRefSchema,
  title: z.string(),
  body: z.string(),
  status: z.string().optional(),
  labels: z.array(z.string()).default([]),
  url: z.string().optional(),
  comments: z
    .array(z.object({ author: z.string().optional(), body: z.string(), at: z.string().optional() }))
    .default([]),
});
export type ExternalSource = z.infer<typeof ExternalSourceSchema>;

export const OutboundDraftKind = z.enum(['comment', 'resolution', 'decision']);
export type OutboundDraftKind = z.infer<typeof OutboundDraftKind>;

/** A draft the manager approved (possibly edited): `body` is the final text, posted as it is. M8 posts these. */
export const ApprovedDraftSchema = z.object({
  draftId: z.uuid(),
  ref: ExternalRefSchema,
  kind: OutboundDraftKind,
  body: z.string().min(1),
});
export type ApprovedDraft = z.infer<typeof ApprovedDraftSchema>;

export const PostResultSchema = z.object({ externalRef: z.string().optional() });
export type PostResult = z.infer<typeof PostResultSchema>;

/** Thrown by adapter operations a milestone has not built yet (the post side until M8). */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/**
 * One external system, as seen from the runner of the workstation that holds its credentials.
 * `readSource(ref)` reads a ticket; `postApproved(draft)` posts a manager-approved draft (M8; a typed stub in M7).
 */
export interface ExternalAdapter {
  readonly system: ExternalSystem;
  readSource(ref: ExternalRef): Promise<ExternalSource>;
  postApproved(draft: ApprovedDraft): Promise<PostResult>;
}

/**
 * The provider-neutral Jira skill (vault `skills/jira.md`, also embedded in the BA's intake instructions): how the BA
 * reads a Jira ticket with whatever Jira tool the agent's runtime offers (an MCP server, a CLI, the REST API).
 */
export const JIRA_SKILL_PATH = 'skills/jira.md';
export const JIRA_SKILL_MD = `# Skill: read a Jira ticket

Use this to read one Jira ticket during intake. It is read-only: never create, edit, comment on or transition a ticket.

1. Use the Jira tool your runtime provides (an Atlassian/Jira MCP server, a \`jira\` CLI, or the REST API with the credentials already configured on this workstation). Do not ask the manager for credentials.
2. Fetch the issue by key: summary, description, issue type, status, priority, labels, components, reporter, and the comments.
3. Fetch linked issues (blocks, is blocked by, relates to) and the parent epic, when present; they feed the dependency graph.
4. Note the Jira project key (the part before the dash). It usually identifies the Agent Org Manager project.
5. If the ticket cannot be read (no tool, no access), say so plainly in the conversation; never invent ticket content.
6. Store the ticket key in the card's \`externalRef\` field. Quote the ticket in the card's context; do not paste secrets.
`;

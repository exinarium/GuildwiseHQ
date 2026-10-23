import { v7 } from 'uuid';
import { z } from 'zod';

/** Branded uuid string. Use `Uuid` in signatures where mixing ids up is a risk; most schemas use plain `z.uuid()`. */
export type Uuid = string & { readonly __brand: 'Uuid' };
export const UuidSchema = z.uuid().transform((v) => v as Uuid);

/** Time-ordered id minted client-side (message ids, envelope ids). Server rows default to Postgres `uuidv7()`. */
export const uuidv7 = (): Uuid => v7() as Uuid;

export const PROTOCOL_VERSION = 1 as const;

/** Event stream id helpers (docs/ARCHITECTURE.md section 2). */
export const streamId = {
  user: (id: string) => `user-${id}`,
  org: (id: string) => `org-${id}`,
  invitation: (id: string) => `invitation-${id}`,
  workstation: (id: string) => `workstation-${id}`,
  project: (id: string) => `project-${id}`,
  card: (id: string) => `card-${id}`,
  agent: (id: string) => `agent-${id}`,
  thread: (id: string) => `thread-${id}`,
  desk: (id: string) => `desk-${id}`,
  platformPause: (id: string) => `platform-pause-${id}`,
  platformTeam: () => 'platform-team',
  /** The blog writer's topic queue: one stream for the platform, with no organization in it (ceo-blog-topics.md 3.2). */
  blogTopics: () => 'blog-topics',
  ledger: (id: string) => `ledger-${id}`,
  intake: (id: string) => `intake-${id}`,
  outbound: (id: string) => `outbound-${id}`,
  mailInbox: (id: string) => `mailinbox-${id}`,
  repo: (id: string) => `repo-${id}`,
  schedule: (id: string) => `schedule-${id}`,
  interest: (id: string) => `interest-${id}`,
  phase: (id: string) => `phase-${id}`,
  baTask: (id: string) => `ba-task-${id}`,
  intakeBatch: (id: string) => `intake-batch-${id}`,
  backlog: (id: string) => `backlog-${id}`,
  baSignal: (id: string) => `ba-signal-${id}`,
  shift: (id: string) => `shift-${id}`,
  ceo: (orgId: string) => `ceo-${orgId}`,
  ceoTask: (id: string) => `ceo-task-${id}`,
  ceoNotice: (id: string) => `ceo-notice-${id}`,
  run: (id: string) => `run-${id}`,
  vault: (id: string) => `vault-${id}`,
  workflow: (orgId: string | null, key: string) => `workflow-${orgId ?? 'builtin'}-${key}`,
  department: (orgId: string) => `departments-${orgId}`,
  role: (orgId: string | null, key: string) => `role-${orgId ?? 'builtin'}-${key}`,
  /** Durable turns of a discovery or boardroom session. */
  sessionTurn: (id: string) => `session-turn-${id}`,
  /** One nested `aom delegate` call (its cost, booked under the caller). */
  delegate: (id: string) => `delegate-${id}`,
  document: (id: string) => `document-${id}`,
  /** Saved boardroom casts of an organization. */
  boardRooms: (orgId: string) => `board-rooms-${orgId}`,
  /** The organization vault's capability index. */
  capabilities: (orgId: string) => `capabilities-${orgId}`,
  /** One capability pack (git import, trust, pin). */
  pack: (id: string) => `pack-${id}`,
  /** What a project's checkout carries (.agents/skills ...). */
  projectCapabilities: (projectId: string) => `project-capabilities-${projectId}`,
} as const;

export const ProjectKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'project key: 2-10 chars, A-Z0-9, starts with a letter');

/** `WEB-12`. */
export function cardRef(projectKey: string, n: number): string {
  return `${projectKey}-${n}`;
}

export function parseCardRef(ref: string): { projectKey: string; number: number } | null {
  const m = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]*)$/.exec(ref);
  if (!m) return null;
  return { projectKey: m[1] as string, number: Number(m[2]) };
}

/** Lowercase ascii slug, `-` separated, truncated to `max` chars without a trailing dash. */
export function slugify(input: string, max = 40): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/g, '');
}

/** `<prefix><ref-lowercase>-<slug(title, 40)>`, e.g. `aom/web-12-add-login-page` (section 13.5). */
export function branchName(prefix: string, ref: string, title: string): string {
  const slug = slugify(title, 40);
  return `${prefix}${ref.toLowerCase()}${slug ? `-${slug}` : ''}`;
}

/**
 * Normalizes a git remote to `host/path`: lowercase, no scheme, no user, no `.git`, no trailing slash.
 * `git@github.com:acme/web.git` and `https://github.com/acme/web` both give `github.com/acme/web`.
 */
export function normalizeRemoteUrl(url: string): string {
  let s = url.trim();
  let sshPort: string | undefined;
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/\/)(.+)$/.exec(s);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    const isSsh = /^ssh:\/\//i.test(s);
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    s = s.replace(/^[^@/]+@/, '');
    if (isSsh) sshPort = /^[^/:]+:(\d+)\//.exec(s)?.[1];
    s = s.replace(/^([^/:]+):\d+\//, '$1/');
  }
  s = s
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return canonicalHostPath(s, sshPort).toLowerCase();
}

const KNOWN_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

/**
 * Forms of one repository that differ per transport: Azure DevOps (`dev.azure.com/o/p/_git/r`, the older
 * `o.visualstudio.com/p/_git/r`, and ssh `ssh.dev.azure.com/v3/o/p/r`) and Bitbucket Data Center (`host/scm/proj/repo`
 * over https, `host:7999/proj/repo` over ssh) are mapped to the https shape.
 */
function canonicalHostPath(s: string, sshPort: string | undefined): string {
  const slash = s.indexOf('/');
  if (slash < 0) return s;
  const host = s.slice(0, slash).toLowerCase();
  const path = s.slice(slash + 1);
  const dec = (x: string | undefined): string => {
    try {
      return decodeURIComponent(x ?? '');
    } catch {
      return x ?? '';
    }
  };
  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    const m = /^v3\/([^/]+)\/([^/]+)\/(.+)$/i.exec(path);
    if (m) return `dev.azure.com/${dec(m[1])}/${dec(m[2])}/_git/${dec(m[3])}`;
  }
  if (host === 'dev.azure.com') {
    // A project-less form (dev.azure.com/org/_git/repo) means the project has the repository's name.
    const m = /^([^/]+)\/(?:([^/]+)\/)?_git\/(.+)$/i.exec(path);
    if (m) return `dev.azure.com/${dec(m[1])}/${dec(m[2] ?? m[3])}/_git/${dec(m[3])}`;
  }
  const vs = /^([^.]+)\.visualstudio\.com$/i.exec(host);
  if (vs) {
    const m = /^(?:defaultcollection\/)?(?:([^/]+)\/)?_git\/(.+)$/i.exec(path);
    if (m) return `dev.azure.com/${vs[1]}/${dec(m[1] ?? m[2])}/_git/${dec(m[2])}`;
  }
  if (!KNOWN_HOSTS.has(host)) {
    const scm = /(?:^|\/)scm\/([^/]+\/[^/]+)$/i.exec(path);
    if (scm) return `${host}/scm/${scm[1]}`;
    if (sshPort === '7999' && /^[^/]+\/[^/]+$/.test(path)) return `${host}/scm/${path}`;
  }
  return s;
}

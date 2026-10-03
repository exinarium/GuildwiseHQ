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
  invitation: (id: string) => `invitation-${id}`,
  workstation: (id: string) => `workstation-${id}`,
  project: (id: string) => `project-${id}`,
  card: (id: string) => `card-${id}`,
  agent: (id: string) => `agent-${id}`,
  thread: (id: string) => `thread-${id}`,
  desk: (id: string) => `desk-${id}`,
  ledger: (id: string) => `ledger-${id}`,
  intake: (id: string) => `intake-${id}`,
  outbound: (id: string) => `outbound-${id}`,
  schedule: (id: string) => `schedule-${id}`,
  shift: (id: string) => `shift-${id}`,
  vault: (id: string) => `vault-${id}`,
  workflow: (orgId: string | null, key: string) => `workflow-${orgId ?? 'builtin'}-${key}`,
  role: (orgId: string | null, key: string) => `role-${orgId ?? 'builtin'}-${key}`,
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
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/\/)(.+)$/.exec(s);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    s = s.replace(/^[^@/]+@/, '');
    s = s.replace(/^([^/:]+):\d+\//, '$1/');
  }
  s = s
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return s.toLowerCase();
}

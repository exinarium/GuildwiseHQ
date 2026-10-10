import { z } from 'zod';
import { normalizeRemoteUrl } from '../ids.ts';

/**
 * Git hosts ("forges"). The provider is chosen per project repository: detected from the remote URL, with a manual
 * override stored on the repository (`forge_kind`). `git` is the plain-git fallback (push a branch, no pull request).
 */
export const FORGE_KINDS = ['github', 'gitlab', 'bitbucket-cloud', 'bitbucket-dc', 'azure-devops', 'git'] as const;
export const ForgeKindSchema = z.enum(FORGE_KINDS);
export type ForgeKind = z.infer<typeof ForgeKindSchema>;

/** Providers a user can connect on a workstation (plain git needs no connection beyond the git credentials). */
export const CONNECTABLE_FORGES = ['github', 'gitlab', 'bitbucket-cloud', 'azure-devops'] as const;
export const ConnectableForgeSchema = z.enum(CONNECTABLE_FORGES);
export type ConnectableForge = z.infer<typeof ConnectableForgeSchema>;

export const FORGE_LABELS: Record<ForgeKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  'bitbucket-cloud': 'Bitbucket Cloud',
  'bitbucket-dc': 'Bitbucket Data Center',
  'azure-devops': 'Azure DevOps',
  git: 'Plain git',
};

export interface ParsedRemote {
  kind: ForgeKind;
  host: string;
  /** Owner / group path / workspace; for Azure DevOps `[organization, project]`. */
  namespace: string[];
  name: string;
  /** `normalizeRemoteUrl` of the url. */
  canonical: string;
}

/** Hosts that are one provider for sure; anything else is guessed from the path shape, else plain git. */
export function detectForgeKind(url: string, override?: ForgeKind | null): ForgeKind {
  if (override) return override;
  return parseRemote(url)?.kind ?? 'git';
}

/** Splits a remote url by provider. Null when it is not a usable remote. `override` forces the provider. */
export function parseRemote(url: string, override?: ForgeKind | null): ParsedRemote | null {
  const canonical = normalizeRemoteUrl(url);
  const parts = canonical.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  const host = parts[0] as string;
  const rest = parts.slice(1);
  const name = rest[rest.length - 1] as string;
  let kind: ForgeKind;
  let namespace = rest.slice(0, -1);
  if (host === 'dev.azure.com' && rest[2] === '_git') {
    kind = 'azure-devops';
    namespace = [rest[0] as string, rest[1] as string];
  } else if (host === 'github.com' || host.startsWith('github.')) kind = 'github';
  else if (host === 'gitlab.com' || host.startsWith('gitlab.')) kind = 'gitlab';
  else if (host === 'bitbucket.org') kind = 'bitbucket-cloud';
  else if (rest[0] === 'scm' && rest.length === 3) {
    kind = 'bitbucket-dc';
    namespace = [rest[1] as string];
  } else kind = 'git';
  if (override) kind = override;
  return { kind, host, namespace, name, canonical };
}

// ------------------------------------------------------------------ connections (status only, never a secret)

export const GitConnectionStateSchema = z.enum(['connected', 'not_connected', 'unavailable']);
export type GitConnectionState = z.infer<typeof GitConnectionStateSchema>;

/** What a workstation says about one provider. Only facts, never a token. */
export const GitConnectionSchema = z.object({
  provider: ConnectableForgeSchema,
  /** The host the login is for (`github.com`, a self-managed GitLab, ...). */
  host: z.string().max(200),
  state: GitConnectionStateSchema,
  /** Account the login belongs to, when the provider told us. */
  account: z.string().max(200).optional(),
  /** How the login works on this workstation. */
  method: z.enum(['cli', 'token', 'ssh']).optional(),
  /** Why it is not connected / what to do next, in a sentence. */
  detail: z.string().max(400).optional(),
  checkedAt: z.iso.datetime(),
});
export type GitConnection = z.infer<typeof GitConnectionSchema>;

export const GitConnectionsSchema = z.array(GitConnectionSchema).max(40);

// ------------------------------------------------------------------ repository picker

export const RepoRefSchema = z.object({
  provider: ForgeKindSchema,
  /** `owner/name`, `group/sub/name`, `org/project/name`. */
  fullName: z.string().max(400),
  cloneUrl: z.string().max(600),
  sshUrl: z.string().max(600).optional(),
  defaultBranch: z.string().max(200).optional(),
  private: z.boolean().optional(),
});
export type RepoRef = z.infer<typeof RepoRefSchema>;

/** Payload of the `forge.repos` runner command (the repository picker) and of `git.status`. */
export const ForgeReposPayloadSchema = z.object({
  requestId: z.uuid(),
  provider: ConnectableForgeSchema,
  search: z.string().max(100).optional(),
});
export type ForgeReposPayload = z.infer<typeof ForgeReposPayloadSchema>;

export const ForgeReposResultSchema = z.object({
  ok: z.boolean(),
  repos: z.array(RepoRefSchema).max(200).default([]),
  error: z.string().max(500).optional(),
});
export type ForgeReposResult = z.infer<typeof ForgeReposResultSchema>;

// ------------------------------------------------------------------ creating a repository, per provider

/** The fields of the "new repository" form for a provider: which parts the full name is made of. */
export interface CreateFieldSpec {
  /** Labels of the name parts, in order; the last one is the repository name. */
  parts: Array<{ key: string; label: string; placeholder: string }>;
  /** Free text under the form. */
  hint: string;
  canCreate: boolean;
}

export const CREATE_FIELDS: Record<ForgeKind, CreateFieldSpec> = {
  github: {
    parts: [
      { key: 'owner', label: 'Owner', placeholder: 'acme' },
      { key: 'name', label: 'Repository', placeholder: 'barcode-camera' },
    ],
    hint: 'The owner is your GitHub user or organization.',
    canCreate: true,
  },
  gitlab: {
    parts: [
      { key: 'namespace', label: 'Group or user (subgroups with /)', placeholder: 'acme/mobile' },
      { key: 'name', label: 'Project', placeholder: 'barcode-camera' },
    ],
    hint: 'The group or user the project lives under. Subgroups are written acme/mobile.',
    canCreate: true,
  },
  'bitbucket-cloud': {
    parts: [
      { key: 'workspace', label: 'Workspace', placeholder: 'acme' },
      { key: 'name', label: 'Repository', placeholder: 'barcode-camera' },
    ],
    hint: 'The Bitbucket workspace ID. The repository is made in its default project.',
    canCreate: true,
  },
  'azure-devops': {
    parts: [
      { key: 'organization', label: 'Organization', placeholder: 'acme' },
      { key: 'project', label: 'Project', placeholder: 'Mobile' },
      { key: 'name', label: 'Repository', placeholder: 'barcode-camera' },
    ],
    hint: 'Azure DevOps repositories live inside a project of an organization.',
    canCreate: true,
  },
  'bitbucket-dc': {
    parts: [],
    hint: 'Creating repositories on Bitbucket Data Center is not supported: create it there and paste its URL.',
    canCreate: false,
  },
  git: {
    parts: [],
    hint: 'A plain git server has no API: create the repository there and paste its URL.',
    canCreate: false,
  },
};

const SEG = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
const REPO_SEG = /^[A-Za-z0-9._-]{1,100}$/;

/** Validates the parts of a new repository for a provider; returns the full name or an error. */
export function createNameFor(
  kind: ForgeKind,
  parts: string[],
): { ok: true; fullName: string } | { ok: false; error: string } {
  const spec = CREATE_FIELDS[kind];
  if (!spec.canCreate) return { ok: false, error: spec.hint };
  const clean = parts.map((p) => p.trim().replace(/^\/+|\/+$/g, ''));
  if (clean.length !== spec.parts.length || clean.some((p) => !p)) return { ok: false, error: 'Fill in every field' };
  const name = clean[clean.length - 1] as string;
  if (!REPO_SEG.test(name) || name === '.' || name === '..' || name.startsWith('-') || name.endsWith('.git'))
    return {
      ok: false,
      error: 'The repository name may only contain letters, digits ".", "_" and "-" (no ".git" suffix)',
    };
  for (const p of clean.slice(0, -1)) {
    const segs = kind === 'gitlab' ? p.split('/') : [p];
    if (segs.some((s) => !SEG.test(s) || s === '.' || s === '..'))
      return { ok: false, error: `"${p}" is not a valid ${kind === 'azure-devops' ? 'name' : 'owner or namespace'}` };
  }
  return { ok: true, fullName: clean.join('/') };
}

/** The https clone URL for a full name made with `createNameFor`. `host` is for self-managed hosts. */
export function cloneUrlFor(kind: ForgeKind, fullName: string, host?: string): string {
  const seg = fullName.split('/');
  switch (kind) {
    case 'github':
      return `https://${host ?? 'github.com'}/${fullName}.git`;
    case 'gitlab':
      return `https://${host ?? 'gitlab.com'}/${fullName}.git`;
    case 'bitbucket-cloud':
      return `https://bitbucket.org/${fullName}.git`;
    case 'azure-devops':
      return `https://dev.azure.com/${seg[0]}/${encodeURIComponent(seg[1] ?? '')}/_git/${seg[2]}`;
    default:
      throw new Error(`cannot build a clone URL for ${kind}`);
  }
}

/** Splits a full name into the parts of the create form (GitLab keeps subgroups in the first part). */
export function splitFullName(kind: ForgeKind, fullName: string): string[] {
  const seg = fullName.split('/');
  if (kind === 'gitlab') return seg.length < 2 ? seg : [seg.slice(0, -1).join('/'), seg[seg.length - 1] as string];
  return seg;
}

/** Null when `fullName` is a valid new-repository name for the provider, else the reason. */
export function createFullNameError(kind: ForgeKind, fullName: string): string | null {
  const r = createNameFor(kind, splitFullName(kind, fullName));
  return r.ok ? null : r.error;
}

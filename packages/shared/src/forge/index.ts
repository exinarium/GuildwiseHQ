import { z } from 'zod';
import { normalizeRemoteUrl } from '../ids.ts';

/**
 * Git hosts ("forges"). The provider is chosen per project repository: detected from the remote URL, with a manual
 * override stored on the repository (`forge_kind`). `git` is the plain-git fallback (push a branch, no pull request).
 */
export const FORGE_KINDS = [
  'github',
  'gitlab',
  'bitbucket-cloud',
  'bitbucket-dc',
  'azure-devops',
  'git',
] as const;
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

/**
 * The web page of a file on a branch, for the hosts whose URL shape is known (GitHub, GitLab, Bitbucket Cloud, Azure
 * DevOps). Null for plain git or an unusable remote. Used to link the architect's report from the card.
 */
export function repoFileUrl(
  remoteUrl: string,
  branch: string,
  path: string,
  override?: ForgeKind | null,
): string | null {
  const r = parseRemote(remoteUrl, override);
  if (!r) return null;
  const file = path.split('/').map(encodeURIComponent).join('/');
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  const ns = r.namespace.map(encodeURIComponent).join('/');
  const name = encodeURIComponent(r.name);
  switch (r.kind) {
    case 'github':
      return `https://${r.host}/${ns}/${name}/blob/${ref}/${file}`;
    case 'gitlab':
      return `https://${r.host}/${ns}/${name}/-/blob/${ref}/${file}`;
    case 'bitbucket-cloud':
      return `https://${r.host}/${ns}/${name}/src/${ref}/${file}`;
    case 'azure-devops':
      return `https://${r.host}/${ns}/_git/${name}?path=/${file}&version=GB${encodeURIComponent(branch)}`;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ connections (status only, never a secret)

/**
 * How git reaches a repository: `https` with the host's token or CLI login, or `ssh` with a key on the workstation.
 * Chosen per workstation and git host (the default) and per repository (the override).
 */
export const GIT_ACCESS_METHODS = ['https', 'ssh'] as const;
export const GitAccessMethodSchema = z.enum(GIT_ACCESS_METHODS);

export const GIT_ACCESS_LABELS: Record<(typeof GIT_ACCESS_METHODS)[number], string> = {
  https: 'API token / CLI login (https)',
  ssh: 'SSH key',
};

/** Which key the runner uses: one it generated (`~/.ssh/aom_<provider>`), a key file the owner named, or the ssh-agent. */
export const SSH_KEY_MODES = ['generated', 'path', 'agent'] as const;
export const SshKeyModeSchema = z.enum(SSH_KEY_MODES);
export type SshKeyMode = z.infer<typeof SshKeyModeSchema>;

/** The result of the SSH check (`ssh -T` or `git ls-remote` against a repository). */
export const SSH_CHECK_STATES = [
  'ok',
  'no_key',
  'not_authorized',
  'host_key',
  'unreachable',
  'tool_missing',
  'unknown',
] as const;
export const SshCheckStateSchema = z.enum(SSH_CHECK_STATES);
export type SshCheckState = z.infer<typeof SshCheckStateSchema>;

export const SSH_CHECK_LABELS: Record<SshCheckState, string> = {
  ok: 'SSH works',
  no_key: 'No key yet',
  not_authorized: 'The host refused the key',
  host_key: 'Host key changed',
  unreachable: 'Host not reachable',
  tool_missing: 'ssh is not installed',
  unknown: 'Not checked',
};

/** SSH facts of one git host on a workstation. Paths and the PUBLIC key only: the private key never leaves the machine. */
export const GitSshSchema = z.object({
  /** The workstation default for new clones of repositories on this host. */
  defaultMethod: GitAccessMethodSchema,
  key: SshKeyModeSchema,
  /** The private key file in use (a path, never its content); absent for the ssh-agent. */
  keyPath: z.string().max(400).optional(),
  /** The public key to add to the git host; absent while no key exists. */
  publicKey: z.string().max(1000).optional(),
  check: z
    .object({
      state: SshCheckStateSchema,
      detail: z.string().max(400).optional(),
      checkedAt: z.iso.datetime(),
    })
    .optional(),
});
export type GitSsh = z.infer<typeof GitSshSchema>;

/** `git.ssh` runner command: prepare a key, record the choice, or check that SSH works. Carries no secret. */
export const GitSshPayloadSchema = z.object({
  provider: ConnectableForgeSchema,
  host: z.string().max(200).optional(),
  action: z.enum(['prepare', 'check', 'save']),
  /** `save`: the workstation default and the key to use. */
  defaultMethod: GitAccessMethodSchema.optional(),
  key: SshKeyModeSchema.optional(),
  /** `save` with `key: 'path'`: the private key file on the workstation. */
  keyPath: z.string().max(400).optional(),
  /** `check`: a repository on the host to test with `git ls-remote` (otherwise `ssh -T`). */
  repoUrl: z.string().max(2000).optional(),
});
export type GitSshPayload = z.infer<typeof GitSshPayloadSchema>;

/** `repo.access` runner command: a repository's access method changed; the clone's `origin` follows. */
export const RepoAccessPayloadSchema = z.object({
  repoId: z.uuid(),
  remoteUrl: z.string().min(1).max(2000),
  /** The owner's choice for this repository; absent: the workstation default of the host applies. */
  accessMethod: GitAccessMethodSchema.optional(),
  forge: ForgeKindSchema.optional(),
});
export type RepoAccessPayload = z.infer<typeof RepoAccessPayloadSchema>;

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
  method: z.enum(['cli', 'token', 'ssh', 'service-principal']).optional(),
  /** Why it is not connected / what to do next, in a sentence. */
  detail: z.string().max(400).optional(),
  /** Why a login is not usable: no token saved, the host refused the token, or the host could not be reached. */
  problem: z.enum(['no_token', 'token_refused', 'unreachable']).optional(),
  /** SSH facts for this host (workstation default, key, last check); absent from runners without SSH support. */
  ssh: GitSshSchema.optional(),
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
  if (clean.length !== spec.parts.length || clean.some((p) => !p))
    return { ok: false, error: 'Fill in every field' };
  const name = clean[clean.length - 1] as string;
  if (!REPO_SEG.test(name) || name === '.' || name === '..' || name.startsWith('-') || name.endsWith('.git'))
    return {
      ok: false,
      error: 'The repository name may only contain letters, digits ".", "_" and "-" (no ".git" suffix)',
    };
  for (const p of clean.slice(0, -1)) {
    const segs = kind === 'gitlab' ? p.split('/') : [p];
    if (segs.some((s) => !SEG.test(s) || s === '.' || s === '..'))
      return {
        ok: false,
        error: `"${p}" is not a valid ${kind === 'azure-devops' ? 'name' : 'owner or namespace'}`,
      };
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
  if (kind === 'gitlab')
    return seg.length < 2 ? seg : [seg.slice(0, -1).join('/'), seg[seg.length - 1] as string];
  return seg;
}

/** Null when `fullName` is a valid new-repository name for the provider, else the reason. */
export function createFullNameError(kind: ForgeKind, fullName: string): string | null {
  const r = createNameFor(kind, splitFullName(kind, fullName));
  return r.ok ? null : r.error;
}

/** The plain-language steps of `aom-runner git-connect <provider>` (the CLI prints them, the web helper and the DevOps agent show them). */
export function connectSteps(provider: ConnectableForge, host = defaultHost(provider)): string[] {
  switch (provider) {
    case 'github':
      return [
        `1. Install the GitHub CLI if it is missing: https://cli.github.com`,
        `2. A browser opens: sign in and approve (\`gh auth login --web --hostname ${host}\`).`,
        '3. Pick HTTPS when asked, so git can use the same login (gh sets up the credential helper).',
      ];
    case 'gitlab':
      return [
        '1. Either install the GitLab CLI (https://gitlab.com/gitlab-org/cli) and run `glab auth login`,',
        `   or create a personal access token on ${host} (User settings, Access tokens) with the scopes api and write_repository.`,
        '2. Paste the token when asked. It is kept on this workstation only (secrets/git-tokens.json, mode 0600).',
      ];
    case 'bitbucket-cloud':
      return [
        '1. Create an API token: Bitbucket, Settings, Atlassian account settings, Security, API tokens, "Create API token with scopes" (Bitbucket).',
        '   Scopes: read:repository, write:repository, read:pullrequest, write:pullrequest, read:user.',
        '   (App passwords no longer work: they were switched off on 2026-06-09.)',
        '2. Enter your Atlassian e-mail address and paste the token when asked.',
        '3. Optional SSH instead of https: run this command with --ssh-key, then add the printed public key under Personal Bitbucket settings, SSH keys.',
      ];
    case 'azure-devops':
      return [
        '1. Best: a Microsoft Entra service principal (workload identity). Add it to your Azure DevOps organization (Organization settings, Users) with Basic access and give it access to the project, then on this workstation set AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET (or AZURE_FEDERATED_TOKEN_FILE for workload identity) and run this command again. `az login --service-principal` works too.',
        '2. Fallback: a personal access token for your organization (dev.azure.com, User settings, Personal access tokens, scope "Code: Read & write" and "Project and Team: Read"). Use an organization-scoped token: global tokens stop working on 2026-12-01. Run this command with --organization <name> and paste the token when asked.',
        '3. Or sign in with the Azure CLI (`az login`): it works without a token.',
      ];
  }
}

/** Where to add the public SSH key on each git host (the CLI prints it, the Git hosts section shows it). */
export function sshUploadHelp(provider: ConnectableForge, host = defaultHost(provider)): string {
  switch (provider) {
    case 'github':
      return `https://${host}/settings/keys: New SSH key, paste the public key.`;
    case 'gitlab':
      return `https://${host}/-/user_settings/ssh_keys: paste the public key, Add key.`;
    case 'bitbucket-cloud':
      return 'bitbucket.org: Personal settings, SSH keys, Add key, paste the public key.';
    case 'azure-devops':
      return 'dev.azure.com: User settings, SSH public keys, New Key, paste the public key.';
  }
}

/** The default host of a connectable provider. */
export function defaultHost(provider: ConnectableForge): string {
  return provider === 'github'
    ? 'github.com'
    : provider === 'gitlab'
      ? 'gitlab.com'
      : provider === 'bitbucket-cloud'
        ? 'bitbucket.org'
        : 'dev.azure.com';
}

/** The command a user runs on the workstation to connect a provider. */
export function connectCommand(provider: ConnectableForge): string {
  return `aom-runner git-connect ${provider}${provider === 'azure-devops' ? ' --organization <your-organization>' : ''}`;
}

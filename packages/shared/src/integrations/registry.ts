import { ACCOUNT_KEY_RE } from '../claude/accounts.ts';
import { INTEGRATION_INSTANCE_RE, type IntegrationKindId, type IntegrationScope } from './schema.ts';

/**
 * The integration registry (docs/design/integrations-page.md section 1). The page, the server's validation, the CLI help
 * and the agents' "how to connect" text all read this one list. Adding an integration is one entry here, one adapter on
 * the runner (`apps/runner/src/integrations/<kind>.ts`) and one test file.
 */

export interface IntegrationField {
  key: string;
  label: string;
  type: 'text' | 'secret' | 'url' | 'email' | 'host';
  required: boolean;
  placeholder?: string;
  maxLength: number;
  help?: string;
}

export interface IntegrationStep {
  text: string;
  link?: { href: string; label: string };
}

export interface IntegrationMethod {
  /** `token`, `device`, `setup_token`, `oauth_paste`, `api_key`, `oauth_token`, ... */
  id: string;
  label: string;
  /**
   * `fields`: the page collects fields, seals them and the runner saves them after the provider accepted them.
   * `interactive`: the runner drives a login (URL, code, paste-back). `local_only`: instructions only.
   */
  flow: 'fields' | 'interactive' | 'local_only';
  fields?: IntegrationField[];
  /** `interactive` only: what the user pastes back, if anything. */
  paste?: 'code' | 'redirect_url' | 'none';
  /** A later phase: listed, not offered, rejected by the server. */
  phase?: 2 | 3;
  scopes?: Array<{ name: string; why: string; required: boolean }>;
  steps: IntegrationStep[];
  expiry?: string;
  warning?: string;
}

export interface IntegrationKind {
  id: IntegrationKindId;
  label: string;
  group: 'ai' | 'git' | 'tracker' | 'mcp' | 'other';
  /** One of it per workstation, or several (per host, organization, server, provider@host). */
  instances:
    | 'single'
    | {
        by: 'host' | 'organization' | 'server' | 'provider-host' | 'account';
        label: string;
        placeholder: string;
        defaultInstance?: string;
      };
  /** Where the credential lives. `mixed`: it depends on the method (`methodScope`). */
  scope: IntegrationScope | 'mixed';
  /** Scope per method id for `mixed` kinds (a method not listed is `workstation`). */
  machineMethods?: string[];
  methods: IntegrationMethod[];
  help: { summary: string; docsUrl?: string; notes?: string[] };
  test: { label: string; what: string };
  /** Human text: where the credential is kept on the workstation. */
  storage: string;
  /** The headless equivalent. `{instance}` is replaced by the instance. */
  cli: string;
  /** The runner version that supports web connect for this kind (shown in the "update your runner" banner). */
  minRunner: string;
  /**
   * Set when a named instance needs a newer runner than the default one (claude-code: an account key needs 0.1.33).
   * Applies to every non-empty instance; `minRunner` stays the bar for the default instance.
   */
  minRunnerForInstance?: string;
  /** The `integrationsVersion` a runner must announce. */
  minIntegrationsVersion: number;
}

export const INTEGRATIONS_REGISTRY_VERSION = 1;
const MIN_RUNNER = '0.1.11';

const tokenField = (label: string, help?: string): IntegrationField => ({
  key: 'token',
  label,
  type: 'secret',
  required: true,
  maxLength: 4000,
  ...(help ? { help } : {}),
});

export const INTEGRATION_KINDS: readonly IntegrationKind[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    group: 'ai',
    instances: { by: 'account', label: 'Account', placeholder: 'work', defaultInstance: '' },
    scope: 'mixed',
    machineMethods: ['default_login', 'claude_login'],
    methods: [
      {
        id: 'claude_login',
        label: 'Sign in with your Claude subscription',
        flow: 'interactive',
        paste: 'code',
        steps: [
          { text: 'Open the sign-in link and sign in to the Claude account for this key.' },
          { text: 'Copy the code the page shows and paste it here.' },
          {
            text: "The login is stored in this account's own Claude folder on the workstation (e.g. ~/.claude-gw-work).",
          },
        ],
      },
      {
        id: 'setup_token',
        label: 'Sign in with your Claude subscription (1-year token)',
        flow: 'interactive',
        paste: 'code',
        steps: [
          { text: 'Open the sign-in link and sign in to claude.ai.' },
          { text: 'Copy the code the Anthropic page shows and paste it here.' },
          {
            text: 'The workstation keeps the 1-year token it receives. It never leaves that machine.',
          },
        ],
        expiry: 'The token lasts about one year.',
        warning:
          'A Claude subscription is for individual use. This moves the workstation to token mode: agents no longer depend on the refresh token of ~/.claude.',
      },
      {
        id: 'api_key',
        label: 'Anthropic API key',
        flow: 'fields',
        fields: [{ ...tokenField('API key'), key: 'apiKey', placeholder: 'sk-ant-api03-...' }],
        steps: [
          {
            text: 'Create a key in the Anthropic Console.',
            link: {
              href: 'https://console.anthropic.com/settings/keys',
              label: 'Anthropic Console, API keys',
            },
          },
          { text: 'Paste it here. Usage is billed to your API account.' },
        ],
        warning: 'Recommended for cloud workstations.',
      },
      {
        id: 'oauth_token',
        label: 'A token made elsewhere (claude setup-token)',
        flow: 'fields',
        fields: [{ ...tokenField('OAuth token'), key: 'oauthToken', placeholder: 'sk-ant-oat01-...' }],
        steps: [
          { text: 'On any machine with Claude Code run `claude setup-token` and copy the token it prints.' },
          { text: 'Paste it here.' },
        ],
        expiry: 'The token lasts about one year.',
      },
      {
        id: 'default_login',
        label: "The machine's own Claude login (claude auth login)",
        flow: 'interactive',
        paste: 'code',
        phase: 2,
        steps: [{ text: 'Later: signs in the machine-wide ~/.claude login from the web.' }],
      },
    ],
    help: {
      summary: 'The model login the agents on this workstation use.',
      docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
    },
    test: { label: 'Check the login', what: 'Asks `claude auth status`, then makes one minimal call.' },
    storage:
      'secrets/claude.json (mode 0600), this workstation only. The default login is ~/.claude/.credentials.json.',
    cli: 'aom-runner auth oauth-token',
    minRunner: MIN_RUNNER,
    minRunnerForInstance: '0.1.33',
    minIntegrationsVersion: 1,
  },
  {
    id: 'github',
    label: 'GitHub',
    group: 'git',
    instances: { by: 'host', label: 'Host', placeholder: 'github.com', defaultInstance: 'github.com' },
    scope: 'machine',
    methods: [
      {
        id: 'device',
        label: 'Sign in with a code (GitHub CLI)',
        flow: 'interactive',
        paste: 'none',
        steps: [
          { text: 'Open the link and enter the code shown here.' },
          { text: 'Approve the sign-in. The workstation finishes by itself.' },
        ],
      },
      {
        id: 'token',
        label: 'Personal access token',
        flow: 'fields',
        fields: [tokenField('Classic personal access token', 'Starts with ghp_')],
        scopes: [
          { name: 'repo', why: 'clone, push and open pull requests', required: true },
          { name: 'read:org', why: 'list organization repositories', required: true },
          { name: 'gist', why: 'required by the GitHub CLI', required: false },
        ],
        steps: [
          {
            text: 'Create a classic token with these scopes.',
            link: {
              href: 'https://github.com/settings/tokens/new?scopes=repo,read:org,gist',
              label: 'GitHub, new token',
            },
          },
          { text: 'Paste it here. It is handed to the GitHub CLI on the workstation.' },
        ],
        warning: 'A fine-grained token may lack scopes the GitHub CLI wants.',
      },
    ],
    help: { summary: 'The GitHub CLI login of this machine. It is shared by every pairing on the machine.' },
    test: { label: 'Ask GitHub who you are', what: 'Runs `gh api user` and reads the token scopes.' },
    storage: "The GitHub CLI's own store (keyring or ~/.config/gh), shared by every pairing on this machine.",
    cli: 'aom-runner git-connect github --host {instance}',
    minRunner: MIN_RUNNER,
    minIntegrationsVersion: 1,
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    group: 'git',
    instances: { by: 'host', label: 'Host', placeholder: 'gitlab.com', defaultInstance: 'gitlab.com' },
    scope: 'mixed',
    machineMethods: ['cli_web'],
    methods: [
      {
        id: 'token',
        label: 'Personal access token',
        flow: 'fields',
        fields: [tokenField('Personal access token', 'Starts with glpat-')],
        scopes: [
          { name: 'api', why: 'repositories, merge requests and branch rules', required: true },
          { name: 'write_repository', why: 'push branches', required: true },
        ],
        steps: [
          {
            text: 'Create a token with these scopes (the link fills them in for gitlab.com).',
            link: {
              href: 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Guildwise&scopes=api,write_repository',
              label: 'GitLab, new token',
            },
          },
          { text: 'Paste it here. It is kept on this workstation only.' },
        ],
        expiry: 'GitLab tokens expire; the expiry is shown when GitLab reports it.',
      },
      {
        id: 'cli_web',
        label: 'GitLab CLI (glab auth login)',
        flow: 'local_only',
        steps: [
          {
            text: 'glab signs in through a callback on localhost, so it only works when the browser runs on the workstation itself. Run `glab auth login` there.',
          },
        ],
      },
    ],
    help: { summary: 'Your GitLab account (gitlab.com or self-managed).' },
    test: { label: 'Ask GitLab who you are', what: 'GET /api/v4/user and personal_access_tokens/self.' },
    storage: 'secrets/git-tokens.json (mode 0600), this workstation only.',
    cli: 'aom-runner git-connect gitlab --host {instance}',
    minRunner: MIN_RUNNER,
    minIntegrationsVersion: 1,
  },
  {
    id: 'bitbucket-cloud',
    label: 'Bitbucket Cloud',
    group: 'git',
    instances: 'single',
    scope: 'workstation',
    methods: [
      {
        id: 'token',
        label: 'Atlassian API token with scopes',
        flow: 'fields',
        fields: [
          {
            key: 'email',
            label: 'Atlassian e-mail address',
            type: 'email',
            required: true,
            maxLength: 200,
            placeholder: 'you@company.com',
          },
          tokenField('API token'),
        ],
        scopes: [
          { name: 'read:user:bitbucket', why: 'who you are', required: true },
          { name: 'read:repository:bitbucket', why: 'clone and list', required: true },
          { name: 'write:repository:bitbucket', why: 'push branches', required: true },
          { name: 'read:pullrequest:bitbucket', why: 'read pull requests', required: true },
          { name: 'write:pullrequest:bitbucket', why: 'open pull requests', required: true },
        ],
        steps: [
          {
            text: 'Create an API token with scopes (Bitbucket app) with the scopes below.',
            link: {
              href: 'https://id.atlassian.com/manage-profile/security/api-tokens',
              label: 'Atlassian, API tokens',
            },
          },
          { text: 'Enter your Atlassian e-mail address and paste the token.' },
        ],
        warning: 'App passwords stopped working on 2026-06-09.',
        expiry: 'Atlassian API tokens expire after at most one year.',
      },
    ],
    help: { summary: 'Bitbucket Cloud only signs in with an API token.' },
    test: { label: 'Ask Bitbucket who you are', what: 'GET /2.0/user, then one repository call.' },
    storage: 'secrets/git-tokens.json (mode 0600), this workstation only.',
    cli: 'aom-runner git-connect bitbucket-cloud',
    minRunner: MIN_RUNNER,
    minIntegrationsVersion: 1,
  },
  {
    id: 'azure-devops',
    label: 'Azure DevOps',
    group: 'git',
    instances: { by: 'organization', label: 'Organization', placeholder: 'your-organization' },
    scope: 'mixed',
    machineMethods: ['device'],
    methods: [
      {
        id: 'token',
        label: 'Personal access token (organization-scoped)',
        flow: 'fields',
        fields: [tokenField('Personal access token')],
        scopes: [
          { name: 'Code: Read & write', why: 'clone, push and pull requests', required: true },
          { name: 'Project and Team: Read', why: 'list projects', required: true },
        ],
        steps: [
          {
            text: 'Create an organization-scoped token (global tokens stop working on 2026-12-01).',
            link: {
              href: 'https://dev.azure.com/',
              label: 'Azure DevOps, User settings, Personal access tokens',
            },
          },
          { text: 'Paste it here.' },
        ],
        expiry: 'Azure DevOps tokens expire; check the date you chose.',
      },
      {
        id: 'device',
        label: 'Azure CLI (az login --use-device-code)',
        flow: 'interactive',
        paste: 'none',
        phase: 2,
        steps: [{ text: 'Later: sign in with a device code from the web.' }],
      },
      {
        id: 'service_principal',
        label: 'Microsoft Entra service principal',
        flow: 'local_only',
        steps: [
          {
            text: 'On the workstation set AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET (or AZURE_FEDERATED_TOKEN_FILE) for the runner, then Test.',
          },
        ],
      },
    ],
    help: { summary: 'Azure DevOps repositories, per organization.' },
    test: { label: 'Ask Azure DevOps who you are', what: 'GET _apis/connectionData.' },
    storage: 'secrets/git-tokens.json (mode 0600), this workstation only.',
    cli: 'aom-runner git-connect azure-devops --organization {instance}',
    minRunner: MIN_RUNNER,
    minIntegrationsVersion: 1,
  },
  {
    id: 'ssh',
    label: 'SSH keys',
    group: 'git',
    instances: {
      by: 'provider-host',
      label: 'Provider and host',
      placeholder: 'github@github.com',
    },
    scope: 'machine',
    methods: [
      {
        id: 'ssh_key',
        label: 'Create a key and add its public half to the git host',
        flow: 'local_only',
        steps: [
          {
            text: 'Manage SSH keys from Workstations, Git hosts, or run `aom-runner git-connect <provider> --ssh-key` on the workstation.',
          },
        ],
      },
    ],
    help: {
      summary: 'SSH access for git (clone, fetch, push). Pull requests still need the token or CLI login.',
    },
    test: { label: 'Check SSH', what: 'Runs `ssh -T` or `git ls-remote`.' },
    storage: '~/.ssh/aom_<provider> and secrets/git-ssh.json. The private key never leaves the workstation.',
    cli: 'aom-runner git-connect {provider} --ssh-key',
    minRunner: MIN_RUNNER,
    minIntegrationsVersion: 1,
  },
  {
    id: 'jira',
    label: 'Jira',
    group: 'tracker',
    instances: 'single',
    scope: 'workstation',
    methods: [
      {
        id: 'token',
        label: 'API token',
        flow: 'fields',
        fields: [
          {
            key: 'baseUrl',
            label: 'Jira base URL',
            type: 'url',
            required: true,
            maxLength: 300,
            placeholder: 'https://yourcompany.atlassian.net',
          },
          {
            key: 'email',
            label: 'Atlassian e-mail address',
            type: 'email',
            required: false,
            maxLength: 200,
            help: 'Leave empty for a Jira Data Center personal access token.',
          },
          tokenField('API token'),
        ],
        steps: [
          {
            text: 'Create a classic API token ("Create API token", not "with scopes").',
            link: {
              href: 'https://id.atlassian.com/manage-profile/security/api-tokens',
              label: 'Atlassian, API tokens',
            },
          },
          { text: 'Jira Data Center: leave the e-mail empty and use a personal access token.' },
        ],
        expiry: 'Atlassian API tokens expire after at most one year.',
      },
    ],
    help: { summary: 'Reads tickets and posts approved updates with your own account.' },
    test: { label: 'Ask Jira who you are', what: 'GET /rest/api/2/myself.' },
    storage: 'secrets/jira.json (mode 0600), this workstation only.',
    cli: 'aom-runner jira-connect',
    minRunner: MIN_RUNNER,
    minIntegrationsVersion: 1,
  },
  {
    id: 'mcp',
    label: 'MCP servers',
    group: 'mcp',
    instances: {
      by: 'server',
      label: 'Server',
      placeholder: 'plugin_atlassian_atlassian',
    },
    scope: 'machine',
    methods: [
      {
        id: 'oauth_paste',
        label: 'Sign in through your browser',
        flow: 'interactive',
        paste: 'redirect_url',
        steps: [
          { text: 'Open the sign-in link and sign in with the provider.' },
          {
            text: 'The provider sends you to a localhost address. If this browser is not on the workstation that page will not load: that is expected. Copy the whole address from the address bar and paste it here.',
          },
        ],
        warning: 'The sign-in is shared by every pairing on the machine (it lives in ~/.claude).',
      },
    ],
    help: {
      summary: 'Servers that come with Claude Code plugins. Sign-ins are kept by Claude Code itself.',
      notes: [
        'Claude.ai connectors and servers you added by hand are not shown here.',
        'A provider that cannot redirect to localhost needs: on the workstation run `claude`, `/mcp`, Authenticate.',
      ],
    },
    test: { label: 'Check the sign-in', what: 'Looks for a stored sign-in (the same check agents use).' },
    storage:
      "~/.claude/.credentials.json (Claude Code's own store), shared by every pairing on this machine.",
    cli: 'claude mcp login <server> --no-browser',
    minRunner: MIN_RUNNER,
    minIntegrationsVersion: 1,
  },
] as const;

const BY_ID = new Map<string, IntegrationKind>(INTEGRATION_KINDS.map((k) => [k.id, k]));

export const integrationKind = (id: string): IntegrationKind | undefined => BY_ID.get(id);

export const integrationMethod = (kind: IntegrationKind, method: string): IntegrationMethod | undefined =>
  kind.methods.find((m) => m.id === method);

/** The scope of a (kind, method) pair. */
export function integrationScope(kind: IntegrationKind, method?: string): IntegrationScope {
  if (kind.scope !== 'mixed') return kind.scope;
  return method && kind.machineMethods?.includes(method) ? 'machine' : 'workstation';
}

/** Is this instance name valid for the kind? ('' only for single-instance kinds.) */
export function validIntegrationInstance(kind: IntegrationKind, instance: string): boolean {
  if (kind.instances === 'single') return instance === '';
  if (kind.instances.by === 'account') return instance === '' || ACCOUNT_KEY_RE.test(instance);
  return INTEGRATION_INSTANCE_RE.test(instance);
}

/** The CLI line of a kind with the instance filled in. */
export function integrationCli(kind: IntegrationKind, instance: string): string {
  const provider = instance.includes('@') ? (instance.split('@')[0] as string) : instance;
  return kind.cli
    .replace('{instance}', instance || '')
    .replace('{provider}', provider)
    .trim();
}

/**
 * Why a connect request is invalid, or null. Checks the method exists, is offered now (not a later phase), matches the
 * route (`fields` for connect, `interactive` for sessions), and that a `fields` payload names only known fields.
 */
export function checkIntegrationRequest(
  kindId: string,
  instance: string,
  methodId: string,
  flow: 'fields' | 'interactive',
): string | null {
  const kind = integrationKind(kindId);
  if (!kind) return 'unknown integration';
  if (!validIntegrationInstance(kind, instance)) return 'invalid instance for this integration';
  const method = integrationMethod(kind, methodId);
  if (!method) return 'unknown method';
  if (method.phase) return 'this method is not available yet';
  if (methodId === 'claude_login' && instance === '') return 'sign in needs an account key';
  if (method.flow !== flow) return `this method is not a ${flow} method`;
  return null;
}

/** The kinds a given runner can connect from the web (by the version it announced). */
export const integrationsSupportedBy = (version: number | null | undefined, kind: IntegrationKind): boolean =>
  typeof version === 'number' && version >= kind.minIntegrationsVersion;

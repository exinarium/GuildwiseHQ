import { normalizeRemoteUrl, urlHasPassword } from '@aom/shared';
import type { Policy } from '../policy/schema.ts';
import type { RepoOffer, SetupOffer } from './offers.ts';
import { type DockerMode, SetupError, type SetupOptions } from './options.ts';

/**
 * The installer's one screen of choices (easy-runner-setup), as a pure model: the items, their safe defaults, the edits,
 * and how names map to ids. `screen.ts` renders it and reads the edits; `setup.ts` writes the result to policy.json.
 *
 * [S4] The screen starts from the current policy: "No" and "Ask me first" apply only to what the policy does not hold
 * yet. `--yes` never revokes a grant; only an explicit flag (`--devops-orgs none`) or an edit removes one.
 */

export interface OrgItem {
  key: string;
  orgId: string;
  orgName: string;
  role: string;
  agentId?: string;
  agentName?: string;
  /** A grant the policy holds for an organisation the server no longer offers: kept unless edited away. */
  notOffered?: boolean;
  /**
   * UAT 1.10.0 finding 2: the policy granted this organisation's helper under an agent id the server no longer reports
   * for this workstation (a new workstation or a newly hired DevOps engineer). The item carries the CURRENT agent id from
   * the offers; this is the stale one it replaces when the grant is written.
   */
  replaces?: string;
  allow: boolean;
}

export interface RepoItem {
  key: string;
  /** The normalized form policy.json keys on (github.com/owner/repo). */
  id: string;
  name: string;
  allow: boolean;
}

export interface Choices {
  orgs: OrgItem[];
  devopsRequests: 'ask' | 'auto';
  docker: DockerMode;
  dockerOptions: DockerMode[];
  deploy: 'ask' | 'off';
  repos: RepoItem[];
  ytdlp: boolean;
  /**
   * Item 7 (UAT 1.10.0 finding 3): may the DevOps helpers install the tools projects need? Safe default No. Written to
   * the policy only when it was chosen (here or before), so a re-run never turns off a switch set on the website.
   */
  devopsInstall: boolean;
  devopsInstallChosen: boolean;
}

export interface ChoicesInput {
  current: Policy;
  orgs: readonly SetupOffer[];
  repos: readonly RepoOffer[];
  opts: SetupOptions;
  platform: NodeJS.Platform;
  /** A person answers at the keyboard (the macOS Docker Desktop default needs their typed acceptance). */
  interactive?: boolean;
}

const letter = (i: number): string =>
  i < 26 ? String.fromCharCode(97 + i) : `${letter(Math.floor(i / 26) - 1)}${letter(i % 26)}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `--devops-orgs` entries (exact names, case-insensitive, or ids) -> offered organisations. An unknown or ambiguous name,
 * or an organisation without a DevOps helper on this workstation, stops the install.
 */
export function resolveOrgs(spec: readonly string[], offers: readonly SetupOffer[]): SetupOffer[] {
  const out: SetupOffer[] = [];
  for (const raw of spec) {
    const s = raw.trim();
    const hits = UUID_RE.test(s)
      ? offers.filter((o) => o.orgId.toLowerCase() === s.toLowerCase())
      : offers.filter((o) => o.orgName.toLowerCase() === s.toLowerCase());
    if (hits.length === 0)
      throw new SetupError(
        `organization ${JSON.stringify(s)} is not one the server offers for this workstation (names: ${offers.map((o) => o.orgName).join(', ') || 'none'})`,
      );
    if (hits.length > 1)
      throw new SetupError(
        `more than one organization is called ${JSON.stringify(s)}: use its id instead (${hits.map((o) => o.orgId).join(', ')})`,
      );
    const o = hits[0] as SetupOffer;
    if (!o.devopsAgentId)
      throw new SetupError(
        `${o.orgName} (${o.orgId}) has no DevOps engineer on this workstation yet: hire one, then run setup again (or \`guildwise-runner devops grant ${o.orgId}\`)`,
      );
    if (!out.some((x) => x.orgId === o.orgId)) out.push(o);
  }
  return out;
}

/** `--allow-scripts` entries must be offered repositories (by URL or name). Returns their normalized ids. */
export function resolveRepos(spec: readonly string[], offers: readonly RepoOffer[]): string[] {
  return spec.map((raw) => {
    const s = raw.trim();
    // never echoed: the error must not print the password back
    if (urlHasPassword(s))
      throw new SetupError(
        '--allow-scripts: a repository address with a password is refused; give it without one',
      );
    let id: string | null = null;
    try {
      id = normalizeRemoteUrl(s);
    } catch {
      id = null;
    }
    const hit = offers.find(
      (r) => (id && safeNormalize(r.url) === id) || r.name.toLowerCase() === s.toLowerCase(),
    );
    if (!hit)
      throw new SetupError(
        `--allow-scripts ${JSON.stringify(s)} is not a repository of a project this workstation works for`,
      );
    return safeNormalize(hit.url) ?? hit.url;
  });
}

function safeNormalize(url: string): string | null {
  try {
    return normalizeRemoteUrl(url);
  } catch {
    return null;
  }
}

/** The Docker modes item 3 offers on this platform. */
export function dockerOptionsFor(platform: NodeJS.Platform, opts: SetupOptions): DockerMode[] {
  if (platform === 'win32') return ['none'];
  if (platform === 'darwin')
    return opts.dockerFound === 'desktop' || opts.dockerSocket ? ['none', 'host'] : ['none'];
  const o: DockerMode[] = ['rootless', 'none', 'host'];
  if (opts.dockerFound === 'shared' && opts.dockerSocket) o.push('shared');
  return o;
}

function dockerDefault(input: ChoicesInput, options: readonly DockerMode[]): DockerMode {
  const { opts, current, platform } = input;
  if (opts.docker) return opts.docker;
  // [S4] a re-run keeps what this machine already chose
  if (current.setupDone && options.includes(current.docker)) return current.docker;
  // Owner 2026-11-21: "If mac cannot run rootless docker, and we detect docker on mac then we use that docker setup".
  // Still guarded: choosing it asks for the typed "root-equivalent" after the /Users warning; declining gives none.
  if (
    platform === 'darwin' &&
    input.interactive &&
    opts.dockerFound === 'desktop' &&
    options.includes('host')
  )
    return 'host';
  return platform === 'linux' || platform === 'freebsd' ? 'rootless' : 'none';
}

/** The screen's starting point: the current policy, then the flags, then the safe defaults. */
export function initialChoices(input: ChoicesInput): Choices {
  const { current, opts } = input;
  // item 1: organisations
  const explicit =
    opts.devopsOrgs === undefined
      ? null
      : opts.devopsOrgs === 'none'
        ? []
        : resolveOrgs(opts.devopsOrgs, input.orgs);
  const orgs: OrgItem[] = input.orgs.map((o) => {
    const held = current.devops.agents[o.orgId];
    const allow = explicit ? explicit.some((x) => x.orgId === o.orgId) : !!held;
    // the organisation's helper as the server reports it NOW; a grant for another agent id is stale and is replaced
    const agentId = o.devopsAgentId ?? held;
    const stale = !!held && !!o.devopsAgentId && held !== o.devopsAgentId;
    return {
      key: '',
      orgId: o.orgId,
      orgName: o.orgName,
      role: o.role,
      ...(agentId ? { agentId } : {}),
      ...(stale ? { replaces: held } : {}),
      ...(o.devopsAgentName && agentId === o.devopsAgentId ? { agentName: o.devopsAgentName } : {}),
      allow,
    };
  });
  for (const [orgId, agentId] of Object.entries(current.devops.agents))
    if (!orgs.some((o) => o.orgId === orgId))
      orgs.push({
        key: '',
        orgId,
        orgName: `organization ${orgId.slice(0, 8)}`,
        role: 'unknown',
        agentId,
        notOffered: true,
        allow: explicit === null,
      });
  orgs.forEach((o, i) => {
    o.key = `1${letter(i)}`;
  });
  // item 5: install scripts per offered repository
  const extra = opts.allowScripts ? resolveRepos(opts.allowScripts, input.repos) : [];
  const repos: RepoItem[] = [];
  for (const r of input.repos) {
    const id = safeNormalize(r.url);
    if (!id || repos.some((x) => x.id === id)) continue;
    repos.push({
      key: '',
      id,
      name: r.name,
      allow: current.installScripts[id] === true || extra.includes(id),
    });
  }
  repos.forEach((r, i) => {
    r.key = `5${letter(i)}`;
  });
  const dockerOptions = dockerOptionsFor(input.platform, opts);
  return {
    orgs,
    devopsRequests: opts.devopsRequests ?? current.devopsRequests,
    docker: dockerDefault(input, dockerOptions),
    dockerOptions,
    deploy: opts.deploy ?? current.deploy,
    repos,
    ytdlp: opts.withYtdlp ?? true,
    devopsInstall: current.devopsInstall ?? false,
    devopsInstallChosen: current.devopsInstall !== undefined,
  };
}

/** The keys a person may type on the screen. Items 1 and 5 are hidden when nothing is offered. */
export function editableKeys(c: Choices): string[] {
  return [
    ...c.orgs.filter((o) => o.agentId).map((o) => o.key),
    '2',
    ...(c.dockerOptions.length > 1 ? ['3'] : []),
    '4',
    ...c.repos.map((r) => r.key),
    '6',
    '7',
  ];
}

/** Applies one edit (pure). An organisation without a helper cannot be chosen. */
export function applyEdit(c: Choices, key: string, value: boolean | string): Choices {
  const next: Choices = structuredClone(c);
  const org = next.orgs.find((o) => o.key === key);
  if (org) {
    if (!org.agentId) throw new SetupError(`${org.orgName} has no DevOps helper on this workstation yet`);
    org.allow = value === true;
    return next;
  }
  const repo = next.repos.find((r) => r.key === key);
  if (repo) {
    repo.allow = value === true;
    return next;
  }
  if (key === '2' && (value === 'ask' || value === 'auto')) next.devopsRequests = value;
  else if (key === '3' && typeof value === 'string' && (next.dockerOptions as string[]).includes(value))
    next.docker = value as DockerMode;
  else if (key === '4' && (value === 'ask' || value === 'off')) next.deploy = value;
  else if (key === '6' && typeof value === 'boolean') next.ytdlp = value;
  else if (key === '7' && typeof value === 'boolean') {
    next.devopsInstall = value;
    next.devopsInstallChosen = true;
  } else throw new SetupError(`not an item on this screen: ${key}`);
  return next;
}

/** The grants the choices move from a stale agent id to the current one (for the log and the summary). */
export function replacedGrants(
  c: Choices,
): Array<{ orgId: string; orgName: string; from: string; to: string; agentName?: string }> {
  return c.orgs
    .filter((o) => o.allow && o.agentId && o.replaces)
    .map((o) => ({
      orgId: o.orgId,
      orgName: o.orgName,
      from: o.replaces as string,
      to: o.agentId as string,
      ...(o.agentName ? { agentName: o.agentName } : {}),
    }));
}

/** Writes items 1, 2, 4 and 5 into the next policy (item 3 goes through the Docker step, item 6 runs the install). */
export function applyChoices(c: Choices, next: Policy): void {
  const agents: Record<string, string> = {};
  for (const o of c.orgs) if (o.allow && o.agentId) agents[o.orgId] = o.agentId;
  next.devops = { ...next.devops, agents };
  next.devopsRequests = c.devopsRequests;
  next.deploy = c.deploy;
  if (c.devopsInstallChosen) next.devopsInstall = c.devopsInstall;
  const scripts = { ...next.installScripts };
  for (const r of c.repos) {
    if (r.allow) scripts[r.id] = true;
    else delete scripts[r.id];
  }
  next.installScripts = scripts;
}

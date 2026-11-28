import {
  type DeployExecPayload,
  DeployExecPayloadSchema,
  type DevOpsAccess,
  type EnvEnsurePayload,
  EnvEnsurePayloadSchema,
  normalizeRemoteUrl,
  ReleasePreparePayloadSchema,
  type ReleaseSignPayload,
  ReleaseSignPayloadSchema,
  redactUrlPassword,
} from '@aom/shared';
import { canonicalJson, deployPinHashes, sha256Hex } from './deploy-pin.ts';
import type { Policy } from './schema.ts';

/**
 * The runner's decision for a privileged server command (R18-S), kept pure so every rule is a unit test: run it now,
 * hold it for a local approval, or refuse it. The server can request, narrow or revoke; nothing it sends widens what
 * policy.json allows.
 */
export type GateDecision =
  /** `toolsOnly` (quiet-approvals [D3]): only the checksum-verified tool downloads run, nothing else. */
  | { action: 'run'; toolsOnly?: boolean }
  | {
      action: 'hold';
      kind: string;
      summary: string;
      detail: string;
      commandHash: string;
      pin?: { base: string; bound: string | null };
      note?: string;
    }
  | { action: 'refuse'; reason: string };

/** Commands that always wait for a local yes (R18-S "Held until a local approval"). */
export const ALWAYS_HELD: Readonly<Record<string, string>> = {
  'recipe.write': 'recipe.write',
  'env.secret.set': 'env.secret',
  'deploy.secret.set': 'env.secret',
  'provider.key.reseal': 'provider.reseal',
  // the private-endpoint allow-list widens where provider keys and webhooks may go (R18-L): local only
  'provider.endpoints.set': 'provider.endpoints',
};

export const SETUP_PENDING_NOTE = 'setup pending: run `guildwise-runner setup` on the workstation first';

/** "Setup pending" [R20, Q13]: until a local `setup`, unsandboxed paths are held even when a pin or autoSign would run them. */
export const setupPending = (p: Policy): boolean => !p.setupDone;

const line = (label: string, value: unknown): string =>
  `  ${label.padEnd(14)} ${value === null || value === undefined || value === '' ? '-' : String(value)}`;

export const commandHashOf = (command: string, payload: unknown): string =>
  sha256Hex(canonicalJson({ command, payload }));

function describeDeploy(p: DeployExecPayload, hashes: { base: string; bound: string | null }): string {
  return [
    `deploy ${p.dryRun ? '(dry run) ' : p.trial ? '(trial) ' : ''}of project ${p.projectKey} (${p.projectId})`,
    line('environment', p.env),
    line('target', `${p.target.name} (${p.target.kind})`),
    line('host', p.target.host),
    line('app url', p.target.appUrl),
    line('repository', p.repo ? `${p.repo.name} ${p.repo.remoteUrlNormalized}` : null),
    line('branch', p.repo?.workingBranch),
    line('commit', p.commit ?? '(the branch head at run time)'),
    line('recipe hash', p.hash),
    line('vault', `${p.vault.vaultId}${p.vaultCommit ? ` at ${p.vaultCommit}` : ''}`),
    line('pin hash', hashes.base),
    ...(hashes.bound ? [line('pin + commit', hashes.bound)] : []),
  ].join('\n');
}

function describeGeneric(command: string, payload: Record<string, unknown>): string {
  // Values that are or may be secret are shown by name only.
  const masked = JSON.parse(
    JSON.stringify(payload, (k, v) =>
      /secret|sealed|ciphertext|value|password|token|key$/i.test(k) && typeof v === 'string'
        ? `<${v.length} characters, not shown>`
        : v,
    ),
  );
  // an address that carries a password is shown with *** in its place
  return redactUrlPassword(`${command}\n${JSON.stringify(masked, null, 2)}`);
}

/**
 * Rework 1 (REVIEW S3): text from the server shown in the log, the CLI and the approvals page, without control
 * characters (ANSI escapes) or bidi overrides (the set `PlainNameSchema` refuses), so a name cannot reorder or recolour
 * what the person reads before saying yes.
 */
export function plainText(s: string): string {
  return s.replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, '');
}

/**
 * Rework 2: the same for the multi-line approval text (`detail`, shown in `<pre>` and by `approve`): line breaks and tabs
 * stay, every other control character and every bidi override goes.
 */
export function plainDetail(s: string): string {
  return s.replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, (c) =>
    c === '\n' || c === '\t' ? c : '',
  );
}

/**
 * What a held command is about, for its one-line summary (the log line and `guildwise-runner approvals`). Each command
 * names its own target; nothing secret (a sealed value is never named). Never empty: `vault.configure` carries a list of
 * vaults, not one id, and showed "vault.configure for  (...)" (UAT 1.10.0 bug 4).
 */
export function heldTarget(command: string, payload: Record<string, unknown>): string {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && plainText(v).trim() ? plainText(v).trim() : undefined;
  if (command === 'vault.configure') {
    const vaults = Array.isArray(payload.vaults) ? (payload.vaults as Array<Record<string, unknown>>) : [];
    const names = vaults.map((v) => str(v?.name) ?? str(v?.vaultId) ?? '?');
    const shown = names.slice(0, 5).join(', ');
    const more = names.length > 5 ? ` and ${names.length - 5} more` : '';
    const resume =
      Array.isArray(payload.resume) && payload.resume.length ? `, resume ${payload.resume.length}` : '';
    return vaults.length
      ? `${vaults.length} vault${vaults.length === 1 ? '' : 's'} (${shown}${more})${resume}`
      : `no vaults (stop syncing every vault)${resume}`;
  }
  if (command === 'provider.key.reseal')
    return `the ${str(payload.provider) ?? 'provider'} key of organization ${str(payload.orgId) ?? '?'}${str(payload.targetKeyId) ? ` to runner key ${str(payload.targetKeyId)}` : ''}`;
  if (command === 'provider.endpoints.set') {
    const n = Array.isArray(payload.endpoints) ? payload.endpoints.length : 0;
    return `${n} private endpoint${n === 1 ? '' : 's'}`;
  }
  if (command === 'env.secret.set')
    return `secret ${str(payload.name) ?? '?'} of environment target ${str(payload.targetId) ?? '?'}`;
  if (command === 'deploy.secret.set')
    return `secret ${str(payload.name) ?? '?'} of project ${str(payload.projectId) ?? '?'}`;
  return str(payload.projectId) ?? str(payload.vaultId) ?? str(payload.name) ?? '(no target named)';
}

function describeRecipeWrite(payload: Record<string, unknown>): string {
  const files = Array.isArray(payload.files)
    ? (payload.files as { path: string; mode: string; content: string }[])
    : [];
  const parts = [
    `recipe write for project ${String(payload.projectId)}: ${String(payload.commitMessage ?? '')}`,
    line('expected hash', payload.expectedHash),
    line('keep', Array.isArray(payload.keep) ? (payload.keep as string[]).join(', ') : ''),
  ];
  for (const f of files) parts.push('', `--- ${f.path} (mode ${f.mode})`, f.content);
  return parts.join('\n');
}

export function gateDeploy(policy: Policy, payload: unknown): GateDecision {
  const parsed = DeployExecPayloadSchema.safeParse(payload);
  if (!parsed.success) return { action: 'refuse', reason: 'malformed deploy.exec payload' };
  const p = parsed.data;
  if (policy.deploy === 'off')
    return { action: 'refuse', reason: 'deploys are off on this workstation (policy.json deploy: "off")' };
  const hashes = deployPinHashes(p);
  const pinned = policy.deployPinCommit
    ? !!hashes.bound && policy.deployPins.includes(hashes.bound)
    : policy.deployPins.includes(hashes.base);
  const pending = setupPending(policy);
  if (pinned && !pending) return { action: 'run' };
  // A pinned command that changed only its commit (deployPinCommit on): the routine kind a passkey may approve (R22).
  const commitOnly =
    policy.deployPinCommit && !!hashes.bound && policy.deployPins.includes(hashes.base) && !pinned;
  return {
    action: 'hold',
    kind: commitOnly ? 'deploy.commit_redeploy' : 'deploy.exec',
    summary: `deploy ${p.env} -> ${p.target.name}${p.commit ? ` at ${p.commit.slice(0, 12)}` : ''}${p.dryRun ? ' (dry run)' : p.trial ? ' (trial)' : ''}${commitOnly ? ' (pinned, new commit)' : ''}`,
    detail: describeDeploy(p, hashes),
    commandHash: policy.deployPinCommit && hashes.bound ? hashes.bound : hashes.base,
    pin: hashes,
    ...(pending ? { note: SETUP_PENDING_NOTE } : {}),
  };
}

export function gateReleaseSign(policy: Policy, payload: unknown): GateDecision {
  const parsed = ReleaseSignPayloadSchema.safeParse(payload);
  if (!parsed.success) return { action: 'refuse', reason: 'malformed release.sign payload' };
  const p: ReleaseSignPayload = parsed.data;
  const key = policy.signingKeys.find((k) => k.keyId === p.keyId);
  if (!key)
    return {
      action: 'refuse',
      reason: `this workstation holds no signing key ${p.keyId} (guildwise-runner signing add-key --key-id ${p.keyId} --key-file <path>)`,
    };
  if (key.autoSign && !setupPending(policy)) return { action: 'run' };
  return {
    action: 'hold',
    kind: 'release.sign',
    summary: `sign ${p.projectName} ${p.version} for ${p.targetName} with key ${p.keyId}`,
    detail: [
      `release signing (R30)`,
      line('project', p.projectName),
      line('release', p.releaseId),
      line('target', `${p.targetName} (${p.targetId})`),
      line('version', p.version),
      line('artefact', p.artefact),
      line('sha256', p.artefactSha256),
      line('key id', p.keyId),
      line('key file', key.keyFile),
    ].join('\n'),
    commandHash: commandHashOf('release.sign', p),
    ...(setupPending(policy) ? { note: SETUP_PENDING_NOTE } : {}),
  };
}

/**
 * `env.ensure` (R18-S, R18-L): Docker is narrowed to what policy.json grants (never widened) and sudo is always off (removed
 * in 1.10.0: nothing on the runner runs as root); a request for
 * installs or extra paths is a widening of access and waits for a local yes.
 */
export function narrowAccess(
  policy: Policy,
  access: DevOpsAccess,
  /** quiet-approvals R5-B1: checks a requested folder against the local ceiling (absent: no folder passes). */
  folderOk: (path: string, roots: readonly string[]) => boolean = () => false,
  /**
   * gate-fixes-1 F3: how this session would reach Docker. `proxy` (a DevOps request shift: the outer box, only through the
   * runner's filtering gatekeeper): the server switch AND `ceiling.docker`. `direct` (everything else: chat, release prep,
   * the unboxed fallback, which would reach the real daemon): also the legacy local `allowDocker` (R18-L).
   */
  docker: 'direct' | 'proxy' = 'direct',
): DevOpsAccess {
  const roots = policy.ceiling.mountRoots;
  return {
    ...access,
    sudo: false,
    // quiet-approvals phase B: the local ceiling caps what any Desk click (a server switch) can give
    allowDocker: access.allowDocker && policy.ceiling.docker && (docker === 'proxy' || policy.allowDocker),
    allowedPaths: roots.length ? access.allowedPaths.filter((p) => folderOk(p, roots)) : [],
  };
}

/** quiet-approvals phase B: what a server switch asks beyond the local ceiling ("needs a change on your computer"). */
export function beyondCeiling(
  policy: Policy,
  access: DevOpsAccess,
  folderOk: (path: string, roots: readonly string[]) => boolean = () => false,
): string[] {
  const out: string[] = [];
  if (access.allowDocker && !policy.ceiling.docker) out.push('Docker');
  const n = narrowAccess(policy, access, folderOk);
  for (const p of access.allowedPaths) if (!n.allowedPaths.includes(p)) out.push(`the folder ${p}`);
  return out;
}

/** The `env.ensure` payload as the runner runs it: access narrowed to the local grants (never sudo). */
export function localEnvEnsure(policy: Policy, p: EnvEnsurePayload): EnvEnsurePayload {
  return { ...p, access: narrowAccess(policy, p.access) };
}

export function gateEnvEnsure(policy: Policy, payload: unknown): GateDecision {
  const parsed = EnvEnsurePayloadSchema.safeParse(payload);
  if (!parsed.success) return { action: 'refuse', reason: 'malformed env.ensure payload' };
  const p: EnvEnsurePayload = parsed.data;
  const widens = p.access.allowInstall || p.access.allowedPaths.length > 0;
  if (!widens) return { action: 'run' }; // nothing beyond the locally granted rights is asked for
  // quiet-approvals [D3]: with the local `toolInstall` tick (and no extra paths, setup done) the checksum-verified tool
  // downloads run without asking; dependency steps and tools without a checksum still wait for one local yes
  if (policy.toolInstall === true && p.access.allowedPaths.length === 0 && !setupPending(policy))
    return { action: 'run', toolsOnly: true };
  return {
    action: 'hold',
    kind: 'env.ensure',
    summary: `prepare the environment of project ${p.projectId} with installs${p.access.allowedPaths.length ? ' and extra paths' : ''}`,
    detail: [
      'environment preparation that widens access',
      line('project', p.projectId),
      line('repositories', p.repos.map((r) => r.remoteUrlNormalized).join(', ')),
      line('installs', p.access.allowInstall ? 'yes' : 'no'),
      line('paths', p.access.allowedPaths.join(', ')),
      // what actually applies: Docker only where granted on this workstation
      line('docker', narrowAccess(policy, p.access).allowDocker ? 'yes (allowed locally)' : 'no'),
    ].join('\n'),
    commandHash: commandHashOf('env.ensure', { ...p, requestId: undefined }),
    ...(setupPending(policy) ? { note: SETUP_PENDING_NOTE } : {}),
  };
}

const touchesDelivery = (path: unknown): boolean =>
  typeof path === 'string' && path.split(/[\\/]+/).some((seg) => seg.toLowerCase() === 'delivery');

/**
 * Vault writes that touch a `delivery/` folder change a deploy recipe without a `recipe.write` (REVIEW blocker 3): they
 * wait for a local yes like a recipe write. A merge from another vault can bring any path, so it always waits.
 */
export function gateVaultWrite(
  policy: Policy,
  command: string,
  payload: Record<string, unknown>,
): GateDecision | null {
  const paths =
    command === 'vault.write' || command === 'vault.write_file'
      ? [payload.path]
      : command === 'vault.move'
        ? [payload.from, payload.to]
        : command === 'vault.merge'
          ? ['delivery']
          : [];
  if (!paths.some(touchesDelivery)) return null;
  return {
    action: 'hold',
    kind: 'vault.delivery',
    summary:
      `${command} touching a deploy recipe (delivery/): ${paths.filter((x) => typeof x === 'string').join(' -> ')}`.slice(
        0,
        300,
      ),
    detail: describeGeneric(command, payload),
    commandHash: commandHashOf(command, payload),
    ...(setupPending(policy) ? { note: SETUP_PENDING_NOTE } : {}),
  };
}

/**
 * `release.prepare` (R30): packaging runs the release commit's `scripts/package-runner.sh` outside the sandbox, as the
 * user, so it always waits for a local yes, and the prompt says exactly that (REVIEW round 2).
 */
export function gateReleasePrepare(
  policy: Policy,
  payload: unknown,
  remoteOf: (repoId: string) => string | null = () => null,
): GateDecision {
  const parsed = ReleasePreparePayloadSchema.safeParse(payload);
  if (!parsed.success) return { action: 'refuse', reason: 'malformed release.prepare payload' };
  const p = parsed.data;
  const remote = remoteOf(p.repoId);
  return {
    action: 'hold',
    kind: 'release.prepare',
    summary:
      `package ${p.projectName} ${p.version} for ${p.targetName}: runs ${remote ?? p.repoId} scripts/package-runner.sh outside the sandbox`.slice(
        0,
        300,
      ),
    detail: [
      'release packaging (R30): runs repository code OUTSIDE the sandbox, as you',
      line('project', p.projectName),
      line('target', `${p.targetName} (${p.targetId})`),
      line('version', p.version),
      line('repository', remote ?? `${p.repoId} (no known clone on this workstation: the run will refuse)`),
      line('commit', p.commit),
      line(
        'runs',
        `bash scripts/package-runner.sh --pubkey <${p.keyId}.pub> --out <worktree>/${p.artefact.replace(/[^/]*$/, '')}`,
      ),
      line('artefact', p.artefact),
      line('key id', p.keyId),
      line('public key', p.publicKey),
      '',
      `Approving runs scripts/package-runner.sh of commit ${p.commit} of ${remote ?? 'that repository'} on this workstation, outside the sandbox (it builds the runner: pnpm, npm). Approve only a release you trust.`,
    ].join('\n'),
    commandHash: commandHashOf('release.prepare', p),
    ...(setupPending(policy) ? { note: SETUP_PENDING_NOTE } : {}),
  };
}

/** The decision for one server command. `remoteOf` names a repository by id where the runner knows its clone. */
export function gateCommand(
  policy: Policy,
  command: string,
  payload: Record<string, unknown>,
  ctx: { remoteOf?: (repoId: string) => string | null } = {},
): GateDecision {
  const vault = gateVaultWrite(policy, command, payload);
  if (vault) return vault;
  if (command === 'release.prepare') return gateReleasePrepare(policy, payload, ctx.remoteOf);
  if (command === 'deploy.exec') return gateDeploy(policy, payload);
  if (command === 'release.sign') return gateReleaseSign(policy, payload);
  if (command === 'env.ensure') return gateEnvEnsure(policy, payload);
  if (command === 'vault.configure') return gateVaultConfigure(policy, payload);
  const kind = ALWAYS_HELD[command];
  if (!kind) return { action: 'run' };
  return {
    action: 'hold',
    kind,
    summary:
      command === 'recipe.write'
        ? `write the deploy recipe of project ${String(payload.projectId)}: ${String(payload.commitMessage ?? '')}`.slice(
            0,
            300,
          )
        : `${command} for ${heldTarget(command, payload)}`.slice(0, 300),
    detail: command === 'recipe.write' ? describeRecipeWrite(payload) : describeGeneric(command, payload),
    commandHash: commandHashOf(command, payload),
    ...(setupPending(policy) ? { note: SETUP_PENDING_NOTE } : {}),
  };
}

// ---------------------------------------------------------------- vault.configure (easy-runner-setup, Overnight decision 4)

/** The git vaults of a `vault.configure` as (vaultId, normalized remote) pairs; local vaults have none. */
export function vaultRemotePairs(
  payload: Record<string, unknown>,
): Array<{ vaultId: string; remote: string }> {
  const vaults = Array.isArray(payload.vaults) ? (payload.vaults as Array<Record<string, unknown>>) : [];
  const out: Array<{ vaultId: string; remote: string }> = [];
  for (const v of vaults) {
    const remote = typeof v?.remoteUrl === 'string' ? v.remoteUrl.trim() : '';
    if (v?.storage === 'local' || !remote) continue;
    let norm: string;
    try {
      norm = normalizeRemoteUrl(remote);
    } catch {
      norm = remote;
    }
    out.push({ vaultId: String(v.vaultId ?? ''), remote: norm });
  }
  return out;
}

/**
 * Narrows R18-S: vault set-up runs without a local yes when it only uses local storage or repeats git remotes approved
 * here before (`policy.vaultRemotes`); a new or changed online location still waits for the owner's yes. The server
 * re-sends vault.configure on every welcome, so without this every reconnect held it again.
 */
export function gateVaultConfigure(policy: Policy, payload: Record<string, unknown>): GateDecision {
  const pairs = vaultRemotePairs(payload);
  const known = (p: { vaultId: string; remote: string }) =>
    policy.vaultRemotes.some((k) => k.vaultId === p.vaultId && k.remote === p.remote);
  const fresh = pairs.filter((p) => !known(p));
  if (fresh.length === 0) return { action: 'run' };
  const shown = fresh
    .slice(0, 3)
    .map((p) => p.remote)
    .join(', ');
  return {
    action: 'hold',
    kind: 'vault.configure',
    summary:
      `vault.configure for ${heldTarget('vault.configure', payload)}: new online location ${shown}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ''}`.slice(
        0,
        300,
      ),
    detail: `${describeGeneric('vault.configure', payload)}\n\nApproving also remembers these online locations, so the same set-up runs without asking next time:\n${fresh.map((p) => `  ${p.vaultId}  ${p.remote}`).join('\n')}`,
    commandHash: commandHashOf('vault.configure', payload),
    ...(setupPending(policy) ? { note: SETUP_PENDING_NOTE } : {}),
  };
}

/** After a local yes: the pairs a held vault.configure showed become known (idempotent). */
export function rememberVaultRemotes(policy: Policy, payload: Record<string, unknown>): Policy {
  const next = structuredClone(policy);
  for (const p of vaultRemotePairs(payload))
    if (!next.vaultRemotes.some((k) => k.vaultId === p.vaultId && k.remote === p.remote))
      next.vaultRemotes.push(p);
  next.vaultRemotes = next.vaultRemotes.slice(-1000);
  return next;
}

// ---------------------------------------------------------------- DevOps shifts (R18-S [rv4-2])

export interface DevopsShiftInput {
  orgId: string;
  agentId: string;
  agentName?: string;
  shiftId: string;
  cardTitle?: string;
  requester?: string;
  request?: string;
  /** The shift kind and the DevOps access the server asks for, shown as they will apply (narrowed to local grants). */
  kind?: string;
  access?: DevOpsAccess;
  /** Rework 1 (B1): the commands the Desk approval allows in this shift, shown in full (they pass the guard's switch rules). */
  approvedCommands?: string[];
  /** gate-fixes-1 F3: a DevOps request shift reaches Docker only through the runner's gatekeeper (`narrowAccess` mode). */
  docker?: 'direct' | 'proxy';
}

/**
 * A DevOps shift from the server: the agent must hold a local grant for that organization (`devops grant`), and unless
 * policy.json says `devopsRequests: auto` every task not started on this machine waits
 * for a local yes. Setup pending holds it too.
 */
export function gateDevopsShift(
  policy: Policy,
  s: DevopsShiftInput,
  granted: boolean = policy.devops.agents[s.orgId] === s.agentId,
): GateDecision {
  if (!granted)
    return {
      action: 'refuse',
      reason: `DevOps is not granted to this agent on this workstation: run \`guildwise-runner devops grant ${s.orgId}\` on the workstation`,
    };
  const pending = setupPending(policy);
  if (policy.devopsRequests === 'auto' && !pending) return { action: 'run' };
  return {
    action: 'hold',
    kind: 'devops.task',
    summary: `DevOps task for ${s.agentName ?? s.agentId}${s.cardTitle ? `: ${s.cardTitle}` : ''}`.slice(
      0,
      300,
    ),
    detail: [
      'DevOps task (runs outside the sandbox)',
      line('organization', s.orgId),
      line('agent', `${s.agentName ?? ''} ${s.agentId}`.trim()),
      line('shift', s.shiftId),
      line('card', s.cardTitle),
      line('requested by', s.requester),
      ...(s.kind ? [line('kind', s.kind)] : []),
      ...(s.access
        ? (() => {
            const a = narrowAccess(policy, s.access, undefined, s.docker ?? 'direct');
            return [
              line(
                'docker',
                a.allowDocker
                  ? s.docker === 'proxy'
                    ? "yes, through the runner's Docker gatekeeper"
                    : 'yes (allowed locally)'
                  : s.access.allowDocker
                    ? 'asked, NOT allowed here'
                    : 'no',
              ),
              line('installs', s.access.allowInstall ? 'yes' : 'no'),
              line('paths', s.access.allowedPaths.join(', ')),
            ];
          })()
        : []),
      ...(s.approvedCommands?.length
        ? [
            '',
            'approved on the Desk for this request (each runs past the switches, exactly as written):',
            ...s.approvedCommands.map((c) => `  ${c}`),
          ]
        : []),
      ...(s.request ? ['', 'request (as received, untrusted):', s.request] : []),
      '',
      policy.devopsRequests === 'ask'
        ? 'DevOps tasks wait for a local yes (policy.json devopsRequests: "ask"). `guildwise-runner devops requests auto` opts out.'
        : '',
    ]
      .filter((l) => l !== '')
      .join('\n'),
    commandHash: commandHashOf('devops.task', s),
    ...(pending ? { note: SETUP_PENDING_NOTE } : {}),
  };
}

// ---------------------------------------------------------------- quiet-approvals [B4]: the tidy-up

/**
 * The deterministic tidy-up (a DevOps hygiene request) runs without asking only with the local `hygiene: 'run'` tick and
 * setup done; otherwise it waits for one local yes. Either way it runs as the fixed routine (no AI session).
 */
export function gateHygiene(
  policy: Policy,
  s: { orgId: string; agentName?: string; agentId: string; shiftId: string; repos: string[] },
): GateDecision {
  const pending = setupPending(policy);
  if (policy.hygiene === 'run' && !pending) return { action: 'run' };
  return {
    action: 'hold',
    kind: 'devops.task',
    summary: `Tidy the code folders (fixed routine) for ${s.agentName ?? s.agentId}`.slice(0, 300),
    detail: [
      'repository tidy-up: a fixed routine on this computer (no AI session; only branches this computer pushed are deleted on the git host)',
      line('organization', s.orgId),
      line('shift', s.shiftId),
      line('repositories', s.repos.join(', ')),
      '',
      'Tick "Tidy the code folders every day" on Approvals on this computer (or `guildwise-runner setup --hygiene run`) to stop asking.',
    ].join('\n'),
    commandHash: commandHashOf('devops.hygiene', { orgId: s.orgId, repos: s.repos }),
    ...(pending ? { note: SETUP_PENDING_NOTE } : {}),
  };
}

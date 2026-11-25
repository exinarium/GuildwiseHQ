import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { urlHasPassword } from '@aom/shared';
import { z } from 'zod';
import { ceilingRootRefusal } from '../box/folder-check.ts';
import { entryDir, loadIndex } from '../pairings.ts';
import { resolveDataDir } from '../paths.ts';
import { setupPending } from '../policy/gate.ts';
import * as grants from '../policy/grants.ts';
import { type HeldRecord, HeldVersionMismatch, heldVersion } from '../policy/held.ts';
import { localCommand } from '../policy/local-command.ts';
import type { Policy } from '../policy/schema.ts';
import { freshestFirst, SETUP_OFFERS_FILE, SetupOfferSchema } from '../setup/offers.ts';
import { audit } from './audit.ts';
import type { ApprovalsWindowDeps } from './server.ts';

/**
 * What the approvals page shows and the one place it may change anything (DESIGN "What the page may change" [S1]).
 *
 * The page can change only this fixed list: a held item (approve or deny, one at a time), DevOps grant and revoke for an
 * organization the server offers, `devopsRequests`, `toolInstall` and `hygiene` (quiet-approvals rows 8 and 9), install
 * scripts for an offered repository, deploy mode, pin-commit
 * and unpin, formatter pins, and trusting or removing a passkey. Each change is a strict schema: an unknown action, or
 * any extra field, is refused (403) and logged. Everything else in policy.json is shown read-only with its command;
 * `grants.ts` has operations for those for the CLI, and nothing here calls them.
 */

// ---------------------------------------------------------------- what the server offers

export interface WindowOrg {
  orgId: string;
  orgName: string;
  role: string;
  devopsAgentId?: string;
  devopsAgentName?: string;
}
export interface WindowRepo {
  url: string;
  name: string;
}
export interface WindowOffers {
  orgs: WindowOrg[];
  repos: WindowRepo[];
}

/** A name from the server: no control characters or escapes [S2]. */
const NameSchema = z.string().regex(/^[^\p{Cc}]{1,200}$/u);
const RepoSchema = z.object({
  url: z
    .string()
    .max(500)
    .regex(/^(?:https|ssh):\/\/[^\s\p{Cc}]+$/u)
    .refine((u) => !urlHasPassword(u)),
  name: NameSchema,
});

/**
 * The offers of every pairing under the data dir (the freshest pairing that names an organization or repository wins).
 * Read defensively: `repos` and `devopsAgentName` are optional newer fields, and a bad entry is skipped, never fatal.
 */
export function readWindowOffers(pairingDirs: readonly string[]): WindowOffers {
  const orgs = new Map<string, WindowOrg>();
  const repos = new Map<string, WindowRepo>();
  for (const dir of freshestFirst(pairingDirs)) {
    const file = join(dir, SETUP_OFFERS_FILE);
    if (!existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const obj = (raw && typeof raw === 'object' ? raw : {}) as { orgs?: unknown; repos?: unknown };
    for (const o of Array.isArray(obj.orgs) ? obj.orgs.slice(0, 500) : []) {
      const r = SetupOfferSchema.safeParse(o);
      if (!r.success || !NameSchema.safeParse(r.data.orgName).success || orgs.has(r.data.orgId)) continue;
      const name = (o as { devopsAgentName?: unknown }).devopsAgentName;
      orgs.set(r.data.orgId, {
        ...r.data,
        ...(NameSchema.safeParse(name).success ? { devopsAgentName: name as string } : {}),
      });
    }
    for (const x of Array.isArray(obj.repos) ? obj.repos.slice(0, 500) : []) {
      const r = RepoSchema.safeParse(x);
      if (!r.success) continue;
      let key: string;
      try {
        key = grants.repoScriptsKey(r.data.url);
      } catch {
        continue;
      }
      if (!repos.has(key)) repos.set(key, r.data);
    }
  }
  return { orgs: [...orgs.values()], repos: [...repos.values()] };
}

/** The offers of this runner's pairings (the default `offers` of the window). */
export function localWindowOffers(dataRoot: string = resolveDataDir()): WindowOffers {
  try {
    return readWindowOffers(loadIndex(dataRoot).pairings.map((e) => entryDir(dataRoot, e)));
  } catch {
    return { orgs: [], repos: [] };
  }
}

// ---------------------------------------------------------------- what the page shows

/** Plain names of what can be held, for people who are not developers. */
const HELD_WHAT: Record<string, string> = {
  'deploy.exec': 'Publish an app',
  'deploy.commit_redeploy': 'Publish a new version of an app',
  'devops.task': 'A DevOps helper task outside the safety box',
  'env.ensure': 'Set up the tools a project needs',
  'release.sign': 'Sign a release',
  'release.prepare': 'Prepare a release',
  'vault.delivery': 'Send files out of a vault',
  'recipe.write': 'Change a deployment recipe',
  'vault.configure': 'Set up a vault',
  'env.secret': 'Store a secret for an app',
  'provider.reseal': 'Re-seal an AI provider key',
  'provider.endpoints': 'Change where AI provider keys may be sent',
};

/** Kinds the page shows but never approves: `release.sign` signs at the keyboard (a passphrase key). */
const TERMINAL_ONLY = new Set(['release.sign']);

export interface WindowContext {
  deps: ApprovalsWindowDeps;
  dir: string;
  cli: string;
  port: number;
  instanceName: string;
  now: () => number;
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** What every page header shows, also before sign-in. */
export function headerInfo(ctx: WindowContext): { instance: string; warn: boolean; serverHost: string } {
  return {
    instance: ctx.instanceName,
    warn: !!ctx.deps.instance && ctx.deps.instance !== 'prod',
    serverHost: ctx.deps.serverOrigins.map(hostOf).join(', ') || 'not paired',
  };
}

const cmd = (ctx: WindowContext, verb: string, args: string[] = []): string =>
  localCommand(ctx.cli, verb, args) ?? `${ctx.cli} ${[verb, ...args].join(' ')}`;

function dockerText(p: Policy): string {
  switch (p.docker) {
    case 'rootless':
      return 'Its own private Docker';
    case 'shared':
      return 'A private Docker shared with another runner on this computer';
    case 'host':
      return 'The Docker already on this computer (full control of this computer)';
    default:
      return 'No Docker';
  }
}

export function buildState(ctx: WindowContext): Record<string, unknown> {
  const { deps } = ctx;
  const read = deps.policy.read();
  const p = read.policy;
  const st = deps.status();
  const offers = deps.offers();
  const servers = deps.serverOrigins.map((o) => ({
    origin: o,
    host: hostOf(o),
    connected: !!st.connected[o],
  }));
  const waiting = deps.held
    .list()
    .filter((r) => r.state === 'held')
    .map((r) => ({
      id: r.id,
      // S2: the page sends back the version it shows; an item that changed meanwhile is refused (409)
      version: r.version ?? heldVersion(r),
      kind: r.kind,
      what: HELD_WHAT[r.kind] ?? r.kind,
      summary: r.summary,
      ...(r.note ? { note: r.note } : {}),
      detail: r.detail,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      canPin: !!r.pin,
      ...(TERMINAL_ONLY.has(r.kind) ? { terminalOnly: true } : {}),
      command: cmd(ctx, 'approve', [r.id]),
    }));
  const granted = p.devops.agents;
  return {
    header: headerInfo(ctx),
    status: {
      version: deps.version,
      servers,
      instance: ctx.instanceName,
      runnerUser: st.runnerUser,
      docker: st.docker ? `${dockerText(p)}: ${st.docker}` : dockerText(p),
      connected: servers.length > 0 && servers.every((s) => s.connected),
      shifts: st.shifts.slice(0, 50),
      setupDone: !setupPending(p),
      setupCommand: cmd(ctx, 'setup'),
      ...(read.error ? { policyError: read.error } : {}),
    },
    waiting,
    // UAT 1.10.0 finding 3: DevOps requests that wait for a switch of this workstation (one per request)
    blocked: (deps.blocked?.() ?? []).map((b) => ({
      ...b,
      ...(b.switch === 'allowInstall' ? { command: cmd(ctx, 'devops install', ['on']) } : {}),
    })),
    allows: {
      devops: offers.orgs.map((o) => ({
        orgId: o.orgId,
        orgName: o.orgName,
        role: o.role,
        ...(o.devopsAgentId ? { agentId: o.devopsAgentId } : {}),
        ...(o.devopsAgentName ? { agentName: o.devopsAgentName } : {}),
        granted: !!o.devopsAgentId && granted[o.orgId] === o.devopsAgentId,
        // UAT 1.10.0 finding 2: a grant for an agent the server no longer reports here (stale after a reinstall or a
        // new hire); the page shows it with "Use the current helper" (`devops.grant` takes the offered agent)
        ...(granted[o.orgId] && granted[o.orgId] !== o.devopsAgentId
          ? { grantedOther: true, grantedAgentId: granted[o.orgId] }
          : {}),
      })),
      devopsRequests: p.devopsRequests,
      devopsInstall: p.devopsInstall === true,
      // quiet-approvals rows 8 and 9; absent means never chosen here: they ask, and the page shows "New: fewer questions"
      toolInstall: p.toolInstall === true,
      hygiene: p.hygiene === 'run',
      fewerQuestions: p.toolInstall === undefined || p.hygiene === undefined,
      // quiet-approvals phase B: the most DevOps may ever be given from the Desk (shown at /#ceiling, never pre-filled)
      ceiling: {
        docker: p.ceiling.docker,
        containerEgress: p.ceiling.containerEgress,
        mountRoots: p.ceiling.mountRoots,
      },
      devopsInstallCommand: cmd(ctx, 'devops install', ['on']),
      repos: offers.repos.map((r) => ({
        url: r.url,
        name: r.name,
        allowed: !!p.installScripts[grants.repoScriptsKey(r.url)],
      })),
      deploy: { mode: p.deploy, pinCommit: p.deployPinCommit, pins: p.deployPins.length },
      formatterPins: p.formatterPins,
      vaultRemotes: p.vaultRemotes.map((v) => ({ vaultId: v.vaultId, remote: v.remote })),
      passkeys: {
        trusted: p.passkeys.map((k) => ({
          credentialId: k.credentialId,
          name: k.name ?? '',
          origin: k.origin,
          ...(k.trustedAt ? { trustedAt: k.trustedAt } : {}),
        })),
        offered: deps.passkeys.offers().map((o) => ({
          credentialId: o.credentialId,
          name: o.name,
          createdAt: o.createdAt,
          origin: o.origin,
        })),
      },
      readOnly: [
        { label: 'Docker for your apps', value: dockerText(p), command: cmd(ctx, 'setup') },
        {
          label: 'Accepts that the runner has full control of this computer',
          value: p.acceptRootEquivalent ? 'Yes' : 'No',
          command: cmd(ctx, 'setup'),
        },
        {
          label: 'Unsigned runner updates accepted from',
          value: p.allowUnsignedUpdatesFrom.join(', ') || 'Nobody (safe)',
          command: cmd(ctx, 'updates allow-unsigned|disallow-unsigned <server>'),
        },
        {
          label: 'Release signing keys',
          value: p.signingKeys.length
            ? p.signingKeys.map((k) => `${k.keyId}${k.autoSign ? ' (signs without asking)' : ''}`).join(', ')
            : 'None',
          command: cmd(ctx, 'signing list'),
        },
        {
          label: 'CEO full power on this computer',
          value: p.ceo.fullPower ? 'On' : 'Off',
          command: cmd(ctx, 'ceo full-power on|off'),
        },
        { label: 'Open one CEO turn with full power', value: '', command: cmd(ctx, 'ceo turn') },
        {
          label: 'Extra package registries for installs',
          value: p.installRegistries.join(', ') || 'None',
          command: cmd(ctx, 'policy'),
        },
        {
          label: 'Project proxy and certificate settings for installs',
          value: p.installNetworkConfig ? 'Used' : 'Ignored (safe)',
          command: cmd(ctx, 'policy'),
        },
        { label: 'Containers for shifts', value: p.allowDocker ? 'Yes' : 'No', command: cmd(ctx, 'policy') },
        {
          label: 'The account the runner uses',
          value: p.runnerUser ? `${p.runnerUser.name} (${p.runnerUser.mode})` : st.runnerUser,
          command: cmd(ctx, 'setup'),
        },
      ],
    },
  };
}

// ---------------------------------------------------------------- what the page may change [S1]

const Uuid = z.string().regex(grants.UUID_RE);
const Sha = z.string().regex(grants.SHA256_RE);
const HeldId = z.string().regex(/^[a-z0-9]{6,32}$/);
const CredId = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(1024);

/** The fixed allowlist. `.strict()`: any field beyond these is refused. */
export const ChangeSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('held.approve'), id: HeldId, version: Sha, pin: z.boolean().optional() })
    .strict(),
  z.object({ action: z.literal('held.deny'), id: HeldId }).strict(),
  z.object({ action: z.literal('devops.grant'), orgId: Uuid }).strict(),
  z.object({ action: z.literal('devops.revoke'), orgId: Uuid }).strict(),
  z.object({ action: z.literal('devops.requests'), mode: z.enum(['ask', 'auto']) }).strict(),
  z.object({ action: z.literal('devops.install'), on: z.boolean() }).strict(),
  z.object({ action: z.literal('devops.toolInstall'), on: z.boolean() }).strict(),
  z.object({ action: z.literal('devops.hygiene'), mode: z.enum(['run', 'ask']) }).strict(),
  z
    .object({
      action: z.literal('ceiling.set'),
      docker: z.boolean(),
      containerEgress: z.boolean(),
      mountRoots: z.array(z.string().min(1).max(1000)).max(20),
    })
    .strict(),
  z.object({ action: z.literal('repo.scripts'), url: z.string().max(500), allow: z.boolean() }).strict(),
  z.object({ action: z.literal('deploy.mode'), mode: z.enum(['ask', 'off']) }).strict(),
  z.object({ action: z.literal('deploy.pinCommit'), on: z.boolean() }).strict(),
  z.object({ action: z.literal('deploy.unpin'), hash: z.union([Sha, z.literal('all')]) }).strict(),
  z.object({ action: z.literal('formatter.pin'), hash: Sha, add: z.boolean() }).strict(),
  z.object({ action: z.literal('passkey.trust'), credentialId: CredId }).strict(),
  z.object({ action: z.literal('passkey.remove'), credentialId: CredId }).strict(),
  z
    .object({
      action: z.literal('vault.forget'),
      vaultId: z.string().min(1).max(200),
      remote: z.string().min(1).max(500),
    })
    .strict(),
]);
export type Change = z.infer<typeof ChangeSchema>;

export type ChangeResult = { status: number; body: Record<string, unknown> };

const refuse = (status: number, error: string): ChangeResult => ({ status, body: { error } });

/** Applies one change from the page. `device` is the session's key hash (for the audit line). */
export async function applyChange(ctx: WindowContext, device: string, body: unknown): Promise<ChangeResult> {
  const { deps, dir } = ctx;
  const parsed = ChangeSchema.safeParse(body);
  if (!parsed.success) {
    const action =
      body && typeof body === 'object' && typeof (body as { action?: unknown }).action === 'string'
        ? String((body as { action: string }).action).slice(0, 60)
        : '(none)';
    audit(dir, deps.log, { action: 'refused', target: action.replace(/\p{Cc}/gu, ''), device }, ctx.now);
    return refuse(403, 'This cannot be changed on this page. Use the command shown next to it.');
  }
  const c = parsed.data;
  const offers = () => deps.offers();
  const policyChange = (target: string, change: (p: Policy) => Policy, view: (p: Policy) => unknown) => {
    const before = view(deps.policy.get());
    const next = deps.policy.update(change);
    const after = view(next);
    audit(dir, deps.log, { action: c.action, target, device, before, after }, ctx.now);
    return { status: 200, body: { ok: true } };
  };
  try {
    switch (c.action) {
      case 'held.approve':
      case 'held.deny': {
        const r = deps.held.get(c.id);
        if (!r || r.state !== 'held') return refuse(404, 'This item is no longer waiting.');
        // S2: approve exactly the version shown; a newer shift of the same request replaced it meanwhile
        if (c.action === 'held.approve' && (r.version ?? heldVersion(r)) !== c.version)
          return refuse(409, 'This item changed; look again.');
        if (c.action === 'held.deny') {
          await deps.decide(r.id, 'denied', {});
          audit(dir, deps.log, { action: c.action, target: `${r.kind} ${r.id}`, device }, ctx.now);
          return { status: 200, body: { ok: true } };
        }
        const read = deps.policy.read();
        if (read.error) return refuse(409, 'The local policy file is not valid; fix it first.');
        if (setupPending(read.policy))
          return refuse(409, `Setup is not finished on this computer. Run: ${cmd(ctx, 'setup')}`);
        if (TERMINAL_ONLY.has(r.kind))
          return refuse(409, `This one is approved in the terminal: ${cmd(ctx, 'approve', [r.id])}`);
        if (c.pin && !r.pin) return refuse(400, 'Only a deploy can be pinned.');
        const extra: Partial<HeldRecord> = {};
        if (c.pin && r.pin) extra.pinned = true;
        try {
          await deps.decide(r.id, 'approved', extra, c.version);
        } catch (err) {
          if (err instanceof HeldVersionMismatch) return refuse(409, 'This item changed; look again.');
          throw err;
        }
        // the pin only after the compare-and-set succeeded: a changed item never adds a pin
        if (c.pin && r.pin) {
          const pin = r.pin;
          deps.policy.update((p) => grants.deployPinHeld(p, pin));
        }
        audit(
          dir,
          deps.log,
          {
            action: c.action,
            target: `${r.kind} ${r.id}`,
            device,
            ...(c.pin ? { after: { pinned: true } } : {}),
          },
          ctx.now,
        );
        return { status: 200, body: { ok: true } };
      }
      case 'devops.grant':
      case 'devops.revoke': {
        const o = offers().orgs.find((x) => x.orgId.toLowerCase() === c.orgId.toLowerCase());
        if (!o) return refuse(403, 'This organization is not offered to this computer.');
        if (c.action === 'devops.grant') {
          const agentId = o.devopsAgentId;
          if (!agentId) return refuse(409, 'This organization has no DevOps helper on this computer yet.');
          return policyChange(
            o.orgId,
            (p) => grants.devopsGrant(p, o.orgId, agentId),
            (p) => p.devops.agents[o.orgId] ?? null,
          );
        }
        return policyChange(
          o.orgId,
          (p) => grants.devopsRevoke(p, o.orgId),
          (p) => p.devops.agents[o.orgId] ?? null,
        );
      }
      case 'devops.install':
        return policyChange(
          'devopsInstall',
          (p) => grants.devopsInstall(p, c.on),
          (p) => p.devopsInstall ?? null,
        );
      case 'devops.toolInstall':
        return policyChange(
          'toolInstall',
          (p) => grants.toolInstall(p, c.on),
          (p) => p.toolInstall ?? null,
        );
      case 'devops.hygiene':
        return policyChange(
          'hygiene',
          (p) => grants.hygiene(p, c.mode),
          (p) => p.hygiene ?? null,
        );
      case 'ceiling.set': {
        // R5-B1: a root is kept by its real location and never one of the never-list (the owner typed it on this page)
        const nl = {
          home: homedir(),
          policyRoot: deps.policy.dir,
          runnerRoot: resolveDataDir(),
          worktrees: join(resolveDataDir(), 'worktrees'),
        };
        const roots: string[] = [];
        for (const r of c.mountRoots) {
          if (!r.startsWith('/')) return refuse(400, `${r}: give the whole folder path, starting with /`);
          const why = ceilingRootRefusal(r, nl);
          if (why) return refuse(400, `${r} cannot be given to DevOps: ${why}`);
          roots.push(realpathSync(r));
        }
        return policyChange(
          'ceiling',
          (p) => ({
            ...p,
            ceiling: {
              docker: c.docker,
              containerEgress: c.containerEgress,
              mountRoots: [...new Set(roots)],
            },
          }),
          (p) => p.ceiling,
        );
      }
      case 'devops.requests':
        return policyChange(
          'devopsRequests',
          (p) => grants.devopsRequests(p, c.mode),
          (p) => p.devopsRequests,
        );
      case 'repo.scripts': {
        // the page only sends offered addresses; one with a password is refused and never written or logged
        if (urlHasPassword(c.url))
          return refuse(400, 'A repository address with a password is not accepted.');
        let key: string;
        try {
          key = grants.repoScriptsKey(c.url);
        } catch {
          return refuse(400, 'Not a repository address.');
        }
        const offered = offers().repos.some((r) => {
          try {
            return grants.repoScriptsKey(r.url) === key;
          } catch {
            return false;
          }
        });
        if (!offered) return refuse(403, 'This repository is not offered to this computer.');
        return policyChange(
          key,
          (p) => grants.repoScripts(p, c.url, c.allow),
          (p) => !!p.installScripts[key],
        );
      }
      case 'deploy.mode':
        return policyChange(
          'deploy',
          (p) => grants.deployMode(p, c.mode),
          (p) => p.deploy,
        );
      case 'deploy.pinCommit':
        return policyChange(
          'deployPinCommit',
          (p) => grants.deployPinCommit(p, c.on),
          (p) => p.deployPinCommit,
        );
      case 'deploy.unpin':
        return policyChange(
          c.hash === 'all' ? 'all deploy pins' : c.hash,
          (p) => grants.deployUnpin(p, c.hash),
          (p) => p.deployPins.length,
        );
      case 'formatter.pin':
        return policyChange(
          c.hash,
          (p) => grants.formatterPin(p, c.hash, c.add),
          (p) => p.formatterPins.includes(c.hash),
        );
      case 'passkey.trust': {
        const o = deps.passkeys.offers().find((x) => x.credentialId === c.credentialId);
        if (!o) return refuse(404, 'This passkey is no longer offered.');
        const res = policyChange(
          o.credentialId.slice(0, 16),
          (p) => grants.passkeyTrust(p, o, ctx.now()),
          (p) => p.passkeys.some((k) => k.credentialId === o.credentialId),
        );
        deps.passkeys.removeOffer(o.credentialId);
        return res;
      }
      case 'vault.forget': {
        // only narrows: the next set-up with this online location waits for a yes again
        const has = (p: Policy) =>
          p.vaultRemotes.some((v) => v.vaultId === c.vaultId && v.remote === c.remote);
        if (!has(deps.policy.get())) return refuse(404, 'This online location is not remembered here.');
        return policyChange(
          `${c.vaultId} ${c.remote}`.slice(0, 200),
          (p) => ({
            ...p,
            vaultRemotes: p.vaultRemotes.filter((v) => !(v.vaultId === c.vaultId && v.remote === c.remote)),
          }),
          has,
        );
      }
      case 'passkey.remove': {
        // exact id only (the CLI takes a prefix; the page always knows the whole id)
        const id = c.credentialId;
        if (!deps.policy.get().passkeys.some((k) => k.credentialId === id))
          return refuse(404, 'This passkey is not trusted here.');
        return policyChange(
          id.slice(0, 16),
          (p) => grants.passkeyRemoveId(p, id),
          (p) => p.passkeys.some((k) => k.credentialId === id),
        );
      }
    }
  } catch (err) {
    deps.log.warn(`approvals page: ${c.action} failed: ${err instanceof Error ? err.message : String(err)}`);
    return refuse(409, err instanceof Error ? err.message : String(err));
  }
}

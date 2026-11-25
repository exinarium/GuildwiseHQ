import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ReleaseSignPayloadSchema, urlHasPassword } from '@aom/shared';
import type { Command } from 'commander';
import { binTreeHash, type GuardRoots, guardRoots, refusedCode, TreePins } from '../box/tool-box.ts';
import type { Manifest } from '../box/tree-hash.ts';
import { entryDir, loadIndex } from '../pairings.ts';
import { resolveDataDir, runnerPaths } from '../paths.ts';
import { readOffers, type SetupOffer } from '../setup/offers.ts';
import { RELEASE_PREP_DIR } from '../signing/release-prepare.ts';
import { type MinisignRunner, runMinisign, secretKeyKind, signArtefact } from '../signing/release-sign.ts';
import { ToolchainRegistry } from '../toolchain/registry.ts';
import { toolchainsRoot } from '../toolchain/user-install.ts';
import { openOwnerTurn } from './authority.ts';
import { setupPending } from './gate.ts';
import * as grants from './grants.ts';
import { type HeldRecord, HeldStore, HeldVersionMismatch, heldVersion } from './held.ts';
import { POLICY_KEY_FILE, sealMarkerFor } from './integrity.ts';
import { PasskeyStore } from './passkey-store.ts';
import type { Policy } from './schema.ts';
import { PolicyStore, policyDir } from './store.ts';

/**
 * The CLI of the local authority (R18-S, R18-D, R22, R30): the only writer of policy.json besides W9's `setup`. Every
 * command works on THIS machine; nothing here talks to the server. Approvals and typed confirmations need a terminal:
 * an agent's shell is not one, so a script cannot approve for the person at the keyboard.
 */

export interface PolicyCliDeps {
  store: PolicyStore;
  held: HeldStore;
  passkeys: PasskeyStore;
  out: (line: string) => void;
  /** Asks a question at the terminal; resolves with the answer. Absent or not a terminal: approvals are refused. */
  ask?: (question: string) => Promise<string>;
  minisign?: MinisignRunner;
  minisignAvailable?: () => boolean;
  now?: () => number;
  /** The organizations the server offers this workstation and their DevOps engineer here (`setup-offers.json`). */
  offers?: () => SetupOffer[];
  /** T2: the runner's toolchain list (`toolchain approve` shows the entry it pins). */
  toolchains?: () => ToolchainRegistry;
  /** tool-pin-lib: the tool folder pins and the guarded folders (`toolchain trust`). Default: this computer's. */
  treePins?: () => TreePins;
  guardRoots?: () => GuardRoots;
  /** Where `toolchain trust` writes the full list of changes (default: the runner's logs folder). */
  logsDir?: () => string;
}

/** The offers of every pairing under the data dir (what `setup` shows); none when the runner is not paired. */
export function localOffers(dataRoot: string = resolveDataDir()): SetupOffer[] {
  try {
    return readOffers(loadIndex(dataRoot).pairings.map((e) => entryDir(dataRoot, e)));
  } catch {
    return [];
  }
}

export function defaultCliDeps(dir: string = policyDir()): PolicyCliDeps {
  const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const dataDir = resolveDataDir();
  return {
    store: new PolicyStore(dir, {
      sealMarker: sealMarkerFor(dataDir),
      onKeyCreated: (f) => console.warn(`created a new policy key: ${f}`),
    }),
    toolchains: () => {
      const reg = new ToolchainRegistry(runnerPaths(dataDir).toolchains, dataDir);
      const pins = new PolicyStore(dir).get().toolchainPins;
      reg.pinned = (h) => pins.includes(h);
      return reg;
    },
    held: new HeldStore(dir),
    passkeys: new PasskeyStore(dir),
    out: (l) => console.log(l),
    ...(tty
      ? {
          ask: async (q: string) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              return await rl.question(q);
            } finally {
              rl.close();
            }
          },
        }
      : {}),
    minisignAvailable: () =>
      spawnSync(process.env.AOM_MINISIGN_BIN || 'minisign', ['-v'], { stdio: 'ignore' }).status === 0,
    offers: () => localOffers(),
  };
}

async function confirm(d: PolicyCliDeps, question: string, expected = 'yes'): Promise<boolean> {
  if (!d.ask) throw new Error('this needs a person at a terminal (stdin and stdout must be a terminal)');
  return (await d.ask(`${question} Type "${expected}" to confirm: `)).trim() === expected;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- held items

export function pendingList(d: PolicyCliDeps): HeldRecord[] {
  const items = d.held.list().filter((r) => r.state === 'held');
  if (items.length === 0) d.out('Nothing is waiting for an approval on this workstation.');
  for (const r of items)
    d.out(
      `${r.id}  ${r.kind.padEnd(22)} ${r.summary}${r.note ? `  [${r.note}]` : ''}  (until ${r.expiresAt})`,
    );
  return items;
}

/**
 * `guildwise-runner approve <id> [--pin]`: prints the command as the runner received it, asks, and records the yes. A
 * deploy approved with `--pin` also writes its whole-command hash (and with `deployPinCommit`, the commit-bound hash) to
 * policy.json, so unchanged redeploys run unattended. `release.sign` signs here, at the keyboard, so a passphrase key
 * works; only the signature goes to the runner.
 */
export async function approve(
  d: PolicyCliDeps,
  id: string,
  opts: { pin?: boolean } = {},
): Promise<HeldRecord> {
  const r = d.held.find(id);
  if (!r) throw new Error(`no held item ${id} (guildwise-runner pending lists them)`);
  if (r.state !== 'held') throw new Error(`item ${r.id} is already ${r.state}`);
  const policy = d.store.read();
  if (policy.error) throw new Error(`${d.store.file} is not a valid policy (${policy.error}); fix it first`);
  if (setupPending(policy.policy))
    throw new Error(
      'setup pending: run `guildwise-runner setup` on this workstation before approving anything',
    );
  if (opts.pin && !r.pin) throw new Error(`--pin applies to deploys only, not to ${r.kind}`);
  d.out(`Held ${r.kind} ${r.id} (received ${r.createdAt}):`);
  d.out(r.detail);
  d.out(`command hash: ${r.commandHash}`);
  // S2: the version printed here is the one approved; a newer shift of the same request after the yes aborts
  const shown = r.version ?? heldVersion(r);
  d.out(`version: ${shown}`);
  if (opts.pin)
    d.out(
      policy.policy.deployPinCommit
        ? 'With --pin, redeploys of exactly this command AT THIS COMMIT run without asking.'
        : 'With --pin, redeploys of exactly this command run without asking. They build whatever is on the deployed branch: anyone who can push there gets code run at the next deploy (`guildwise-runner deploy pin-commit on` binds pins to a commit).',
    );
  if (!(await confirm(d, `Run this ${r.kind}?`))) throw new Error('not approved');
  let signature: string | undefined;
  if (r.kind === 'release.sign') {
    const body = r.replay.body as { payload: unknown; artefactPath?: string | null };
    const p = ReleaseSignPayloadSchema.parse(body.payload);
    const key = policy.policy.signingKeys.find((k) => k.keyId === p.keyId);
    if (!key) throw new Error(`this workstation holds no signing key ${p.keyId}`);
    if (!body.artefactPath) throw new Error('the artefact to sign is not on this workstation');
    const res = await signArtefact({
      payload: p,
      key,
      artefactPath: body.artefactPath,
      interactive: true,
      allowedRoot: join(r.pairing, RELEASE_PREP_DIR),
      ...(d.minisign ? { minisign: d.minisign } : {}),
    });
    signature = res.minisig;
  }
  let done: HeldRecord;
  try {
    done = d.held.decide(
      r.id,
      'approved',
      'local',
      { ...(opts.pin ? { pinned: true } : {}), ...(signature ? { signature } : {}) },
      shown,
    );
  } catch (err) {
    if (err instanceof HeldVersionMismatch)
      throw new Error(
        `item ${r.id} changed after it was printed (a newer request replaced it); nothing was approved. Run approve again to see the new version.`,
      );
    throw err;
  }
  if (opts.pin && r.pin) {
    const pin = r.pin;
    d.store.update((p) => grants.deployPinHeld(p, pin));
  }
  d.out(`Approved ${r.id}; the runner starts it within a few seconds.`);
  return done;
}

export function deny(d: PolicyCliDeps, id: string): HeldRecord {
  const r = d.held.find(id);
  if (!r) throw new Error(`no held item ${id}`);
  const done = d.held.decide(r.id, 'denied', 'local');
  d.out(`Denied ${r.id}: the server is told it will not run.`);
  return done;
}

// ---------------------------------------------------------------- grants and settings

function show(d: PolicyCliDeps, p: Policy): void {
  d.out(JSON.stringify(p, null, 2));
}

/**
 * `guildwise-runner devops list`: the organization and agent ids `devops grant` takes (UAT 1.10.0 bug 5: nothing showed
 * them), from what the server offers this workstation, with each one's local grant and the command to give it.
 */
export function devopsList(d: PolicyCliDeps): void {
  const offers = d.offers?.() ?? [];
  const granted = d.store.get().devops.agents;
  if (!offers.length && !Object.keys(granted).length) {
    d.out(
      'No organization offers a DevOps engineer for this workstation yet (start the runner once after pairing).',
    );
    return;
  }
  for (const o of offers) {
    const g = granted[o.orgId];
    d.out(`${o.orgName}  organization ${o.orgId}  (the server says you are ${o.role})`);
    if (!o.devopsAgentId)
      d.out('  DevOps engineer: none on this workstation yet (hire one, then run this again)');
    else d.out(`  DevOps engineer: agent ${o.devopsAgentId}`);
    if (g)
      d.out(
        `  local grant: agent ${g}${o.devopsAgentId && g !== o.devopsAgentId ? ' (not the one the server reports now)' : ''}`,
      );
    else if (o.devopsAgentId)
      d.out(`  not granted; to grant: guildwise-runner devops grant ${o.orgId} --agent ${o.devopsAgentId}`);
  }
  for (const [org, agent] of Object.entries(granted))
    if (!offers.some((o) => o.orgId === org))
      d.out(`organization ${org} (not offered by the server now)\n  local grant: agent ${agent}`);
}

export function devopsGrant(d: PolicyCliDeps, orgId: string, agentIdArg?: string): Policy {
  // without --agent: the DevOps engineer the server reports for that organization on this workstation (what setup offers)
  const agentId =
    agentIdArg ?? d.offers?.().find((o) => o.orgId.toLowerCase() === orgId.toLowerCase())?.devopsAgentId;
  if (!UUID.test(orgId) || (agentIdArg !== undefined && !UUID.test(agentIdArg)))
    throw new Error(
      'use: devops grant <organization-id> [--agent <agent-id>] (`guildwise-runner devops list` shows both)',
    );
  if (!agentId || !UUID.test(agentId))
    throw new Error(
      `no DevOps engineer is known for organization ${orgId} on this workstation: pass --agent <agent-id> (\`guildwise-runner devops list\` shows the ids)`,
    );
  const p = d.store.update((p) => grants.devopsGrant(p, orgId, agentId));
  d.out(
    `DevOps agent ${agentId} may now serve organization ${orgId} on this workstation (outside the sandbox).`,
  );
  if (p.devopsRequests === 'ask')
    d.out('Every DevOps task not started here still waits for `guildwise-runner approve`.');
  return p;
}

export function devopsRevoke(d: PolicyCliDeps, orgId: string): Policy {
  const p = d.store.update((p) => grants.devopsRevoke(p, orgId));
  d.out(`DevOps grant for organization ${orgId} removed.`);
  return p;
}

/** `devops install on|off` (UAT 1.10.0 finding 3): the local choice the runner sends to the server's Install switch. */
export function devopsInstallCli(d: PolicyCliDeps, value: string): Policy {
  if (value !== 'on' && value !== 'off') throw new Error('use: devops install on|off');
  const p = d.store.update((p) => grants.devopsInstall(p, value === 'on'));
  d.out(
    value === 'on'
      ? 'DevOps helpers may now install the tools your projects need (in the runner\'s own folder). The running runner turns on "Install packages and tools" for this workstation within a few seconds; DevOps requests that waited for it continue.'
      : 'DevOps helpers may no longer install tools here. The running runner turns off "Install packages and tools" for this workstation.',
  );
  return p;
}

export function devopsRequests(d: PolicyCliDeps, mode: string): Policy {
  if (mode !== 'ask' && mode !== 'auto') throw new Error('use: devops requests ask|auto');
  const p = d.store.update((p) => grants.devopsRequests(p, mode));
  d.out(
    mode === 'auto'
      ? 'DevOps tasks for granted agents now start without asking. This is an explicit opt-out: the server then decides what they do.'
      : 'DevOps tasks wait for a local yes.',
  );
  return p;
}

export function devopsAgentRequests(d: PolicyCliDeps, mode: string): Policy {
  if (mode !== 'ask' && mode !== 'deny') throw new Error('use: devops agent-requests ask|deny');
  return d.store.update((p) => grants.devopsAgentRequests(p, mode));
}

export function repoScripts(d: PolicyCliDeps, url: string, allow: boolean): Policy {
  if (!url.trim()) throw new Error('use: repo allow-scripts <repository url>');
  if (urlHasPassword(url))
    throw new Error('a repository address with a password is refused: give it without the password');
  // the same normalized form the server and env.ensure use (github.com/owner/repo)
  const key = grants.repoScriptsKey(url);
  const p = d.store.update((p) => grants.repoScripts(p, url, allow));
  d.out(
    allow
      ? `Installs of ${key} may run their scripts on this workstation (environment set-up: outside the sandbox; "aom devops install": inside it).`
      : `Installs of ${key} run without scripts again.`,
  );
  return p;
}

export function formatterPin(d: PolicyCliDeps, hash: string, add: boolean): Policy {
  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new Error('a formatter pin is the sha256 shown in the release notes');
  return d.store.update((p) => grants.formatterPin(p, hash, add));
}

export function deploySettings(d: PolicyCliDeps, what: 'mode' | 'pin-commit', value: string): Policy {
  if (what === 'mode' && value !== 'ask' && value !== 'off') throw new Error('use: deploy mode ask|off');
  if (what === 'pin-commit' && value !== 'on' && value !== 'off')
    throw new Error('use: deploy pin-commit on|off');
  return d.store.update((p) =>
    what === 'mode'
      ? grants.deployMode(p, value as 'ask' | 'off')
      : grants.deployPinCommit(p, value === 'on'),
  );
}

export function deployUnpin(d: PolicyCliDeps, hashOrAll: string): Policy {
  return d.store.update((p) => grants.deployUnpin(p, hashOrAll));
}

export async function unsignedOrigin(d: PolicyCliDeps, origin: string, allow: boolean): Promise<Policy> {
  if (
    allow &&
    !(await confirm(
      d,
      `Accept UNSIGNED runner updates from ${origin}? Only for test machines: that server can then run any code here.`,
    ))
  )
    throw new Error('not changed');
  return d.store.update((p) => grants.unsignedOrigin(p, origin, allow));
}

// ---------------------------------------------------------------- passkeys (R22)

export function passkeyList(d: PolicyCliDeps): void {
  const p = d.store.get();
  d.out('Trusted on this workstation:');
  if (p.passkeys.length === 0) d.out('  (none)');
  for (const k of p.passkeys)
    d.out(`  ${k.credentialId.slice(0, 12)}...  ${k.name ?? ''}  ${k.origin}  trusted ${k.trustedAt ?? ''}`);
  const offers = d.passkeys.offers();
  d.out('Offered by the server, NOT trusted:');
  if (offers.length === 0) d.out('  (none)');
  for (const o of offers)
    d.out(
      `  ${o.credentialId.slice(0, 12)}...  "${o.name}"  created ${o.createdAt}  ${o.aaguid ? `AAGUID ${o.aaguid}` : ''}  ${o.origin}`,
    );
}

/**
 * `passkey trust [credential-id prefix]`: trusts one offered passkey after a local yes. It can then approve only a
 * commit-only redeploy and a recipe write; never grants, DevOps, install scripts or owner turns.
 */
export async function passkeyTrust(d: PolicyCliDeps, prefix?: string): Promise<Policy> {
  const offers = d.passkeys.offers().filter((o) => !prefix || o.credentialId.startsWith(prefix));
  if (offers.length === 0) throw new Error('no passkey offer matches (passkey list shows them)');
  if (offers.length > 1) throw new Error('several offers match: give more of the credential id');
  const o = offers[0] as (typeof offers)[number];
  d.out(`Passkey "${o.name}", created ${o.createdAt}, credential ${o.credentialId.slice(0, 12)}...`);
  if (o.aaguid) d.out(`Authenticator model (AAGUID): ${o.aaguid}`);
  d.out(
    `For ${o.rpId} (${o.origin}). It will be able to approve a pinned redeploy at a new commit and a recipe write.`,
  );
  if (!(await confirm(d, 'Trust this passkey on this workstation?'))) throw new Error('not trusted');
  const p = d.store.update((p) => grants.passkeyTrust(p, o, d.now?.() ?? Date.now()));
  d.passkeys.removeOffer(o.credentialId);
  d.out('Trusted.');
  return p;
}

export function passkeyRemove(d: PolicyCliDeps, prefix: string): Policy {
  const p = d.store.update((p) => grants.passkeyRemove(p, prefix));
  d.out('Removed.');
  return p;
}

// ---------------------------------------------------------------- signing keys (R30)

/**
 * `signing add-key --key-id <id> --key-file <path> [--auto-sign]`: stores the PATH only. `--auto-sign` (unattended
 * signing of `release.sign` for this key) needs a typed confirmation and is refused for a passphrase key (Q14).
 */
export async function signingAddKey(
  d: PolicyCliDeps,
  o: { keyId: string; keyFile: string; autoSign?: boolean },
): Promise<Policy> {
  const keyId = o.keyId.trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(keyId)) throw new Error('the key id is 16 hex characters (minisign prints it)');
  if (!o.keyFile.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(o.keyFile))
    throw new Error('give the key file as an absolute path');
  if (!existsSync(o.keyFile)) throw new Error(`${o.keyFile} does not exist`);
  if (d.minisignAvailable && !d.minisignAvailable())
    throw new Error('minisign is not installed (sudo apt install minisign, or brew install minisign)');
  const kind = secretKeyKind(o.keyFile);
  if (kind === 'unknown') throw new Error(`${o.keyFile} is not a minisign secret key file`);
  if (o.autoSign) {
    if (kind === 'passphrase')
      throw new Error('--auto-sign is refused for a passphrase-protected key: it cannot sign unattended');
    if (
      !(await confirm(
        d,
        `Sign every release.sign request for key ${keyId} WITHOUT asking (UAT keys only, never the production key)?`,
        `auto-sign ${keyId}`,
      ))
    )
      throw new Error('not changed');
  }
  const p = d.store.update((p) =>
    grants.signingAddKey(p, { keyId, keyFile: o.keyFile, autoSign: !!o.autoSign }),
  );
  d.out(
    `Signing key ${keyId} registered (only its path is stored)${o.autoSign ? ', signing unattended' : '; every signing asks'}.`,
  );
  return p;
}

export function signingRemoveKey(d: PolicyCliDeps, keyId: string): Policy {
  return d.store.update((p) => grants.signingRemoveKey(p, keyId));
}

// ---------------------------------------------------------------- commander wiring

const run =
  <A extends unknown[]>(fn: (...a: A) => unknown | Promise<unknown>) =>
  async (...a: A) => {
    try {
      await fn(...a);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  };

/** Registers the local-authority commands on the runner CLI. `deps` is created per call (tests pass their own). */
export function registerPolicyCommands(
  program: Command,
  make: () => PolicyCliDeps = () => defaultCliDeps(),
): void {
  program
    .command('pending')
    .description('list what waits for a local approval on this workstation')
    .action(run(() => pendingList(make())));
  program
    .command('approve <id>')
    .description('show a held command exactly as the runner received it, and run it after your yes')
    .option('--pin', 'deploys: run unchanged redeploys of this command without asking from now on')
    .action(run((id: string, o: { pin?: boolean }) => approve(make(), id, o)));
  program
    .command('deny <id>')
    .description('refuse a held command')
    .action(run((id: string) => deny(make(), id)));

  const devops = program.command('devops').description('local DevOps grants (R18-S)');
  devops
    .command('list')
    .description(
      'the organizations, their DevOps engineer on this workstation and the local grants (the ids `grant` takes)',
    )
    .action(run(() => devopsList(make())));
  devops
    .command('grant <organization-id>')
    .option(
      '--agent <agent-id>',
      'the DevOps agent of that organization (default: the one `devops list` shows)',
    )
    .description('let that DevOps agent work outside the sandbox on this workstation')
    .action(run((org: string, o: { agent?: string }) => devopsGrant(make(), org, o.agent)));
  devops.command('revoke <organization-id>').action(run((org: string) => devopsRevoke(make(), org)));
  devops
    .command('install <on|off>')
    .description(
      "whether DevOps helpers may install the tools your projects need (sets the workstation's Install switch)",
    )
    .action(run((v: string) => devopsInstallCli(make(), v)));
  devops
    .command('requests <ask|auto>')
    .description('whether DevOps tasks not started here wait for a local yes (default ask)')
    .action(run((m: string) => devopsRequests(make(), m)));
  devops
    .command('agent-requests <ask|deny>')
    .description('agent `aom devops` requests: wait for a local yes, or refuse them')
    .action(run((m: string) => devopsAgentRequests(make(), m)));
  devops.command('pending').action(run(() => pendingList(make())));
  devops.command('approve <id>').action(run((id: string) => approve(make(), id)));
  devops.command('deny <id>').action(run((id: string) => deny(make(), id)));

  const repo = program.command('repo').description('per-repository install scripts (R18-S)');
  repo.command('allow-scripts <url>').action(run((u: string) => repoScripts(make(), u, true)));
  repo.command('deny-scripts <url>').action(run((u: string) => repoScripts(make(), u, false)));

  const formatter = program.command('formatter').description('release formatter config pins (R18-S)');
  formatter.command('pin <sha256>').action(run((h: string) => formatterPin(make(), h, true)));
  formatter.command('unpin <sha256>').action(run((h: string) => formatterPin(make(), h, false)));

  const deploy = program.command('deploy').description('deploy approval settings (R18-S)');
  deploy.command('mode <ask|off>').action(run((v: string) => deploySettings(make(), 'mode', v)));
  deploy.command('pin-commit <on|off>').action(run((v: string) => deploySettings(make(), 'pin-commit', v)));
  deploy.command('unpin <hash|all>').action(run((h: string) => deployUnpin(make(), h)));

  const updates = program
    .command('updates')
    .description('which servers may send unsigned updates (test machines only)');
  updates.command('allow-unsigned <origin>').action(run((o: string) => unsignedOrigin(make(), o, true)));
  updates.command('disallow-unsigned <origin>').action(run((o: string) => unsignedOrigin(make(), o, false)));

  const passkey = program.command('passkey').description('passkeys trusted for routine approvals (R22)');
  passkey.command('list').action(run(() => passkeyList(make())));
  passkey.command('trust [credential-id]').action(run((p?: string) => passkeyTrust(make(), p)));
  passkey.command('remove <credential-id>').action(run((p: string) => passkeyRemove(make(), p)));

  const signing = program.command('signing').description('release signing keys on this workstation (R30)');
  signing
    .command('add-key')
    .requiredOption('--key-id <id>', 'the minisign key id')
    .requiredOption('--key-file <path>', 'absolute path of the minisign secret key (only the path is stored)')
    .option('--auto-sign', 'sign without asking (keys without a passphrase only; typed confirmation)')
    .action(run((o: { keyId: string; keyFile: string; autoSign?: boolean }) => signingAddKey(make(), o)));
  signing.command('remove-key <key-id>').action(run((k: string) => signingRemoveKey(make(), k)));
  signing.command('list').action(
    run(() => {
      const d = make();
      for (const k of d.store.get().signingKeys)
        d.out(`${k.keyId}  ${k.keyFile}${k.autoSign ? '  (auto-sign)' : ''}`);
    }),
  );

  const toolchain = program.command('toolchain').description('toolchains the DevOps helper registered (T2)');
  toolchain
    .command('approve <sha256>')
    .description(
      "show a toolchain a DevOps helper registered and, after your yes, put it on the agents' PATH",
    )
    .action(run((h: string) => toolchainApprove(make(), h)));
  toolchain
    .command('trust <sha256>')
    .description(
      "show what changed in a tool folder outside Guildwise's own installs and, after your yes, let the helpers use it again",
    )
    .action(run((h: string) => toolchainTrust(make(), h)));

  const policy = program
    .command('policy')
    .description("print this workstation's local policy (policy.json)")
    .action(
      run(() => {
        const d = make();
        const r = d.store.read();
        if (r.error) d.out(`INVALID (${r.error}): the safe defaults apply until it is fixed`);
        else if (r.adoptable) d.out('NOT SEALED YET: the runner seals it at its next start');
        else if (!r.missing) d.out(`sealed with ${join(d.store.dir, POLICY_KEY_FILE)}`);
        d.out(d.store.file);
        show(d, r.policy);
      }),
    );
  policy
    .command('accept')
    .description('after a change made outside the runner (or a lost key): show the file and seal it as it is')
    .action(run(() => policyAccept(make())));
}

/**
 * `guildwise-runner policy accept` (T2, S3): prints what the file grants, then seals it after a typed yes. The way back
 * after a lost key or an edit made outside the runner; until then everything asks.
 */
export async function policyAccept(d: PolicyCliDeps): Promise<void> {
  let text: string;
  try {
    text = readFileSync(d.store.file, 'utf8');
  } catch {
    throw new Error(`${d.store.file} does not exist: nothing to accept`);
  }
  const r = d.store.read();
  d.out(d.store.file);
  d.out(r.error ? `Now: ${r.error}` : 'Now: sealed and valid.');
  d.out('This is what the file grants, exactly as it is on disk:');
  d.out(text.trimEnd());
  if (!(await confirm(d, 'Seal this policy as the approval settings of this computer?')))
    throw new Error('not accepted');
  d.store.accept();
  d.out('Sealed. The runner uses it from now on.');
}

/** `guildwise-runner toolchain approve <hash>` (T2, D2): shows the entry and pins it after a typed yes. */
export async function toolchainApprove(d: PolicyCliDeps, hash: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('usage: toolchain approve <sha256 shown on the Desk>');
  const reg = d.toolchains?.();
  const hit = reg?.waiting().find((w) => w.hash === hash);
  if (!hit)
    throw new Error(`no toolchain waits with ${hash.slice(0, 12)}...: \`aom toolchain list\` shows them`);
  const e = hit.entry;
  d.out(
    `Toolchain "${e.name}", registered by the DevOps helper${e.addedAt ? ` on ${e.addedAt.slice(0, 10)}` : ''}:`,
  );
  for (const b of e.binDirs) d.out(`  on PATH:   ${b}`);
  for (const r of e.readDirs) d.out(`  readable:  ${r}`);
  for (const [k, v] of Object.entries(e.env)) d.out(`  sets:      ${k}=${v}`);
  d.out('Every agent on this computer would run programs from these folders.');
  if (!(await confirm(d, 'Allow this toolchain?'))) throw new Error('not approved');
  d.store.update((p) => ({ ...p, toolchainPins: [...new Set([...p.toolchainPins, hash])] }));
  d.out(`Approved "${e.name}": new shifts and chats get it.`);
}

const kindOf = (desc: string | undefined): string => (desc ? (desc[0] ?? '?') : '-');
const isExec = (desc: string | undefined): boolean =>
  !!desc && desc.startsWith('f ') && (Number.parseInt(desc.split(' ')[1] ?? '0', 8) & 0o111) !== 0;

/** The changes between the recorded manifest and now: links and executable files first. */
export function treeChanges(
  old: Manifest | null,
  cur: Manifest,
): { lines: string[]; important: string[]; added: number; removed: number; changed: number } {
  const lines: string[] = [];
  const important: string[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  const names = [...new Set([...Object.keys(old ?? {}), ...Object.keys(cur)])].sort();
  for (const n of names) {
    const a = old?.[n];
    const b = cur[n];
    if (a === b) continue;
    let line: string;
    if (a === undefined) {
      added++;
      line = `added    ${n}${b?.startsWith('l ') ? ` -> ${b.slice(2)}` : ''}`;
    } else if (b === undefined) {
      removed++;
      line = `removed  ${n}`;
    } else {
      changed++;
      line = `changed  ${n}${kindOf(a) !== kindOf(b) ? ' (now a different kind of entry)' : ''}${b.startsWith('l ') ? ` -> ${b.slice(2)}` : ''}`;
    }
    lines.push(line);
    if (
      b?.startsWith('l ') ||
      a?.startsWith('l ') ||
      isExec(b) ||
      isExec(a) ||
      (a !== undefined && b !== undefined && kindOf(a) !== kindOf(b))
    )
      important.push(line);
  }
  return { lines, important, added, removed, changed };
}

/**
 * `guildwise-runner toolchain trust <code>` (tool-pin-lib): the code is the current hash of a tool folder (its path mixed
 * in) that changed outside Guildwise's own installs. Shows the changed links and executable files first, the totals, and
 * writes the full list to a file; after a typed yes it pins the folder, only while it still has exactly that content.
 */
export async function toolchainTrust(d: PolicyCliDeps, code: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(code)) throw new Error('usage: toolchain trust <sha256 shown on the Desk>');
  const pins = d.treePins?.() ?? new TreePins(d.store.dir);
  const g = d.guardRoots?.() ?? guardRoots(homedir(), toolchainsRoot());
  for (const root of g.whole) {
    const h = pins.fullHash(root);
    if (h.kind === 'fail' && refusedCode(root, h.reason) === code)
      throw new Error(
        `${root} cannot be allowed as it is: ${h.reason}. Remove that entry (or reinstall the tool), then check the environment again.`,
      );
    if (h.kind !== 'ok' || h.hash !== code) continue;
    const rec = pins.manifestOf(root);
    const ch = treeChanges(rec?.entries ?? null, h.manifest ?? {});
    d.out(`The tool folder ${root} changed outside Guildwise's own installs.`);
    if (!rec) d.out('There is no earlier record of it on this computer, so every entry is listed as added.');
    if (ch.important.length) {
      d.out('Links and programs that changed:');
      for (const l of ch.important.slice(0, 40)) d.out(`  ${l}`);
      if (ch.important.length > 40) d.out(`  ... and ${ch.important.length - 40} more`);
    }
    d.out(`In all: ${ch.added} added, ${ch.changed} changed, ${ch.removed} removed.`);
    try {
      const logs = d.logsDir?.() ?? runnerPaths(resolveDataDir()).logs;
      mkdirSync(logs, { recursive: true, mode: 0o700 });
      const file = join(logs, `tree-trust-${new Date().toISOString().slice(0, 10)}.txt`);
      writeFileSync(file, `${root}\n${code}\n${ch.lines.join('\n')}\n`, { mode: 0o600 });
      d.out(`The full list: ${file}`);
    } catch {
      /* the list on screen is what counts */
    }
    d.out('Every helper on this computer would run programs from this folder again.');
    if (!(await confirm(d, 'Allow this tool folder as it is now?'))) throw new Error('not approved');
    if (!pins.pin([root], [], { [root]: code }).length)
      throw new Error(
        `${root} changed again while you looked: nothing was allowed. The Desk shows the new command.`,
      );
    d.out('Allowed: new sessions of the helpers use it again.');
    return;
  }
  // a pinned bin folder of the user's own tools
  for (const dir of Object.keys(pins.read().bins)) {
    if (pins.changedBin(dir) !== code) continue;
    d.out(`The tool folder ${dir} changed. It now holds:`);
    d.out(`  (content hash ${binTreeHash(dir)?.slice(0, 16) ?? '?'})`);
    for (const l of listDir(dir).slice(0, 60)) d.out(`  ${l}`);
    d.out('Every helper on this computer would run programs from this folder again.');
    if (!(await confirm(d, 'Allow this tool folder as it is now?'))) throw new Error('not approved');
    if (!pins.pinBin(dir, code))
      throw new Error(
        `${dir} changed again while you looked: nothing was allowed. The Desk shows the new command.`,
      );
    d.out('Allowed: new sessions of the helpers use it again.');
    return;
  }
  throw new Error(
    'no tool folder has exactly this content now (it changed again, or it was allowed already): the Desk shows the current command',
  );
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => {
      const p = join(dir, e.name);
      return e.isSymbolicLink() ? `${e.name} -> ${readlinkSync(p)}` : e.name;
    });
  } catch {
    return [];
  }
}

/** `guildwise-runner ceo turn`: opens one CEO owner turn with full power from this machine (R18-S). */
export function ceoTurn(d: PolicyCliDeps, minutes = 10): string {
  if (!d.store.get().ceo.fullPower)
    throw new Error('CEO full power is off in policy.json (ceo.fullPower): `guildwise-runner setup` sets it');
  const until = openOwnerTurn(d.store.dir, Math.min(Math.max(minutes, 1), 60), d.now?.());
  d.out(
    `The next CEO owner turn until ${until} runs with full power on this machine; later ones run restricted.`,
  );
  return until;
}

export { runMinisign };

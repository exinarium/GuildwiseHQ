import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { normalizeRemoteUrl, ReleaseSignPayloadSchema } from '@aom/shared';
import type { Command } from 'commander';
import { entryDir, loadIndex } from '../pairings.ts';
import { resolveDataDir } from '../paths.ts';
import { readOffers, type SetupOffer } from '../setup/offers.ts';
import { RELEASE_PREP_DIR } from '../signing/release-prepare.ts';
import { type MinisignRunner, runMinisign, secretKeyKind, signArtefact } from '../signing/release-sign.ts';
import { openOwnerTurn } from './authority.ts';
import { setupPending } from './gate.ts';
import { type HeldRecord, HeldStore } from './held.ts';
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
  return {
    store: new PolicyStore(dir),
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
  if (opts.pin && r.pin) {
    const pin = r.pin;
    d.store.update((p) => {
      const add = [pin.base, ...(p.deployPinCommit && pin.bound ? [pin.bound] : [])];
      p.deployPins = [...new Set([...p.deployPins, ...add])];
      return p;
    });
  }
  const done = d.held.decide(r.id, 'approved', 'local', {
    ...(opts.pin ? { pinned: true } : {}),
    ...(signature ? { signature } : {}),
  });
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
  const p = d.store.update((p) => {
    p.devops.agents[orgId] = agentId;
    return p;
  });
  d.out(
    `DevOps agent ${agentId} may now serve organization ${orgId} on this workstation (outside the sandbox).`,
  );
  if (p.devopsRequests === 'ask')
    d.out('Every DevOps task not started here still waits for `guildwise-runner approve`.');
  return p;
}

export function devopsRevoke(d: PolicyCliDeps, orgId: string): Policy {
  const p = d.store.update((p) => {
    delete p.devops.agents[orgId];
    return p;
  });
  d.out(`DevOps grant for organization ${orgId} removed.`);
  return p;
}

export function devopsRequests(d: PolicyCliDeps, mode: string): Policy {
  if (mode !== 'ask' && mode !== 'auto') throw new Error('use: devops requests ask|auto');
  const p = d.store.update((p) => {
    p.devopsRequests = mode;
    return p;
  });
  d.out(
    mode === 'auto'
      ? 'DevOps tasks for granted agents now start without asking. This is an explicit opt-out: the server then decides what they do.'
      : 'DevOps tasks wait for a local yes.',
  );
  return p;
}

export function devopsAgentRequests(d: PolicyCliDeps, mode: string): Policy {
  if (mode !== 'ask' && mode !== 'deny') throw new Error('use: devops agent-requests ask|deny');
  return d.store.update((p) => {
    p.devopsAgentRequests = mode;
    return p;
  });
}

export function repoScripts(d: PolicyCliDeps, url: string, allow: boolean): Policy {
  if (!url.trim()) throw new Error('use: repo allow-scripts <repository url>');
  // the same normalized form the server and env.ensure use (github.com/owner/repo)
  const key = normalizeRemoteUrl(url.trim());
  const p = d.store.update((p) => {
    if (allow) p.installScripts[key] = true;
    else delete p.installScripts[key];
    return p;
  });
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
  return d.store.update((p) => {
    p.formatterPins = add
      ? [...new Set([...p.formatterPins, hash])]
      : p.formatterPins.filter((h) => h !== hash);
    return p;
  });
}

export function deploySettings(d: PolicyCliDeps, what: 'mode' | 'pin-commit', value: string): Policy {
  if (what === 'mode' && value !== 'ask' && value !== 'off') throw new Error('use: deploy mode ask|off');
  if (what === 'pin-commit' && value !== 'on' && value !== 'off')
    throw new Error('use: deploy pin-commit on|off');
  return d.store.update((p) => {
    if (what === 'mode') p.deploy = value as 'ask' | 'off';
    else p.deployPinCommit = value === 'on';
    return p;
  });
}

export function deployUnpin(d: PolicyCliDeps, hashOrAll: string): Policy {
  return d.store.update((p) => {
    p.deployPins = hashOrAll === 'all' ? [] : p.deployPins.filter((h) => h !== hashOrAll);
    return p;
  });
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
  return d.store.update((p) => {
    p.allowUnsignedUpdatesFrom = allow
      ? [...new Set([...p.allowUnsignedUpdatesFrom, origin])]
      : p.allowUnsignedUpdatesFrom.filter((o) => o !== origin);
    return p;
  });
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
  const p = d.store.update((p) => {
    p.passkeys = [
      ...p.passkeys.filter((k) => k.credentialId !== o.credentialId),
      {
        credentialId: o.credentialId,
        publicKey: o.publicKey,
        alg: o.alg,
        rpId: o.rpId,
        origin: new URL(o.origin).origin,
        name: o.name,
        trustedAt: new Date(d.now?.() ?? Date.now()).toISOString(),
        signCount: 0,
      },
    ];
    return p;
  });
  d.passkeys.removeOffer(o.credentialId);
  d.out('Trusted.');
  return p;
}

export function passkeyRemove(d: PolicyCliDeps, prefix: string): Policy {
  const p = d.store.update((p) => {
    p.passkeys = p.passkeys.filter((k) => !k.credentialId.startsWith(prefix));
    return p;
  });
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
  const p = d.store.update((p) => {
    p.signingKeys = [
      ...p.signingKeys.filter((k) => k.keyId !== keyId),
      { keyId, keyFile: o.keyFile, autoSign: !!o.autoSign },
    ];
    return p;
  });
  d.out(
    `Signing key ${keyId} registered (only its path is stored)${o.autoSign ? ', signing unattended' : '; every signing asks'}.`,
  );
  return p;
}

export function signingRemoveKey(d: PolicyCliDeps, keyId: string): Policy {
  return d.store.update((p) => {
    p.signingKeys = p.signingKeys.filter((k) => k.keyId !== keyId.toUpperCase());
    return p;
  });
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

  program
    .command('policy')
    .description("print this workstation's local policy (policy.json)")
    .action(
      run(() => {
        const d = make();
        const r = d.store.read();
        if (r.error) d.out(`INVALID (${r.error}): the safe defaults apply until it is fixed`);
        d.out(d.store.file);
        show(d, r.policy);
      }),
    );
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

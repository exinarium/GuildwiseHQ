import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Approvals } from '../src/policy/approvals.ts';
import {
  approve,
  deny,
  devopsGrant,
  devopsList,
  devopsRequests,
  type PolicyCliDeps,
  passkeyTrust,
  signingAddKey,
} from '../src/policy/cli.ts';
import { gateCommand } from '../src/policy/gate.ts';
import { capDetail, HeldStore } from '../src/policy/held.ts';
import { PasskeyStore } from '../src/policy/passkey-store.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { FIXTURES } from './minisign-helper.ts';

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ORG = '0190a000-0000-7000-8000-000000000001';
const AGENT = '0190a000-0000-7000-8000-000000000002';

function env(o: { setupDone?: boolean; answer?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aom-policy-'));
  const store = new PolicyStore(dir);
  store.write({ ...store.get(), setupDone: o.setupDone ?? true });
  const held = new HeldStore(dir);
  const passkeys = new PasskeyStore(dir);
  const out: string[] = [];
  const cli: PolicyCliDeps = {
    store,
    held,
    passkeys,
    out: (l) => out.push(l),
    ask: async () => o.answer ?? 'yes',
    minisignAvailable: () => true,
  };
  const sent: unknown[] = [];
  const executed: string[] = [];
  const refused: string[] = [];
  const approvals = new Approvals({
    policy: store,
    held,
    passkeys,
    pairing: '/data/pairing-1',
    serverOrigin: 'https://hq.example',
    send: (_t, p) => sent.push(p),
    execute: async (r) => {
      executed.push(r.id);
    },
    refuse: (r, why) => refused.push(`${r.id}:${why}`),
    log: quiet,
  });
  return { dir, store, held, cli, out, approvals, sent, executed, refused };
}

const recipeWrite = {
  projectId: 'p1',
  files: [{ path: 'deploy.sh', mode: '755', content: 'echo hi' }],
  commitMessage: 'm',
};

describe('held items and `guildwise-runner approve|deny` (R18-S)', () => {
  it('an inserted recipe.write is held, reported to the server, and runs only after approve', async () => {
    const t = env();
    const d = gateCommand(t.store.get(), 'recipe.write', recipeWrite);
    if (d.action !== 'hold') throw new Error('expected hold');
    const r = t.approvals.hold({
      decision: d,
      commandId: 'cmd-1',
      replay: { type: 'command', body: { commandId: 'cmd-1' } },
    });
    expect(t.sent.at(-1)).toMatchObject({ items: [{ id: r.id, kind: 'recipe.write', commandId: 'cmd-1' }] });
    await t.approvals.tick();
    expect(t.executed).toEqual([]);
    // the same command again (a re-delivery) is not held twice
    t.approvals.hold({ decision: d, commandId: 'cmd-1', replay: { type: 'command', body: {} } });
    expect(t.held.list()).toHaveLength(1);
    await approve(t.cli, r.id);
    expect(t.out.join('\n')).toMatch(/deploy\.sh[\s\S]*echo hi/); // the command as received
    await t.approvals.tick();
    expect(t.executed).toEqual([r.id]);
    expect(t.held.list()).toHaveLength(0);
    expect(t.sent.at(-1)).toEqual({ items: [] });
  });

  it('held files are mode 600 and only the CLI decision makes them run', async () => {
    const t = env();
    const d = gateCommand(t.store.get(), 'vault.configure', { vaultId: 'v' });
    if (d.action !== 'hold') throw new Error('expected hold');
    const r = t.approvals.hold({ decision: d, replay: { type: 'command', body: {} } });
    expect(statSync(join(t.held.dir, `${r.id}.json`)).mode & 0o777).toBe(0o600);
  });

  it('deny and expiry tell the server it will not run', async () => {
    const t = env();
    const d = gateCommand(t.store.get(), 'vault.configure', { vaultId: 'v' });
    if (d.action !== 'hold') throw new Error('expected hold');
    const a = t.approvals.hold({ decision: d, commandId: 'a', replay: { type: 'command', body: {} } });
    deny(t.cli, a.id);
    await t.approvals.tick();
    expect(t.refused).toEqual([`${a.id}:denied on the workstation`]);
    const late = new Approvals({
      ...(t.approvals as unknown as { deps: ConstructorParameters<typeof Approvals>[0] }).deps,
      now: () => Date.now() + 25 * 3_600_000,
    });
    const b = t.approvals.hold({ decision: d, commandId: 'b', replay: { type: 'command', body: {} } });
    await late.tick();
    expect(t.refused.at(-1)).toBe(`${b.id}:not approved on the workstation within 24 hours`);
    expect(t.executed).toEqual([]);
  });

  it('approve refuses without a terminal, on a typed "no", and while setup is pending', async () => {
    const t = env();
    const d = gateCommand(t.store.get(), 'vault.configure', { vaultId: 'v' });
    if (d.action !== 'hold') throw new Error('expected hold');
    const r = t.approvals.hold({ decision: d, replay: { type: 'command', body: {} } });
    const { ask: _ask, ...noTty } = t.cli;
    await expect(approve(noTty, r.id)).rejects.toThrow(/terminal/);
    await expect(approve({ ...t.cli, ask: async () => 'y' }, r.id)).rejects.toThrow(/not approved/);
    t.store.write({ ...t.store.get(), setupDone: false });
    await expect(approve(t.cli, r.id)).rejects.toThrow(/setup pending/);
    expect(t.held.get(r.id)?.state).toBe('held');
  });

  it('approve --pin writes the whole-command pin (and the commit-bound one with deployPinCommit)', async () => {
    const t = env();
    t.store.update((p) => ({ ...p, deployPinCommit: true }));
    const r = t.approvals.hold({
      decision: {
        action: 'hold',
        kind: 'deploy.exec',
        summary: 'deploy',
        detail: 'deploy',
        commandHash: 'c'.repeat(64),
        pin: { base: 'a'.repeat(64), bound: 'b'.repeat(64) },
      },
      replay: { type: 'command', body: {} },
    });
    await approve(t.cli, r.id, { pin: true });
    expect(t.store.get().deployPins).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  });
});

describe('a very large approval text (Follow-up 3)', () => {
  it('is capped with a clear marker and the item is still held', () => {
    const t = env();
    const big = `#!/bin/sh\n${'echo x\n'.repeat(50_000)}`; // 350,010 characters
    const r = t.approvals.hold({
      decision: {
        action: 'hold',
        kind: 'deploy.exec',
        summary: 's',
        detail: big,
        commandHash: 'c'.repeat(64),
      },
      commandId: 'big',
      replay: { type: 'command', body: {} },
    });
    const stored = t.held.get(r.id);
    expect(stored?.state).toBe('held');
    expect(stored?.detail.length).toBeLessThanOrEqual(200_000);
    expect(stored?.detail).toMatch(
      /\(truncated, \d+ more characters; read the full recipe in the vault before approving\)$/,
    );
    expect(capDetail('short')).toBe('short');
    // the marker counts what was cut: kept text + cut = the original
    const n = Number(/truncated, (\d+) more/.exec(stored?.detail ?? '')?.[1]);
    expect((stored?.detail.indexOf('\n... (truncated') ?? 0) + n).toBe(big.length);
  });
});

describe('passkey approvals during setup pending (round-1 should-fix 3)', () => {
  it('are refused, like approve', async () => {
    const t = env({ setupDone: false });
    const r = t.approvals.hold({
      decision: {
        action: 'hold',
        kind: 'recipe.write',
        summary: 's',
        detail: 'd',
        commandHash: 'c'.repeat(64),
      },
      replay: { type: 'command', body: {} },
    });
    const out = await t.approvals.onPasskeyAssertion({
      itemId: r.id,
      credentialId: 'Y3JlZA',
      authenticatorData: 'AA',
      clientDataJSON: 'AA',
      signature: 'AA',
    });
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/setup pending/) });
    expect(t.held.get(r.id)?.state).toBe('held');
  });
});

describe('local grants are written only by the CLI (R18-S)', () => {
  it('devops grant and requests auto (no sudo grant exists since 1.10.0)', async () => {
    const t = env();
    devopsGrant(t.cli, ORG, AGENT);
    expect(t.store.get().devops.agents).toEqual({ [ORG]: AGENT });
    devopsRequests(t.cli, 'auto');
    expect(t.store.get()).toMatchObject({ devops: { agents: { [ORG]: AGENT } }, devopsRequests: 'auto' });
    expect(t.store.get().devops).not.toHaveProperty('sudo');
    expect(statSync(t.store.file).mode & 0o777).toBe(0o600);
  });

  it('devops list shows the ids `grant` takes (UAT 1.10.0 bug 5); grant without --agent takes the offered engineer', () => {
    const t = env();
    const OTHER = '0190a000-0000-7000-8000-000000000003';
    t.cli.offers = () => [
      { orgId: ORG, orgName: 'Acme', role: 'owner', devopsAgentId: AGENT },
      { orgId: OTHER, orgName: 'Beta', role: 'member' },
    ];
    devopsList(t.cli);
    const text = t.out.join('\n');
    expect(text).toContain(`Acme  organization ${ORG}  (the server says you are owner)`);
    expect(text).toContain(`DevOps engineer: agent ${AGENT}`);
    expect(text).toContain(`to grant: guildwise-runner devops grant ${ORG} --agent ${AGENT}`);
    expect(text).toContain(`Beta  organization ${OTHER}`);
    expect(text).toContain('none on this workstation yet');
    t.out.length = 0;
    devopsGrant(t.cli, ORG);
    expect(t.store.get().devops.agents).toEqual({ [ORG]: AGENT });
    expect(() => devopsGrant(t.cli, OTHER)).toThrow(/devops list/);
    expect(() => devopsGrant(t.cli, 'not-an-id', AGENT)).toThrow(/devops list/);
    t.out.length = 0;
    devopsList(t.cli);
    expect(t.out.join('\n')).toContain(`local grant: agent ${AGENT}`);
    // nothing offered and nothing granted: says why
    const u = env();
    u.cli.offers = () => [];
    devopsList(u.cli);
    expect(u.out.join('\n')).toContain('No organization offers a DevOps engineer');
  });

  it('an invalid policy.json grants nothing and is never silently replaced', () => {
    const t = env();
    writeFileSync(t.store.file, '{"devops": {"agents": {"x": "y"}}}');
    expect(t.store.read().error).toBeTruthy();
    expect(t.store.get().devops.agents).toEqual({});
    expect(() => devopsGrant(t.cli, ORG, AGENT)).toThrow(/not a valid policy/);
  });

  it('a passkey offer is not trusted until `passkey trust` with a local yes', async () => {
    const t = env();
    t.approvals.onPasskeyOffer({
      passkeyId: '0190a000-0000-7000-8000-000000000030',
      credentialId: 'Y3JlZGVudGlhbC1pZC0xMjM0',
      publicKey: 'MFkw',
      alg: -7,
      name: 'laptop',
      createdAt: '2026-11-21T09:00:00.000Z',
      rpId: 'hq.example',
      origin: 'https://hq.example/',
    });
    expect(t.store.get().passkeys).toEqual([]);
    await expect(passkeyTrust({ ...t.cli, ask: async () => 'no' })).rejects.toThrow(/not trusted/);
    expect(t.store.get().passkeys).toEqual([]);
    await passkeyTrust(t.cli);
    // the same 12-character credential id prefix the web shows
    expect(t.out.join('\n')).toContain('credential Y3JlZGVudGlh...');
    expect(t.store.get().passkeys).toMatchObject([
      { credentialId: 'Y3JlZGVudGlhbC1pZC0xMjM0', origin: 'https://hq.example', rpId: 'hq.example' },
    ]);
  });

  it('signing add-key stores the path only; autoSign is refused for a passphrase key and needs a typed confirmation', async () => {
    const t = env();
    await expect(
      signingAddKey(t.cli, {
        keyId: '8399E5B65A3876B0',
        keyFile: join(FIXTURES, 'protected.key'),
        autoSign: true,
      }),
    ).rejects.toThrow(/passphrase/);
    await expect(
      signingAddKey(t.cli, {
        keyId: '8399E5B65A3876B0',
        keyFile: join(FIXTURES, 'test.key'),
        autoSign: true,
      }),
    ).rejects.toThrow(/not changed/); // "yes" is not the typed confirmation
    await signingAddKey(
      { ...t.cli, ask: async () => 'auto-sign 8399E5B65A3876B0' },
      { keyId: '8399e5b65a3876b0', keyFile: join(FIXTURES, 'test.key'), autoSign: true },
    );
    await signingAddKey(t.cli, { keyId: 'F0D6288B1CBE00A7', keyFile: join(FIXTURES, 'protected.key') });
    expect(t.store.get().signingKeys).toEqual([
      { keyId: '8399E5B65A3876B0', keyFile: join(FIXTURES, 'test.key'), autoSign: true },
      { keyId: 'F0D6288B1CBE00A7', keyFile: join(FIXTURES, 'protected.key'), autoSign: false },
    ]);
    // nothing but the path: the policy file never holds key material
    expect(JSON.stringify(t.store.get())).not.toMatch(/RWS|untrusted comment/);
    await expect(
      signingAddKey(
        { ...t.cli, minisignAvailable: () => false },
        { keyId: 'F0D6288B1CBE00A7', keyFile: join(FIXTURES, 'test.key') },
      ),
    ).rejects.toThrow(/minisign is not installed/);
  });
});

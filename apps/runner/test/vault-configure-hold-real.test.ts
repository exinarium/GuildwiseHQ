import { afterEach, describe, expect, it } from 'vitest';
import { FileAuthority } from '../src/policy/authority.ts';
import { commandHashOf } from '../src/policy/gate.ts';
import { HeldStore } from '../src/policy/held.ts';
import { ensurePolicyKey } from '../src/policy/integrity.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { type Harness, startHarness } from './harness.ts';
import { tmp, waitUntil } from './helpers.ts';

/**
 * UAT 1.10.0 finding 1 on the real hold path: the runner end to end, the real local authority and held store. The UAT
 * log line "held vault.configure d4a43a11f8 for a local approval: vault.configure for  (...)" has the format of runners
 * before f80fc0d9 and the summary of runners before 2f37f084: the item was written by an older runner and survived the
 * reinstall in <policy dir>/held/. This runner showed it unchanged on the approvals page, the Desk and the CLI.
 */
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const configure = (commandId: string, remote = 'https://git.example/acme/knowledge.git') => ({
  commandId,
  command: 'vault.configure' as const,
  payload: {
    vaults: [
      { vaultId: 'k1', kind: 'org_knowledge', name: 'Knowledge', remoteUrl: remote, syncIntervalSec: 60 },
      {
        vaultId: 'l1',
        kind: 'org_knowledge',
        name: 'Notes',
        remoteUrl: '',
        syncIntervalSec: 60,
        storage: 'local',
      },
    ],
    identity: { name: 'Dee (aom)', email: 'd@agents.guildwise.invalid' },
    workstationName: 'Desk',
    resume: [],
  },
});

function setUp() {
  const policyDir = tmp('aom-policy-');
  const store = new PolicyStore(policyDir);
  store.write({ ...store.get(), setupDone: true });
  return { policyDir, dataDir: tmp('aom-data-'), authority: new FileAuthority(store) };
}

describe('vault.configure holds always name their target (real path)', () => {
  it('a fresh hold: the log line, approvals.held (page and Desk) and the copy command name the vaults', async () => {
    const s = setUp();
    const lines: string[] = [];
    const rec = (l: string) => lines.push(l);
    h = await startHarness({}, { ...s, approvalsPollMs: 50, log: { info: rec, warn: rec, error: rec } });
    h.server.send('command', configure('c-vault-1'));
    const held = await h.server.waitFor('approvals.held', (m) =>
      m.items.some((i) => i.kind === 'vault.configure'),
    );
    const item = held.items.find((i) => i.kind === 'vault.configure');
    expect(item?.summary).toMatch(
      /^vault\.configure for 2 vaults \(Knowledge, Notes\): new online location /,
    );
    expect(item?.command).toMatch(new RegExp(`approve ${item?.id}$`));
    const line = lines.find((l) => l.startsWith(`held vault.configure ${item?.id}:`)) ?? '';
    expect(line).toContain('vault.configure for 2 vaults (Knowledge, Notes)');
    expect(line).not.toMatch(/for {2}|for \(/);
  });

  it('an item an older runner held with an empty target is shown with its target after the upgrade', async () => {
    const s = setUp();
    const c = configure('c-vault-old');
    const old = {
      id: 'd4a43a11f8',
      kind: 'vault.configure',
      pairing: s.dataDir,
      commandId: c.commandId,
      summary: 'vault.configure for ',
      detail: 'vault.configure',
      commandHash: commandHashOf(c.command, c.payload),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      replay: { type: 'command', body: c },
      state: 'held' as const,
    };
    // a runner of the sealed era held it (runner-authority-fixes: items from before the seal are refused at adoption)
    ensurePolicyKey(s.policyDir);
    s.authority.store.write({ ...s.authority.store.get(), setupDone: true });
    new HeldStore(s.policyDir).put(old);
    h = await startHarness({}, { ...s, approvalsPollMs: 50 });
    const held = await h.server.waitFor('approvals.held', (m) => m.items.some((i) => i.id === old.id));
    expect(held.items.find((i) => i.id === old.id)?.summary).toMatch(
      /^vault\.configure for 2 vaults \(Knowledge, Notes\)/,
    );
    expect(new HeldStore(s.policyDir).get(old.id)?.summary).toMatch(/2 vaults/);
    // the server sends the same command again (every welcome): still one item, still named
    h.server.send('command', c);
    await new Promise((r) => setTimeout(r, 300));
    const items = new HeldStore(s.policyDir).list().filter((r) => r.kind === 'vault.configure');
    expect(items.map((r) => r.id)).toEqual([old.id]);
  });

  it('a newer vault set-up replaces an older held one (replace semantics): one item, the newest', async () => {
    const s = setUp();
    h = await startHarness({}, { ...s, approvalsPollMs: 50 });
    h.server.send('command', configure('c-a'));
    await h.server.waitFor('approvals.held', (m) => m.items.some((i) => i.commandId === 'c-a'));
    h.server.send('command', configure('c-b', 'https://git.example/acme/other.git'));
    await waitUntil(
      () => {
        const items = new HeldStore(s.policyDir).list().filter((r) => r.kind === 'vault.configure');
        return items.length === 1 && items[0]?.commandId === 'c-b';
      },
      5000,
      'one held vault set-up, the newest',
    );
  });
});

describe('REVIEW S3: vault names from the server', () => {
  it('lose control and bidi characters in the held summary', async () => {
    const { heldTarget } = await import('../src/policy/gate.ts');
    const t = heldTarget('vault.configure', {
      vaults: [{ vaultId: 'k', name: 'Know\u202Eledge\u001b[2J', remoteUrl: 'https://g.example/k.git' }],
    });
    expect(t).toBe('1 vault (Knowledge[2J)');
  });
});

describe('Rework 2: held approval text from the server', () => {
  it('loses control and bidi characters but keeps its line breaks', async () => {
    const { plainDetail } = await import('../src/policy/gate.ts');
    expect(plainDetail('line one ‮gnp.exe⁦\n\tline two\u001b[31m\u0007')).toBe(
      'line one gnp.exe\n\tline two[31m',
    );
  });
});

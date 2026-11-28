import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShiftStartInput } from '../src/adapters/types.ts';
import type { GuardConfig } from '../src/devops/guard.ts';
import { FileAuthority } from '../src/policy/authority.ts';
import { approve, defaultCliDeps } from '../src/policy/cli.ts';
import { HeldStore } from '../src/policy/held.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { type Harness, startHarness } from './harness.ts';
import { tmp } from './helpers.ts';
import { type Ctl, ScriptedAdapter } from './scripted-adapter.ts';
import { makeDevopsStart } from './vault-fixtures.ts';

/**
 * gate-fixes-3 (blocker 5) through the runner: AC4 (a repeat of an approved command never becomes a Desk item), R2-1 (a
 * `toolchain_fixed` command is answered by the runner), S1 (the runner's own grant lines in the local hold) and (c) (the
 * outside run gets the toolchain write only with the "download tools" tick).
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const ORG = '0190a000-0000-7000-8000-000000000001';

/** What claude-code keeps in memory for an outer box: the access switches, approvals and the toolchain write. */
const guardOf = (input: ShiftStartInput): GuardConfig => ({
  sessionRef: input.shiftId,
  kind: 'shift',
  deleteRoots: [],
  home: homedir(),
  protectedBranches: [],
  approvedCommands: input.devopsGuard?.approvedCommands ?? [],
  frozenBranches: [],
  ...(input.devopsGuard?.access
    ? {
        access: input.devopsGuard.access,
        writeRoots: [input.sandbox.home, input.sandbox.scratch, input.sandbox.tmp, tmpdir(), '/tmp'],
      }
    : {}),
  ...(input.toolchainWrite
    ? {
        toolchainWrite: {
          roots: [input.toolchainWrite.root],
          dirs: [input.toolchainWrite.dir],
          pinned: input.toolchainWrite.pinned,
        },
      }
    : {}),
});

class GuardedBox extends ScriptedAdapter {
  boxMissing(): string | null {
    return null;
  }
  override async start(input: ShiftStartInput) {
    const s = await super.start(input);
    return input.devopsBox ? s : Object.assign(s, { guardConfig: guardOf(input) });
  }
}

const askApproval = (ctl: Ctl, commands: string[], blockedBy?: string) =>
  ctl.post('/v1/report', {
    report: {
      kind: 'outcome',
      outcomeId: 'devops_approval',
      note: 'Needs approval',
      data: { action: 'run it', reason: 'needed', commands, ...(blockedBy ? { blockedBy } : {}) },
    },
  });

/** One DevOps job: the box session leaves the box, the local yes runs it outside, where `outside` runs. */
async function outsideRun(
  outside: (input: ShiftStartInput, ctl: Ctl) => Promise<void>,
  o: { policy?: Record<string, unknown>; approval?: string[]; needs?: string } = {},
) {
  const dir = tmp('aom-gf3-policy-');
  const store = new PolicyStore(dir);
  store.write({ ...store.get(), setupDone: true, ...(o.policy ?? {}) });
  let calls = 0;
  const adapter = new GuardedBox(async (input, ctl) => {
    calls++;
    if (calls === 1) {
      await ctl.post('/v1/rpc', {
        method: 'devops.outside',
        params: { needs: o.needs ?? 'network access to github.com', why: 'install a tool' },
      });
      await new Promise<void>((r) => ctl.signal.addEventListener('abort', () => r()));
      return;
    }
    await outside(input, ctl);
  });
  const toolchains = tmp('aom-gf3-tc-');
  h = await startHarness(
    {},
    {
      authority: new FileAuthority(store),
      policyDir: dir,
      approvalsPollMs: 50,
      adapters: new Map([['mock', adapter]]),
      toolchainsRoot: toolchains,
    },
  );
  const agentId = uuidv7();
  store.update((p) => ({ ...p, devops: { agents: { [ORG]: agentId } } }));
  const base = makeDevopsStart({
    summary: 'install jq',
    agentId,
    access: { allowInstall: false, allowDocker: false, sudo: false, allowedPaths: [] },
    ...(o.approval ? { approval: { action: 'run it', reason: 'r', commands: o.approval } } : {}),
  }) as Record<string, any>;
  const msg = { ...base, orgId: ORG } as Record<string, any>;
  h.server.send('shift.start', msg);
  const heldMsg = await h.server.waitFor('approvals.held', (m) =>
    m.items.some((i) => i.kind === 'devops.task'),
  );
  const item = heldMsg.items.find((i) => i.kind === 'devops.task');
  const held = new HeldStore(dir).list().find((r) => r.id === item?.id);
  await approve({ ...defaultCliDeps(dir), ask: async () => 'yes', out: () => undefined }, item?.id as string);
  await h.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
  return { msg, adapter, harness: h, held, toolchains };
}

const approvalReports = (hh: Harness, shiftId: string) =>
  hh.server
    .of('shift.report')
    .filter(
      (m) => m.shiftId === shiftId && (m.report as { outcomeId?: string }).outcomeId === 'devops_approval',
    );

const done = (ctl: Ctl) =>
  ctl.post('/v1/report', {
    report: {
      kind: 'outcome',
      outcomeId: 'devops_done',
      note: 'done',
      data: { summary: 'done', commands: [] },
    },
  });

describe('gate-fixes-3 AC4: a repeat of an approved command is answered by the runner, never sent', () => {
  const CMD = 'mkdir -p /srv/gf3-app/conf';

  it('`--switch allowedPaths` for an already approved command is rejected and no shift.report goes out', async () => {
    const seen: Record<string, any> = {};
    const r = await outsideRun(
      async (_input, ctl) => {
        seen.repeat = await askApproval(ctl, [CMD], 'allowedPaths');
        await done(ctl);
      },
      { approval: [CMD] },
    );
    expect(seen.repeat.json.accepted).toBe(false);
    expect(String(seen.repeat.json.message ?? seen.repeat.json.error)).toContain('already approved');
    expect(approvalReports(r.harness, r.msg.shiftId)).toEqual([]);
  }, 120_000);

  it('N1: a list mixing a new command with an approved one still goes through', async () => {
    const seen: Record<string, any> = {};
    const r = await outsideRun(
      async (_input, ctl) => {
        seen.mixed = await askApproval(ctl, [CMD, 'echo x > /srv/gf3-app/other'], 'allowedPaths');
      },
      { approval: [CMD] },
    );
    expect(String(seen.mixed.json.message ?? seen.mixed.json.error ?? '')).not.toContain('already approved');
    expect(approvalReports(r.harness, r.msg.shiftId)).toHaveLength(1);
  }, 120_000);
});

describe('gate-fixes-3 (c), S1, R2-1: the toolchain write of an outside run', () => {
  it('with the tick: the hold names the download hosts and the folder; the outside run gets the write; a toolchain_fixed ask is answered here', async () => {
    const seen: Record<string, any> = {};
    const r = await outsideRun(
      async (input, ctl) => {
        seen.input = input;
        // R2-1: a write in the tool folder outside devops/ is a hard refusal; asking for it reaches no Desk
        seen.fixed = await askApproval(
          ctl,
          [`mkdir -p ${input.toolchainWrite?.root}/bun/1.4.5`],
          'allowedPaths',
        );
        // REVIEW S-2: a write the guard does not parse (curl -o) into the tool folder outside devops/: answered here too
        seen.unparsed = await askApproval(ctl, [
          `curl -L -o ${input.toolchainWrite?.root}/bun/bun https://github.com/oven-sh/bun/releases/download/x`,
        ]);
        await done(ctl);
      },
      // S1: the helper's own words never add a host
      { policy: { toolInstall: true }, needs: 'network access to evil.com' },
    );
    const detail = r.held?.detail ?? '';
    expect(detail).toContain('release-assets.githubusercontent.com');
    expect(detail).toContain(join(r.toolchains, 'devops'));
    expect(detail).toContain('toolchain approve');
    const runnerPart = detail.slice(detail.indexOf('set by this computer'));
    expect(runnerPart).not.toContain('evil.com');
    expect(seen.input.toolchainWrite).toEqual({
      root: r.toolchains,
      dir: join(r.toolchains, 'devops'),
      pinned: [],
    });
    expect(seen.fixed.json.accepted).toBe(false);
    expect(String(seen.fixed.json.message ?? seen.fixed.json.error)).toContain('No approval opens it');
    expect(seen.unparsed.json.accepted).toBe(false);
    expect(String(seen.unparsed.json.message ?? seen.unparsed.json.error)).toContain('No approval opens it');
    expect(approvalReports(r.harness, r.msg.shiftId)).toEqual([]);
  }, 120_000);

  it('without the tick: no grant lines, no toolchain write', async () => {
    const seen: Record<string, any> = {};
    const r = await outsideRun(async (input, ctl) => {
      seen.input = input;
      await done(ctl);
    });
    expect(r.held?.detail ?? '').not.toContain('release-assets');
    expect(seen.input.toolchainWrite).toBeNull();
  }, 120_000);
});

describe('gate-fixes-3 (S2): `aom toolchain ensure` of a catalogued tool the project does not use', () => {
  async function ensureWith(tool: string, policy: Record<string, unknown>, repo: boolean) {
    const dir = tmp('aom-gf3-policy-');
    const store = new PolicyStore(dir);
    store.write({ ...store.get(), setupDone: true, ...policy });
    h = await startHarness({}, { authority: new FileAuthority(store), policyDir: dir });
    const calls: Array<{ payload: any; opts: any }> = [];
    const runner = h.runner as unknown as {
      ensureEnv: (payload: unknown, opts: unknown) => Promise<unknown>;
      toolchainEnsure: (
        msg: unknown,
        tool: string,
      ) => Promise<{ ok: boolean; error?: string; result?: unknown }>;
    };
    runner.ensureEnv = async (payload, opts) => {
      calls.push({ payload, opts });
      return { tools: [{ stack: 'extra', tool: 'Bun', status: 'installed', version: '1.4.5' }], summary: '' };
    };
    const base = makeDevopsStart({ summary: 'install bun', agentId: uuidv7() }) as Record<string, any>;
    const msg = repo
      ? { ...base, devops: { ...base.devops, card: { remoteUrlNormalized: 'github.com/acme/app' } } }
      : { ...base, devops: { ...base.devops, card: undefined }, postAs: undefined };
    return { r: await runner.toolchainEnsure(msg, tool), calls };
  }

  it('bun: installed with no repository and no lockfile (extraTools), no question', async () => {
    const { r, calls } = await ensureWith('bun', { toolInstall: true }, false);
    expect(r.ok).toBe(true);
    expect(calls[0]?.opts).toEqual({ toolsOnly: true, onlyTools: ['node-bun'], extraTools: ['node-bun'] });
  }, 60_000);

  it('an undetected node is refused (its version is the vendor latest); tick off and an unknown tool are unchanged', async () => {
    const node = await ensureWith('node', { toolInstall: true }, false);
    expect(node.r.ok).toBe(false);
    expect(node.r.error).toContain('not needed by this project');
    expect(node.calls).toEqual([]);
    await (h as Harness | undefined)?.stop();
    h = undefined;
    const off = await ensureWith('bun', { toolInstall: false }, false);
    expect(off.r.ok).toBe(false);
    expect(off.r.error).toContain('not allowed without asking');
    expect(off.calls).toEqual([]);
    await (h as Harness | undefined)?.stop();
    h = undefined;
    const foo = await ensureWith('foo', { toolInstall: true }, true);
    expect(foo.calls[0]?.opts).toEqual({ toolsOnly: true, onlyTools: ['foo'] });
  }, 120_000);
});

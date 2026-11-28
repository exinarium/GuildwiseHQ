import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { probeHarnessSandbox } from '../src/adapters/harness-session.ts';
import { probeBwrap } from '../src/box/bwrap.ts';
import { TOOLCHAIN_WRITER_LOCK, TreePins, withNoToolchainWriter } from '../src/box/tool-box.ts';
import { ensurePolicyKey } from '../src/policy/integrity.ts';
import { binHome } from './bin-home.ts';
import { tmp } from './helpers.ts';

/**
 * gate-fixes-3 (c), B1, S6, R2-3 with the real bubblewrap through ClaudeCodeAdapter: an approved outside run with the
 * "download tools" tick writes a NEW `<tcRoot>/devops/<tool>/<version>`; a pinned version stays read-only and cannot be
 * renamed or removed, also when a Desk folder grant covers the whole tool folder; the rest of the tool folder is not
 * writable; the writer lock lives exactly as long as the run.
 */

const bwrapOk = process.platform === 'linux' && probeBwrap().ok && probeHarnessSandbox().ok;

async function outerRun(o: {
  grantShare: boolean;
  script: (tc: string, out: string) => string;
  /** Make the tool folder group-writable: the folder check drops the grant (fail closed). */
  breakGrant?: boolean;
  /** REVIEW B-1: leave `old/1.0` unpinned at the start; `afterWriter` runs right after the writer entry is added. */
  unpinned?: boolean;
  afterWriter?: (w: { policy: string; tc: string; pinned: string }) => void;
}) {
  const { ClaudeCodeAdapter } = await import('../src/adapters/claude-code.ts');
  const { ClaudeRuntimeConfigSchema } = await import('../src/config.ts');
  const { runnerPaths } = await import('../src/paths.ts');
  const { ensureSandbox } = await import('../src/sandbox/sandbox.ts');
  const home = realpathSync(tmp('aom-gf3-home-'));
  const policy = join(home, '.config', 'aom-runner');
  mkdirSync(policy, { recursive: true });
  const share = join(home, '.local', 'share');
  const tc = join(share, 'guildwise', 'toolchains');
  // an approved DevOps tool (pinned) and a runner-installed one
  const pinned = join(tc, 'devops', 'old', '1.0');
  mkdirSync(pinned, { recursive: true });
  writeFileSync(join(pinned, 'tool'), 'v1\n', { mode: 0o755 });
  mkdirSync(join(tc, 'node'), { recursive: true });
  // the folder check wants them owned by this account and not group- or other-writable (whatever the test's umask)
  for (const d of [tc, join(tc, 'devops'), join(tc, 'devops', 'old'), pinned, join(tc, 'node')])
    chmodSync(d, 0o755);
  if (o.breakGrant) chmodSync(tc, 0o775);
  // the approved version has its pin record (the box reads the pinned list fresh from it, REVIEW B-1)
  ensurePolicyKey(policy);
  if (!o.unpinned) new TreePins(policy, () => {}, { toolchainsRoot: tc }).pin([pinned]);
  const root = join(home, '.aom-runner');
  const paths = runnerPaths(root);
  const sb = await ensureSandbox(paths, '019e3f6a-7b1c-7a2d-8c3e-0123456789a1', 'Forge');
  const requestId = '019e3f6a-7b1c-7a2d-8c3e-0123456789b2';
  const cwd = join(sb.root, 'devops', requestId);
  mkdirSync(cwd, { recursive: true });
  const out = join(cwd, 'out.txt');
  const bin = join(binHome(), 'claude');
  writeFileSync(bin, `#!/bin/sh\n${o.script(tc, out)}\nsleep 1\nexit 0\n`, { mode: 0o755 });
  const savedPolicy = process.env.AOM_RUNNER_POLICY_DIR;
  process.env.AOM_RUNNER_POLICY_DIR = policy;
  process.env.AOM_CLAUDE_SMOKE = '1';
  let lockDuring = '';
  let guardCfg: Record<string, any> | undefined;
  try {
    const adapter = new ClaudeCodeAdapter(
      ClaudeRuntimeConfigSchema.parse({
        bin,
        sandbox: 'required',
        authMode: 'api_key',
        apiKey: 'sk-ant-test-key',
      }),
      paths,
      {
        home,
        ...(o.afterWriter ? { afterToolchainWriter: () => o.afterWriter?.({ policy, tc, pinned }) } : {}),
      } as never,
    );
    const perms = BUILTIN_ROLES.find((r) => r.key === 'devops')?.permissions;
    const s = await adapter.start({
      shiftId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
      prompt: 'go',
      instructionsMarkdown: '',
      kind: 'devops',
      cwd,
      sandbox: sb,
      agent: {
        agentId: 'a',
        name: 'Forge',
        roleKey: 'devops',
        seniority: 'senior',
        runtime: 'claude-code',
        model: 'claude-opus-5-5',
        skills: [],
        permissions: perms,
        isDevops: true,
      },
      env: { PATH: '/usr/bin:/bin' },
      addDirs: [],
      readDirs: [],
      toolchainReadDirs: [tc],
      maxShiftMinutes: 5,
      boxRequestId: requestId,
      ceilingRoots: o.grantShare ? [share] : [],
      // the start-time snapshot is empty: what counts is the fresh read after the writer entry
      toolchainWrite: { root: tc, dir: join(tc, 'devops'), pinned: [] },
      devopsGuard: {
        sessionRef: 's',
        shiftKind: 'devops',
        protectedBranches: [],
        approvedCommands: [],
        access: { allowInstall: false, allowDocker: false, allowedPaths: o.grantShare ? [share] : [] },
      },
    } as never);
    guardCfg = (s as unknown as { guardConfig?: Record<string, any> }).guardConfig;
    lockDuring = existsSync(join(policy, TOOLCHAIN_WRITER_LOCK))
      ? readFileSync(join(policy, TOOLCHAIN_WRITER_LOCK), 'utf8')
      : '';
    for await (const _e of s.events()) {
      // drain
    }
  } finally {
    delete process.env.AOM_CLAUDE_SMOKE;
    if (savedPolicy === undefined) delete process.env.AOM_RUNNER_POLICY_DIR;
    else process.env.AOM_RUNNER_POLICY_DIR = savedPolicy;
  }
  return {
    tc,
    pinned,
    out: existsSync(out) ? readFileSync(out, 'utf8') : '',
    lockDuring,
    lockAfter: existsSync(join(policy, TOOLCHAIN_WRITER_LOCK)),
    guardCfg,
  };
}

const PROBES = (tc: string, out: string) => `
mkdir -p ${tc}/devops/jq/1.7 && echo jq > ${tc}/devops/jq/1.7/jq && echo NEW-OK >> ${out}
mkdir ${tc}/devops/old/1.1 && echo NEW-VERSION-OK >> ${out}
echo x > ${tc}/devops/old/1.0/tool 2>/dev/null && echo PINNED-WRITTEN >> ${out}
echo x > ${tc}/devops/old/1.0/extra 2>/dev/null && echo PINNED-ADDED >> ${out}
mv ${tc}/devops/old/1.0 ${tc}/devops/old/1.9 2>/dev/null && echo PINNED-RENAMED >> ${out}
mv ${tc}/devops/old ${tc}/devops/old2 2>/dev/null && echo TOOL-RENAMED >> ${out}
rm -rf ${tc}/devops/old/1.0 2>/dev/null
[ -f ${tc}/devops/old/1.0/tool ] && echo PINNED-KEPT >> ${out}
echo x > ${tc}/node/x 2>/dev/null && echo ROOT-WRITTEN >> ${out}
`;

describe.skipIf(!bwrapOk)('gate-fixes-3 (c), B1: the outer box writes only new DevOps tool versions', () => {
  it('a new devops/<tool>/<version> is written; the pinned one is read-only, never renamed or removed; the rest of the tool folder is not writable; the writer lock lives with the run', async () => {
    const r = await outerRun({ grantShare: false, script: PROBES });
    expect(r.out).toContain('NEW-OK');
    expect(r.out).toContain('NEW-VERSION-OK');
    expect(r.out).toContain('PINNED-KEPT');
    for (const bad of ['PINNED-WRITTEN', 'PINNED-ADDED', 'PINNED-RENAMED', 'TOOL-RENAMED', 'ROOT-WRITTEN'])
      expect(r.out).not.toContain(bad);
    expect(readFileSync(join(r.tc, 'devops', 'jq', '1.7', 'jq'), 'utf8')).toBe('jq\n');
    expect(readFileSync(join(r.pinned, 'tool'), 'utf8')).toBe('v1\n');
    // the guard got exactly the scope the box binds
    expect(r.guardCfg?.toolchainWrite).toMatchObject({
      roots: [r.tc],
      dirs: [join(r.tc, 'devops')],
      pinned: [r.pinned],
    });
    expect(r.lockDuring).toContain('019e3f6a-7b1c-7a2d-8c3e-0123456789c3');
    expect(r.lockAfter).toBe(false);
  }, 60_000);

  it('R2-3: a Desk folder grant covering the whole tool folder never re-opens a pinned version read-write', async () => {
    const r = await outerRun({ grantShare: true, script: PROBES });
    expect(r.out).toContain('NEW-OK');
    expect(r.out).toContain('PINNED-KEPT');
    for (const bad of ['PINNED-WRITTEN', 'PINNED-ADDED', 'PINNED-RENAMED', 'TOOL-RENAMED'])
      expect(r.out).not.toContain(bad);
    expect(readFileSync(join(r.pinned, 'tool'), 'utf8')).toBe('v1\n');
  }, 60_000);

  it('Rework 1: the GitHub download hosts come only with the write grant really opened; a dropped grant gets neither', async () => {
    // a CONNECT through the box's egress bridge: 403 is the proxy's refusal (an allowed host gets a connect attempt instead)
    const probe = (_tc: string, out: string) =>
      `timeout 10 bash -c 'exec 3<>/dev/tcp/127.0.0.1/3128; printf "CONNECT release-assets.githubusercontent.com:443 HTTP/1.1\\r\\nHost: release-assets.githubusercontent.com:443\\r\\n\\r\\n" >&3; head -1 <&3' > ${out}.probe 2>&1; echo "PROBE:$(cat ${out}.probe)" >> ${out}`;
    const opened = await outerRun({ grantShare: false, script: probe });
    expect(opened.guardCfg?.toolchainWrite).toBeDefined();
    expect(opened.out).toMatch(/PROBE:HTTP\/1\.1/);
    expect(opened.out).not.toContain('403');
    const dropped = await outerRun({ grantShare: false, breakGrant: true, script: probe });
    expect(dropped.guardCfg?.toolchainWrite).toBeUndefined();
    expect(dropped.out).toContain('403');
  }, 90_000);

  it('REVIEW B-1: an approve racing the start either pins before the writer entry (then read-only in the box) or is refused', async () => {
    // approve after the writer entry is added: refused under the writer lock, nothing pinned
    let refused: unknown = 'not called';
    const late = await outerRun({
      grantShare: false,
      unpinned: true,
      script: PROBES,
      afterWriter: ({ policy, tc, pinned }) => {
        refused = withNoToolchainWriter(policy, () =>
          new TreePins(policy, () => {}, { toolchainsRoot: tc }).pin([pinned]),
        );
      },
    });
    expect(refused).toBeNull();
    expect(late.out).toContain('NEW-OK');
    // the pin made before the start (the snapshot is empty) is read fresh: the version is read-only and cannot be moved
    const early = await outerRun({ grantShare: false, script: PROBES });
    for (const bad of ['PINNED-WRITTEN', 'PINNED-ADDED', 'PINNED-RENAMED', 'TOOL-RENAMED'])
      expect(early.out).not.toContain(bad);
    expect(early.guardCfg?.toolchainWrite?.pinned).toEqual([early.pinned]);
  }, 90_000);
});

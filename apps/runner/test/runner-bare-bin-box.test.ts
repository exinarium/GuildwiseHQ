import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { probeHarnessSandbox } from '../src/adapters/harness-session.ts';
import { probeBwrap } from '../src/box/bwrap.ts';
import { boxConfigDir } from '../src/box/config-dir.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { binHome } from './bin-home.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * runner-bare-bin, with the real bubblewrap:
 * - criterion 1: a boxed claude-code start whose `bin` is the bare "claude", with an executable `claude` link in a PATH folder
 *   of a temporary home, starts the box; it runs the real target path and binds the real folder (the link folder is not there);
 * - criterion 2: a bare name missing from PATH, a relative path with a slash and a non-executable first hit are refused, with
 *   a clear error and no box (the config dir is never created);
 * - criterion 8: inside the runner-built box (`--disable-userns`) the command path starts no nested bwrap: a stand-in that does
 *   what Claude Code's env scrub does (wrap its command in `bwrap --unshare-pid`) when CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 now
 *   runs its command plainly, for the DevOps inner level and the CEO bypass turn. On development it failed with ENOSPC.
 */

const bwrapOk = process.platform === 'linux' && probeBwrap().ok && probeHarnessSandbox().ok;
const perms = BUILTIN_ROLES.find((r) => r.key === 'devops')?.permissions;

/** `<home>/.local/bin/claude` -> `<home>/.local/lib/claude/claude.exe`, the way npm installs Claude Code. */
function installFake(
  script: string,
  mode = 0o755,
): { home: string; link: string; real: string; pathVar: string } {
  const home = binHome();
  const lib = join(home, '.local', 'lib', 'claude');
  const bin = join(home, '.local', 'bin');
  for (const d of [join(home, '.local'), lib, bin]) mkdirSync(d, { recursive: true, mode: 0o755 });
  const real = join(lib, 'claude.exe');
  writeFileSync(real, script);
  chmodSync(real, mode);
  const link = join(bin, 'claude');
  symlinkSync(real, link);
  return { home, link, real, pathVar: `${bin}:/usr/bin:/bin` };
}

/** What the stand-in writes into its working folder (`$PWD/out.txt`). */
const PROBE = (linkDir: string) => `#!/bin/sh
out="$PWD/out.txt"
{ echo "ARGV0=$0"
  test -e ${linkDir} && echo LINK-DIR-VISIBLE || echo LINK-DIR-HIDDEN
  echo "SCRUB=$CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"
  if [ "$CLAUDE_CODE_SUBPROCESS_ENV_SCRUB" = "1" ]; then
    bwrap --unshare-pid --bind / / --proc /proc --dev /dev -- /bin/sh -c 'echo CMD-RAN' 2>&1
  else
    /bin/sh -c 'echo CMD-RAN' 2>&1
  fi
} > "$out" 2>&1
exit 0
`;

async function devopsSetup() {
  const home = realpathSync(tmp('aom-rbb-home-'));
  const policy = join(home, '.config', 'aom-runner');
  mkdirSync(policy, { recursive: true });
  const root = join(home, '.aom-runner');
  const paths = runnerPaths(root);
  const sb = await ensureSandbox(paths, '019e3f6a-7b1c-7a2d-8c3e-0123456789a1', 'Forge');
  const requestId = '019e3f6a-7b1c-7a2d-8c3e-0123456789b2';
  const cwd = join(sb.root, 'devops', requestId);
  mkdirSync(cwd, { recursive: true });
  return { home, policy, paths, sb, requestId, cwd };
}

async function startInner(bin: string, pathVar: string, s: Awaited<ReturnType<typeof devopsSetup>>) {
  const adapter = new ClaudeCodeAdapter(
    ClaudeRuntimeConfigSchema.parse({
      bin,
      sandbox: 'required',
      authMode: 'api_key',
      apiKey: 'sk-ant-test-key',
    }),
    s.paths,
    { home: s.home, pathVar } as never,
  );
  return adapter.start({
    shiftId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
    prompt: 'go',
    instructionsMarkdown: '',
    kind: 'devops',
    cwd: s.cwd,
    sandbox: s.sb,
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
    maxShiftMinutes: 5,
    devopsBox: true,
    boxRequestId: s.requestId,
  } as never);
}

async function withPolicy<T>(policy: string, f: () => Promise<T>): Promise<T> {
  const saved = process.env.AOM_RUNNER_POLICY_DIR;
  process.env.AOM_RUNNER_POLICY_DIR = policy;
  process.env.AOM_CLAUDE_SMOKE = '1';
  try {
    return await f();
  } finally {
    delete process.env.AOM_CLAUDE_SMOKE;
    if (saved === undefined) delete process.env.AOM_RUNNER_POLICY_DIR;
    else process.env.AOM_RUNNER_POLICY_DIR = saved;
  }
}

describe.skipIf(!bwrapOk)('runner-bare-bin: a bare runtime bin starts the box (real bubblewrap)', () => {
  it('criterion 1: bin "claude" on the PATH of a temporary home runs the real target; only the real folder is bound', async () => {
    const s = await devopsSetup();
    const f = installFake('');
    writeFileSync(f.real, PROBE(join(f.home, '.local', 'bin')));
    await withPolicy(s.policy, async () => {
      const session = await startInner('claude', f.pathVar, s);
      for await (const _e of session.events()) {
        // drain until the stand-in exits
      }
    });
    const out = readFileSync(join(s.cwd, 'out.txt'), 'utf8');
    expect(out).toContain(`ARGV0=${f.real}`);
    // the PATH folder of the link is not bound (no widening: the same mounts as an absolute bin)
    expect(out).toContain('LINK-DIR-HIDDEN');
  }, 60_000);

  it.each([
    [
      'a bare name missing from PATH',
      'claude',
      (h: string) => `${join(h, 'empty')}:/nowhere:/usr/bin:/bin`,
      /not found on the runner's PATH/,
    ],
    [
      'a relative path with a slash',
      './x/claude',
      () => '/usr/bin:/bin',
      /relative path: give an absolute path or a bare name/,
    ],
    ['a non-executable first hit', 'claude', 'non-exec', /is not executable/],
  ] as const)('criterion 2: %s is refused before any box or config dir', async (_why, bin, pv, msg) => {
    const s = await devopsSetup();
    const ne = installFake('#!/bin/sh\nexit 0\n', 0o644);
    const ok = installFake('#!/bin/sh\nexit 0\n');
    const pathVar =
      pv === 'non-exec'
        ? `${join(ne.home, '.local', 'bin')}:${join(ok.home, '.local', 'bin')}:/usr/bin:/bin`
        : pv(ne.home);
    await withPolicy(s.policy, async () => {
      await expect(startInner(bin, pathVar, s)).rejects.toThrow(msg);
    });
    expect(existsSync(boxConfigDir(dirname(s.sb.home), 'inner', s.requestId))).toBe(false);
    expect(existsSync(join(s.cwd, 'out.txt'))).toBe(false);
  });

  it('criterion 8: the inner level runs its command plainly (scrub off), no nested bwrap, no ENOSPC', async () => {
    const s = await devopsSetup();
    const f = installFake('');
    writeFileSync(f.real, PROBE(join(f.home, '.local', 'bin')));
    await withPolicy(s.policy, async () => {
      const session = await startInner(f.link, f.pathVar, s);
      for await (const _e of session.events()) {
        // drain
      }
    });
    const out = readFileSync(join(s.cwd, 'out.txt'), 'utf8');
    expect(out).toContain('SCRUB=0');
    expect(out).toContain('CMD-RAN');
    expect(out).not.toMatch(/ENOSPC|Creating new namespace failed|No space left/);
  }, 60_000);

  it('criterion 8: the CEO bypass turn (scrub forced on before) runs its command plainly in its box', async () => {
    const home = realpathSync(tmp('aom-rbb-ceo-'));
    const policy = join(home, '.config', 'aom-runner');
    mkdirSync(policy, { recursive: true });
    const root = join(home, '.aom-runner');
    mkdirSync(join(root, 'bin'), { recursive: true });
    const turnDir = join(root, 'ceo-turns', 'c1');
    mkdirSync(turnDir, { recursive: true });
    const f = installFake('');
    writeFileSync(f.real, PROBE(join(f.home, '.local', 'bin')));
    await withPolicy(policy, async () => {
      const adapter = new ClaudeCodeAdapter(
        ClaudeRuntimeConfigSchema.parse({
          bin: 'claude',
          sandbox: 'required',
          authMode: 'api_key',
          apiKey: 'sk-ant-test-key',
        }),
        runnerPaths(root),
        { home, pathVar: f.pathVar } as never,
      );
      const session = await adapter.startOwnerTurn({
        chatId: 'c1',
        mode: 'owner',
        permissionMode: 'bypass',
        message: 'hi',
        cwd: home,
        agent: { model: 'claude-opus-5-5', agentId: 'a' } as never,
        env: { PATH: '/usr/bin:/bin' },
        turnDir,
      });
      for await (const _e of session.events()) {
        // drain
      }
    });
    const out = readFileSync(join(turnDir, 'work', 'out.txt'), 'utf8');
    expect(out).toContain(`ARGV0=${f.real}`);
    expect(out).toContain('SCRUB=0');
    expect(out).toContain('CMD-RAN');
    expect(out).not.toMatch(/ENOSPC|Creating new namespace failed/);
  }, 60_000);
});

describe.skipIf(!bwrapOk)(
  'review S1: an upstream 401 marks the main login expired only when the turn failed',
  () => {
    it.each([
      [0, false],
      [3, true],
    ])(
      'CEO turn exiting %i after an upstream 401: expired=%s',
      async (code, expired) => {
        const up = createServer((req, res) => {
          req.resume();
          req.on('end', () => {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end('{"type":"error","error":{"type":"authentication_error","message":"no"}}');
          });
        });
        await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
        const home = realpathSync(tmp('aom-rbb-s1-'));
        const policy = join(home, '.config', 'aom-runner');
        mkdirSync(policy, { recursive: true });
        const root = join(home, '.aom-runner');
        mkdirSync(join(root, 'bin'), { recursive: true });
        const turnDir = join(root, 'ceo-turns', 'c1');
        mkdirSync(turnDir, { recursive: true });
        const f = installFake('');
        writeFileSync(
          f.real,
          `#!/bin/sh\ncurl -s -o /dev/null -H "x-api-key: $ANTHROPIC_API_KEY" -H 'content-type: application/json' "$ANTHROPIC_BASE_URL/v1/messages" -d '{"model":"m"}'\nexit ${code}\n`,
        );
        let adapter: ClaudeCodeAdapter | undefined;
        try {
          await withPolicy(policy, async () => {
            adapter = new ClaudeCodeAdapter(
              ClaudeRuntimeConfigSchema.parse({
                bin: 'claude',
                sandbox: 'required',
                authMode: 'api_key',
                apiKey: 'sk-ant-test-key',
              }),
              runnerPaths(root),
              {
                home,
                pathVar: f.pathVar,
                modelUpstream: `http://127.0.0.1:${(up.address() as { port: number }).port}`,
                proxyTest: { allowPrivate: true },
              } as never,
            );
            const session = await adapter.startOwnerTurn({
              chatId: 'c1',
              mode: 'owner',
              permissionMode: 'bypass',
              message: 'hi',
              cwd: home,
              agent: { model: 'claude-opus-5-5', agentId: 'a' } as never,
              env: { PATH: '/usr/bin:/bin' },
              turnDir,
            });
            for await (const _e of session.events()) {
              // drain
            }
          });
        } finally {
          up.close();
        }
        expect(adapter?.registry.main.auth.state === 'expired').toBe(expired);
      },
      60_000,
    );
  },
);

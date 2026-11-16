import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, delimiter, dirname, join, relative, sep } from 'node:path';
import { execa } from 'execa';
import type { Logger } from '../log.ts';
import {
  gitDirOf,
  type SandboxSpec,
  SERVICE_HOME,
  type ServiceLauncher,
  sandboxCommand,
  scrubEnv,
} from '../runs/sandbox.ts';
import { agentTmpRoot, cacheEnv, ensureSharedCaches } from '../sandbox/sandbox.ts';
import { redact } from '../secrets/redact.ts';
import { BREW_BIN_DIRS, userBinDirs } from '../toolchain/exec.ts';
import type { ResolvedToolchains } from '../toolchain/registry.ts';
import {
  type DocsPrepExec,
  type DocsPrepExecFactory,
  type DocsPrepExecScope,
  DocsPrepSandboxError,
} from './release-docs-prep-steps.ts';

/**
 * The exec of Release prep's content steps: every project command a step runs (the PDF guide build, the assistant pack,
 * the videos recorder) runs inside the runner's bubblewrap sandbox (runs/sandbox.ts), never as a plain child of the
 * runner. The profile:
 * - read-write: the step's worktree and scratch folder, the shared package caches (`<data dir>/cache`, where the
 *   Playwright browsers and corepack live too) and a private `/tmp`; for the videos step also its voice folder;
 * - unreadable: the runner's data dir, the machine data dir (sibling pairings, `pairings.json`), the credential folders
 *   of the real home and the session sockets; the environment is scrubbed of the runner's own and secret variables;
 * - the host network, like run steps (a cold cache fetches pnpm, packages and Chromium; the recorder needs loopback);
 * - `--die-with-parent`: a timeout or the runner's exit ends the whole tree.
 *
 * It fails closed: no Linux, no working bubblewrap, or a bubblewrap setup error is a DocsPrepSandboxError naming the
 * step, and the command is never run without the sandbox. The runner's sandbox mode setting does not apply here.
 */

export type DocsPrepSpawner = (
  cmd: string,
  args: string[],
  o: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; spawnError?: string }>;

export interface DocsPrepSandboxDeps {
  /** The runner's data dir (masked). */
  runnerRoot: string;
  /** The real home of the OS user (its credential folders are masked). */
  realHome: string;
  /** The shared package caches (`<runner root>/cache`, read-write). */
  cacheRoot: string;
  launcher: Pick<ServiceLauncher, 'sandboxAvailable'>;
  toolchains: () => Pick<ResolvedToolchains, 'pathDirs' | 'env'>;
  /** Default: execa with only the given env, no stdin, output redacted. */
  spawn?: DocsPrepSpawner;
  log?: Pick<Logger, 'info'>;
  platform?: NodeJS.Platform;
  /** The runner's environment (default process.env); only its scrubbed form reaches a command. */
  parentEnv?: NodeJS.ProcessEnv;
  /** Root of the private tmp dirs (default agentTmpRoot()). */
  tmpRoot?: string;
}

/** The variables the videos step's tools are found by (packages/video, the recorder): passed through, videos only. */
const VIDEO_PASS_THROUGH = ['AOM_FFMPEG', 'AOM_KOKORO_PYTHON', 'AOM_PIPER', 'AOM_E2E_PG_HOSTPORT'] as const;

/** `<x>/pairings/<id>` → `<x>` (the machine data dir); any other layout: the runner root itself. */
export function machineDataDir(runnerRoot: string): string {
  const parent = dirname(runnerRoot);
  return basename(parent) === 'pairings' ? dirname(parent) : runnerRoot;
}

/** The voice folder of the videos step: the inherited AOM_VIDEO_HOME, else `~/.cache/aom-video`. */
export const videoHomeOf = (deps: Pick<DocsPrepSandboxDeps, 'realHome' | 'parentEnv'>): string =>
  (deps.parentEnv ?? process.env).AOM_VIDEO_HOME || join(deps.realHome, '.cache', 'aom-video');

const labelOf = (scope: Pick<DocsPrepExecScope, 'step' | 'phase'>): string =>
  scope.phase ? `${scope.step}/${scope.phase}` : scope.step;

/** The bubblewrap profile of one docs-prep command (pure). */
export function docsPrepSandboxSpec(
  deps: Pick<DocsPrepSandboxDeps, 'runnerRoot' | 'realHome' | 'cacheRoot' | 'parentEnv'>,
  scope: DocsPrepExecScope,
  runTmp: string,
): SandboxSpec {
  const videoHome = scope.step === 'videos' ? videoHomeOf(deps) : null;
  return {
    runnerRoot: deps.runnerRoot,
    realHome: deps.realHome,
    cacheRoot: deps.cacheRoot,
    runTmp,
    worktrees: [scope.worktree, scope.outDir, ...(videoHome && existsSync(videoHome) ? [videoHome] : [])],
    gitDirs: gitDirOf(scope.worktree),
    userSecrets: false,
    network: 'host',
    extraMasked: [machineDataDir(deps.runnerRoot)],
    dieWithParent: true,
  };
}

/** The environment of one docs-prep command (pure): scrubbed, toolchain PATH, private HOME, shared caches. */
export function docsPrepEnv(
  deps: Pick<DocsPrepSandboxDeps, 'realHome' | 'cacheRoot' | 'toolchains' | 'parentEnv'>,
  scope: Pick<DocsPrepExecScope, 'step'>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const parent = deps.parentEnv ?? process.env;
  const tc = deps.toolchains();
  const out: Record<string, string> = { ...scrubEnv(parent), ...scrubEnv(tc.env) };
  // The PATH the runner's executor builds, so corepack/node/pnpm resolve as before.
  out.PATH = [
    ...tc.pathDirs,
    ...(out.PATH ?? '').split(delimiter),
    ...userBinDirs(deps.realHome),
    ...BREW_BIN_DIRS,
  ]
    .filter((x, i, a) => x && a.indexOf(x) === i)
    .join(delimiter);
  Object.assign(
    out,
    // As RunManager.baseEnv(true): a private HOME in the private /tmp, and no .NET build servers.
    {
      HOME: SERVICE_HOME,
      TMPDIR: '/tmp',
      TMP: '/tmp',
      TEMP: '/tmp',
      XDG_CACHE_HOME: `${SERVICE_HOME}/.cache`,
      XDG_CONFIG_HOME: `${SERVICE_HOME}/.config`,
      XDG_DATA_HOME: `${SERVICE_HOME}/.local/share`,
      DOTNET_CLI_HOME: `${SERVICE_HOME}/.dotnet`,
      DOTNET_NOLOGO: '1',
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      MSBUILDDISABLENODEREUSE: '1',
      DOTNET_CLI_USE_MSBUILD_SERVER: '0',
    },
    cacheEnv(deps.cacheRoot),
    {
      // The real home is read-only here, and `playwright install` writes a lock even when the browser is there.
      PLAYWRIGHT_BROWSERS_PATH: join(deps.cacheRoot, 'ms-playwright'),
      COREPACK_HOME: join(deps.cacheRoot, 'corepack'),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      DEBIAN_FRONTEND: 'noninteractive',
      GIT_TERMINAL_PROMPT: '0',
    },
  );
  if (scope.step === 'videos') {
    out.AOM_VIDEO_HOME = videoHomeOf(deps);
    for (const k of VIDEO_PASS_THROUGH) {
      const v = parent[k];
      if (v) out[k] = v;
    }
  }
  return { ...out, ...extra };
}

/** execa with exactly the given env (never the runner's), no stdin; output redacted. */
export const execaSpawner: DocsPrepSpawner = async (cmd, args, o) => {
  try {
    const r = await execa(cmd, args, {
      cwd: o.cwd,
      env: o.env,
      extendEnv: false,
      reject: false,
      stdin: 'ignore',
      timeout: o.timeoutMs,
    });
    const spawnError = r.exitCode === undefined && !r.timedOut ? r.shortMessage : undefined;
    return {
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : r.failed ? 1 : 0,
      stdout: redact(String(r.stdout ?? '')),
      stderr: redact(String(r.stderr ?? '')),
      timedOut: r.timedOut === true,
      ...(spawnError ? { spawnError: redact(spawnError) } : {}),
    };
  } catch (err) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: redact(err instanceof Error ? err.message : String(err)),
    };
  }
};

const inside = (root: string, p: string): boolean => {
  const r = relative(root, p);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !r.startsWith(sep));
};

const realOr = async (p: string): Promise<string> => realpath(p).catch(() => p);

/** The production exec factory: every command runs in the sandbox, or not at all. */
export function sandboxedDocsPrepExec(deps: DocsPrepSandboxDeps): DocsPrepExecFactory {
  const spawn = deps.spawn ?? execaSpawner;
  return (scope): DocsPrepExec =>
    async (cmd, args, opts) => {
      const label = labelOf(scope);
      const refused = (why: string): DocsPrepSandboxError =>
        new DocsPrepSandboxError(`release prep step '${label}' ${why}. The command was not run.`);
      const cwd = await realpath(opts.cwd).catch(() => null);
      if (!cwd || !(inside(await realOr(scope.worktree), cwd) || inside(await realOr(scope.outDir), cwd)))
        throw refused(`may run ${cmd} only inside its worktree or scratch folder, not in ${opts.cwd}`);
      const platform = deps.platform ?? process.platform;
      if (platform !== 'linux')
        throw refused(`needs the Linux bubblewrap sandbox to run ${cmd}; this workstation runs ${platform}`);
      if (!(await deps.launcher.sandboxAvailable()))
        throw refused(
          `cannot run ${cmd}: the bubblewrap sandbox is not available or cannot start here (install bubblewrap: apt install bubblewrap)`,
        );

      const tag = createHash('sha256')
        .update(`${scope.runId}\0${scope.repoId}\0${scope.step}\0${scope.phase}`)
        .digest('hex')
        .slice(0, 10);
      const root = deps.tmpRoot ?? agentTmpRoot();
      await mkdir(root, { recursive: true });
      const runTmp = await mkdtemp(join(root, `aom-docsprep-${tag}-`));
      try {
        await mkdir(join(runTmp, 'home'), { recursive: true, mode: 0o700 });
        await ensureSharedCaches(deps.cacheRoot);
        await mkdir(join(deps.cacheRoot, 'ms-playwright'), { recursive: true });
        await mkdir(join(deps.cacheRoot, 'corepack'), { recursive: true });
        const spec = docsPrepSandboxSpec(deps, scope, runTmp);
        const env = docsPrepEnv(deps, scope, opts.env);
        const c = sandboxCommand(spec, [cmd, ...args]);
        deps.log?.info(
          `release prep ${label}: ${[cmd, ...args.slice(0, 4)].join(' ')}${args.length > 4 ? ' …' : ''} (sandboxed: bwrap)`,
        );
        const r = await spawn(c.cmd, c.args, { cwd, env, timeoutMs: opts.timeoutMs });
        if (r.spawnError) throw refused(`could not start the bubblewrap sandbox for ${cmd}: ${r.spawnError}`);
        const first = r.stderr.split('\n').find((l) => l.trim() !== '') ?? '';
        if (r.exitCode !== 0 && !r.timedOut && first.startsWith('bwrap: '))
          throw refused(`could not start ${cmd} in the sandbox: ${first.trim()}`);
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
      } finally {
        await rm(runTmp, { recursive: true, force: true }).catch(() => undefined);
      }
    };
}

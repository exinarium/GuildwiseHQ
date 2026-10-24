import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { type EgressProxy, type EgressRoute, startEgressProxy } from '../sandbox/egress-proxy.ts';
import {
  type HarnessSandboxInput,
  harnessBwrapArgs,
  proxyEnv,
  REAL_SHELL_IN_BOX,
  realShellPath,
  shellShimScript,
  type WrappedCommand,
  wrapInHarnessSandbox,
} from '../sandbox/harness-sandbox.ts';
import { REGISTRY_DOMAINS } from './claude-policy.ts';

/**
 * What the CLI harness adapters (Gemini CLI, opencode) share: running the CLI inside the harness sandbox with its egress proxy,
 * the check that the sandbox works on this machine, and the plumbing around the CLI's own state folder. The adapters add what is
 * theirs: flags, settings files, the stream parser, the login.
 */

export const BRIDGE_PORT = 3128;

/** Hosts the agent's shell may reach besides the model's: the package registries and source hosts (as for Claude Code). */
export const SHELL_DOMAINS: readonly string[] = REGISTRY_DOMAINS;

export interface HarnessLaunch {
  /** Where the CLI's model API key is injected: route prefix, upstream and headers. The key itself stays in the runner. */
  routes?: EgressRoute[];
  /** Hosts the CLI (not only the shell) needs: its model API, its login endpoints. */
  cliHosts: string[];
  extraHosts?: string[];
  sandbox: Omit<HarnessSandboxInput, 'proxySocket' | 'bridgePort' | 'shimDir' | 'hiddenFromShell'>;
  /** Files or folders only the CLI may read (its login). */
  hiddenFromShell?: string[];
  /** Variables only the CLI may have (removed for the commands it starts). */
  unsetForShell?: string[];
  /**
   * Owner decision Q68: the shell of this session runs only `aom ...`, enforced by the shim in the box (not by the CLI's own
   * rules). `trustedScripts` are the runner's own script folders (read-only in the box) a helper may be started from; default: the
   * read-only folders named `bin`. Set for a role without the `shell` tool and for every chat.
   */
  aomOnlyShell?: boolean | { trustedScripts?: string[] };
  /** The CLI starts its shell by absolute path: replace the box's own `bash` with the masking shim (instead of using PATH). */
  replaceShell?: boolean;
  cmd: { bin: string; args: string[]; env: Record<string, string> };
  /** The workstation owner's private-endpoint allow-list (exact host:port entries); empty by default. */
  privateEndpoints?: string[];
  /** Log a refused host (no path, no credential). */
  onDeny?: (host: string) => void;
  /** Test hook: reach loopback and private addresses, and resolve names as given (a fake API on localhost). */
  proxyTest?: { allowPrivate: true; resolve?: (host: string) => Promise<string> };
}

export interface LaunchedHarness {
  command: WrappedCommand;
  proxy: EgressProxy;
  /** Stops the proxy and removes the session's temp folder. Safe to call twice. */
  cleanup: () => Promise<void>;
}

/** Starts the egress proxy for one session and wraps the CLI's command in the sandbox. */
export async function launchInHarnessSandbox(l: HarnessLaunch): Promise<LaunchedHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'aom-eg-'));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, 'p.sock');
  const proxy = await startEgressProxy({
    socketPath,
    allowedHosts: [...l.cliHosts, ...SHELL_DOMAINS, ...(l.extraHosts ?? [])],
    ...(l.routes ? { routes: l.routes } : {}),
    ...(l.onDeny ? { onDeny: l.onDeny } : {}),
    ...(l.privateEndpoints?.length ? { privateEndpoints: l.privateEndpoints } : {}),
    ...(l.proxyTest ?? {}),
  });
  let shimDir: string | undefined;
  const hidden = l.hiddenFromShell ?? [];
  const unset = l.unsetForShell ?? [];
  const aomOnly = l.aomOnlyShell
    ? {
        trustedScripts:
          typeof l.aomOnlyShell === 'object' && l.aomOnlyShell.trustedScripts
            ? l.aomOnlyShell.trustedScripts
            : l.sandbox.readonly.filter((p) => /[\\/]bin$/.test(p)),
      }
    : undefined;
  if (hidden.length || unset.length || aomOnly) {
    shimDir = join(dir, 'shim');
    mkdirSync(shimDir, { recursive: true });
    for (const name of ['bash', 'sh']) {
      const file = join(shimDir, name);
      writeFileSync(
        file,
        l.replaceShell
          ? shellShimScript(REAL_SHELL_IN_BOX, hidden, unset, 'bwrap', REAL_SHELL_IN_BOX, aomOnly)
          : shellShimScript(
              realShellPath(),
              hidden,
              unset,
              'bwrap',
              aomOnly ? realShellPath() : '/bin/sh',
              aomOnly,
            ),
      );
      chmodSync(file, 0o755);
    }
  }
  const input: HarnessSandboxInput = {
    ...l.sandbox,
    proxySocket: socketPath,
    bridgePort: BRIDGE_PORT,
    hiddenFromShell: hidden,
    ...(shimDir ? { shimDir } : {}),
    ...(shimDir && l.replaceShell
      ? { shellOverride: { shim: join(shimDir, 'bash'), real: realShellPath() } }
      : {}),
  };
  const env = { ...l.cmd.env, ...proxyEnv(BRIDGE_PORT) };
  if (shimDir) env.SHELL = join(shimDir, 'bash');
  const command = wrapInHarnessSandbox(input, { ...l.cmd, env });
  let done = false;
  return {
    command,
    proxy,
    cleanup: async () => {
      if (done) return;
      done = true;
      await proxy.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------------------------------------ the self-test

const PROBE_TTL_MS = 10 * 60_000;
let cached: { at: number; result: { ok: boolean; reason: string } } | undefined;

const onPath = (name: string, pathVar = process.env.PATH ?? ''): boolean =>
  pathVar.split(delimiter).some((d) => d && existsSync(join(d, name)));

/**
 * Does the harness sandbox work on this machine? Linux with bubblewrap and socat; a user namespace must be allowed (also nested:
 * the shell shim starts a second sandbox). Checked by running a command in it, cached for ten minutes. The reason is shown to the
 * owner.
 */
export function probeHarnessSandbox(
  platform: NodeJS.Platform = process.platform,
  now: () => number = Date.now,
): { ok: boolean; reason: string } {
  if (platform !== 'linux')
    return {
      ok: false,
      reason:
        'the sandbox of the Gemini CLI and opencode runtimes uses bubblewrap and runs on Linux (and WSL2) only; there is no macOS or Windows sandbox for them yet',
    };
  const t = now();
  if (cached && t - cached.at < PROBE_TTL_MS) return cached.result;
  let result: { ok: boolean; reason: string };
  const missing = ['bwrap', 'socat'].filter((b) => !onPath(b));
  if (missing.length)
    result = { ok: false, reason: `${missing.join(' and ')} not installed: apt install bubblewrap socat` };
  else {
    const dir = mkdtempSync(join(tmpdir(), 'aom-probe-'));
    try {
      for (const d of ['home', 'scratch', 'tmp', 'run']) mkdirSync(join(dir, d), { recursive: true });
      // the same arguments a session uses, so what works here works there
      const args = harnessBwrapArgs({
        cwd: dir,
        readOnlyCwd: true,
        home: join(dir, 'home'),
        scratch: join(dir, 'scratch'),
        tmp: join(dir, 'tmp'),
        writable: [],
        readonly: [],
        readDirs: [],
        gitDirs: [],
        mayCommit: false,
        proxySocket: join(dir, 'run', 'p.sock'),
        bridgePort: BRIDGE_PORT,
        hiddenFromShell: [],
      });
      const r = spawnSync(
        'bwrap',
        [
          ...args,
          '--',
          '/bin/sh',
          '-c',
          // the nested sandbox the shell shim starts, and the bridge's tool
          'bwrap --unshare-pid --bind / / --proc /proc --dev /dev -- /bin/true && socat -V >/dev/null',
        ],
        { encoding: 'utf8', timeout: 20_000, cwd: dir },
      );
      const text = `${r.stderr ?? ''}`.trim().split('\n').slice(0, 2).join(' | ').slice(0, 200);
      result =
        r.status === 0
          ? {
              ok: true,
              reason:
                'runner-managed bubblewrap (user, PID, IPC and network namespaces) with an egress proxy',
            }
          : { ok: false, reason: `the sandbox does not start here: ${text || `exit ${r.status}`}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  cached = { at: t, result };
  return result;
}

/** Test hook: forget the cached self-test. */
export function resetHarnessProbe(): void {
  cached = undefined;
}

// ------------------------------------------------------------------------------------------------ small helpers

/** The folder of an installed CLI and its package root, read-only inside the sandbox (an npm install keeps its files next to the bin). */
export function installDirsOf(
  bin: string,
  packageNames: readonly string[],
  realpath: (p: string) => string,
): string[] {
  let real = bin;
  try {
    real = realpath(bin);
  } catch {
    // keep the path as given
  }
  // the folder the binary is started from (a symlink in `.bin`) and the folder it really lives in
  const out = new Set<string>([dirname(resolve(bin)), dirname(real)]);
  let d = dirname(real);
  for (let i = 0; i < 5; i++) {
    const pj = join(d, 'package.json');
    if (existsSync(pj)) {
      out.add(d);
      // an npm layout keeps the package's own dependencies in the folder that holds the package (pnpm: the `.pnpm` store)
      const k = real.indexOf(`${sep}.pnpm${sep}`);
      if (k > 0) out.add(real.slice(0, k + `${sep}.pnpm`.length));
      break;
    }
    d = dirname(d);
  }
  void packageNames;
  return [...out].map((p) => resolve(p));
}

import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  type DevOpsAccess,
  type EnvEnsurePayload,
  type EnvironmentReport,
  normalizeProjectPath,
  type ToolReport,
} from '@aom/shared';
import { redact } from '../secrets/redact.ts';
import { detectStacks, viewOf } from './detect.ts';
import {
  type DotnetSelection,
  dotnetGaps,
  dotnetProcessEnv,
  dotnetRootWritable,
  shortPath,
} from './dotnet.ts';
import type { ExecResult, Executor } from './exec.ts';
import { type DetectedManager, detectManagers, managerCommands, noManagerAdvice } from './managers.ts';
import { dotnetInstallInto, STACKS, TOOLS } from './stacks.ts';
import type { Check, Detection, Manager, Params, Platform, Step, ToolSpec } from './types.ts';

/** `have >= want`, comparing dotted numbers segment by segment (`8` is satisfied by `8.0.100` and `9.0`). */
export function versionAtLeast(have: string, want: string): boolean {
  const h = have.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const w = want.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < w.length; i++) {
    const a = h[i] ?? 0;
    const b = w[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** How a command that needs administrator rights runs here (the sudo vault, or the process itself when root). */
export interface RootRunner {
  mode(): Promise<{ mode: 'root' | 'passwordless' | 'password' | 'none' | 'unsupported'; detail: string }>;
  run(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
}

export interface EnsureDeps {
  exec: Executor;
  platform: Platform;
  root: RootRunner;
  /** Local clone of a repository by normalized remote URL. */
  findRepo(normalized: string): Promise<{ localPath: string } | undefined>;
  /** Full install log (appended, redacted). */
  logFile?: string;
  /** Test hook: stack/tool tables (default: the real ones). */
  tables?: { stacks: typeof STACKS; tools: Record<string, ToolSpec> };
  /** D6: run the project's dependency installs once the tools are ready (default true). */
  installDependencies?: boolean;
  /**
   * The .NET installs of this workstation (`selectDotnet`). When present the SDK check reads the chosen root's directories
   * (global.json, target frameworks) instead of asking `dotnet --version`, `dotnet` runs with that root, and a missing SDK
   * is installed into it.
   */
  dotnet?: () => DotnetSelection;
}

/** Env for a command: `dotnet` and its installers run with the chosen root first on PATH and as DOTNET_ROOT. */
function dotnetRunEnv(
  cmd: string,
  deps: EnsureDeps,
): { env: Record<string, string> } | Record<string, never> {
  const chosen = cmd === 'dotnet' ? deps.dotnet?.().chosen : undefined;
  return chosen ? { env: dotnetProcessEnv(chosen, process.env.PATH) } : {};
}

/** What the project asks of the SDK and what the chosen root lacks; used by the check and the installer. */
function dotnetPlan(params: Params, deps: EnsureDeps) {
  const sel = (deps.dotnet as () => DotnetSelection)();
  const needs = {
    ...(params.globalVersion ? { globalVersion: params.globalVersion } : {}),
    ...(params.rollForward ? { rollForward: params.rollForward } : {}),
    tfmMajors: (params.tfmMajors ?? '').split(',').filter(Boolean).map(Number),
  };
  const gap = dotnetGaps(sel.chosen, needs);
  if (!sel.chosen) gap.problems.unshift('no .NET SDK found');
  return { sel, gap };
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const tail = (s: string, n = 3): string =>
  s.trim().split('\n').filter(Boolean).slice(-n).join(' | ').slice(0, 400);

/**
 * `env.ensure`: for each repository of the project find the stacks, verify each tool, install what is missing (only
 * what the manager allowed) and say whether the workstation is ready to build. Plain code driven by the tables in
 * `stacks.ts`; every command goes through `deps.exec` (or `deps.root` for administrator rights) and is logged.
 */
export async function ensureEnvironment(p: EnvEnsurePayload, deps: EnsureDeps): Promise<EnvironmentReport> {
  const tables = deps.tables ?? { stacks: STACKS, tools: TOOLS };
  const logTail: string[] = [];
  const log = (line: string) => {
    const clean = redact(line);
    logTail.push(clean.slice(0, 500));
    if (logTail.length > 80) logTail.shift();
    if (deps.logFile) {
      try {
        mkdirSync(dirname(deps.logFile), { recursive: true });
        appendFileSync(deps.logFile, `${new Date().toISOString()} ${clean}\n`);
      } catch {
        // the log is advisory
      }
    }
  };
  const reports: ToolReport[] = [];
  const stackList: EnvironmentReport['stacks'] = [];
  const need = new Map<string, { spec: ToolSpec; params: Params; stack: string }>();
  const runs: Array<{ name: string; localPath: string; detections: Detection[] }> = [];

  // 1. What the repositories use.
  for (const r of p.repos) {
    const repo = await deps.findRepo(r.remoteUrlNormalized);
    if (!repo) {
      reports.push({
        stack: 'repository',
        tool: r.name,
        status: 'failed',
        detail: `no local clone of ${r.name} on this workstation`,
        fix: 'Clone the repository (Project settings, Repositories) and check again.',
      });
      continue;
    }
    // The project may live in a sub directory of the repository: detect and install from there.
    let projectDir = repo.localPath;
    try {
      const sub = normalizeProjectPath(r.projectPath);
      if (sub) projectDir = join(repo.localPath, sub);
    } catch {
      reports.push({
        stack: 'repository',
        tool: r.name,
        status: 'failed',
        detail: `the project path "${r.projectPath}" is not a relative sub directory`,
        fix: 'Change the project path in Project settings, Repositories (a folder inside the repository, no "..").',
      });
      continue;
    }
    if (projectDir !== repo.localPath && !isDirectory(projectDir)) {
      reports.push({
        stack: 'repository',
        tool: r.name,
        status: 'failed',
        detail: `the project path "${r.projectPath}" does not exist in the clone of ${r.name}`,
        fix: 'Correct the project path in Project settings, Repositories (or pull the branch that has it) and check again.',
      });
      continue;
    }
    const view = viewOf(projectDir, deps.platform);
    const detections: Detection[] = detectStacks(view).filter((d) =>
      tables.stacks.some((s) => s.id === d.id),
    );
    log(
      `${r.name}${projectDir !== repo.localPath ? ` (${r.projectPath})` : ''}: ${detections.map((d) => d.name).join(', ') || 'no known stack'}`,
    );
    runs.push({ name: r.name, localPath: projectDir, detections });
    for (const d of detections) {
      stackList.push({ id: d.id, name: d.name, repo: r.name });
      const stack = tables.stacks.find((s) => s.id === d.id);
      for (const toolId of stack?.tools(d, deps.platform) ?? []) {
        const spec = tables.tools[toolId];
        if (!spec) continue;
        const seen = need.get(toolId);
        // Two repositories asking for different versions: the higher one wins.
        if (!seen) need.set(toolId, { spec, params: { ...d.params }, stack: d.id });
        else seen.params = mergeParams(seen.params, d.params);
      }
    }
  }

  // 2. Verify, then install what is missing.
  const manager = await detectManagers(deps.exec, deps.platform);
  const rootInfo = await deps.root.mode();
  const done = new Map<string, ToolReport>();
  for (const [toolId, t] of need) {
    const report = await ensureTool(toolId, t, p.access, manager, rootInfo.mode, deps, log, done);
    done.set(toolId, report);
    reports.push(report);
  }

  // 3. D6: the project's own dependencies (pnpm/pip/dotnet restore ...), once its tools are in place.
  if (deps.installDependencies !== false)
    reports.push(...(await installDependencies(runs, tables, p.access, done, deps, log)));

  // The .NET SDKs agents will see: one line in the report (Workstations / Development environment).
  const dn = deps.dotnet?.();
  if (dn?.chosen && stackList.some((s) => s.id.startsWith('dotnet')))
    reports.unshift({
      stack: 'dotnet',
      tool: '.NET SDKs',
      status: 'ok',
      version: dn.chosen.sdks.join(', '),
      detail: `(${shortPath(dn.chosen.root)})`,
    });

  // 4. The verdict.
  const state: EnvironmentReport['state'] = reports.some((r) => r.status === 'needs_access')
    ? 'needs_access'
    : reports.some((r) => r.status === 'failed' || r.status === 'missing')
      ? 'failed'
      : 'ready';
  const problems = reports.filter(
    (r) => r.status === 'needs_access' || r.status === 'failed' || r.status === 'missing',
  );
  const summary =
    state === 'ready'
      ? stackList.length
        ? `Ready: ${[...new Set(stackList.map((s) => s.name))].join(', ')} (${reports.map((r) => `${r.tool}${r.version ? ` ${r.version}` : ''}`).join(', ')})`
        : 'Ready: no toolchain to prepare (no known stack found in the repositories)'
      : `${state === 'needs_access' ? 'Needs access' : 'Not ready'}: ${problems
          .map((r) => `${r.tool}${r.detail ? ` (${r.detail})` : ''}`)
          .join('; ')}`.slice(0, 1900);
  return { state, stacks: stackList, tools: reports, summary, logTail };
}

/**
 * D6: runs each detected stack's dependency steps in the repository folder (`pnpm install`, `dotnet restore`, pip into
 * `.venv`, `go mod download`, `cargo fetch`, ...). A step waits for its tools; nothing runs unless the manager allowed
 * installing. A failing install makes the environment "failed" with the log tail, like a failing tool install.
 */
async function installDependencies(
  runs: Array<{ name: string; localPath: string; detections: Detection[] }>,
  tables: { stacks: typeof STACKS; tools: Record<string, ToolSpec> },
  access: DevOpsAccess,
  done: Map<string, ToolReport>,
  deps: EnsureDeps,
  log: (l: string) => void,
): Promise<ToolReport[]> {
  const out: ToolReport[] = [];
  for (const run of runs) {
    for (const d of run.detections) {
      const stack = tables.stacks.find((s) => s.id === d.id);
      for (const step of stack?.deps?.(d, deps.platform) ?? []) {
        const tool = runs.length > 1 ? `${step.name} (${run.name})` : step.name;
        const base = { stack: d.id, tool };
        const blocker = (step.after ?? [])
          .map((a) => done.get(a))
          .find((r) => r && r.status !== 'ok' && r.status !== 'installed');
        // A tool that is not fine already says so in the report; its dependency steps just do not run.
        if (blocker) break;
        if (!access.allowInstall) {
          out.push({
            ...base,
            status: 'skipped',
            detail: 'dependencies are installed only when "Install packages and tools" is allowed',
          });
          break;
        }
        const cmd =
          step.cmd.startsWith('./') || step.cmd.includes('\\') ? join(run.localPath, step.cmd) : step.cmd;
        log(`$ (${run.name}) ${step.cmd} ${step.args.join(' ')}`);
        const r = await deps.exec.run(isAbsolute(cmd) ? cmd : step.cmd, step.args, {
          cwd: run.localPath,
          timeoutMs: 30 * 60_000,
          ...dotnetRunEnv(step.cmd, deps),
        });
        for (const line of `${r.stdout}\n${r.stderr}`.split('\n').slice(-8))
          if (line.trim()) log(`  ${line.trim()}`);
        if (r.exitCode === 0) {
          out.push({ ...base, status: 'installed', detail: `ran in ${run.name}` });
          continue;
        }
        log(`  exit ${r.exitCode}`);
        out.push({
          ...base,
          status: 'failed',
          detail: tail(r.stderr || r.stdout) || `exit code ${r.exitCode}`,
          fix: `Run "${step.cmd} ${step.args.join(' ')}" in ${run.localPath}, then check again.`,
        });
        break; // later steps of this stack depend on this one
      }
    }
  }
  return out;
}

function mergeParams(a: Params, b: Params): Params {
  const out: Params = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    const cur = out[k];
    if (k === 'tfmMajors' && cur !== undefined)
      out[k] = [...new Set(`${cur},${v}`.split(','))].sort((a, b) => Number(a) - Number(b)).join(',');
    else if (cur === undefined) out[k] = v;
    else if (/^\d+(\.\d+)*$/.test(cur) && /^\d+(\.\d+)*$/.test(v) && !versionAtLeast(cur, v)) out[k] = v;
  }
  return out;
}

/** Runs the tool's checks: the first that works says the version. */
async function probe(
  spec: ToolSpec,
  params: Params,
  deps: EnsureDeps,
): Promise<{ ok: boolean; version?: string; output: string }> {
  if (spec.id === 'dotnet-sdk' && deps.dotnet) {
    const { sel, gap } = dotnetPlan(params, deps);
    const top = sel.chosen?.sdks.at(-1);
    const where = sel.chosen ? ` in ${shortPath(sel.chosen.root)} (has ${sel.chosen.sdks.join(', ')})` : '';
    return gap.problems.length
      ? { ok: false, ...(top ? { version: top } : {}), output: `${gap.problems.join('; ')}${where}` }
      : { ok: true, ...(top ? { version: top } : {}), output: '' };
  }
  let output = '';
  for (const c of spec.checks(params, deps.platform)) {
    const r = await deps.exec.run(c.cmd, c.args, { timeoutMs: 60_000, ...dotnetRunEnv(c.cmd, deps) });
    output = `${r.stdout}\n${r.stderr}`;
    if (r.exitCode !== 0) continue;
    if (c.contains && !containsToken(output, c.contains)) continue;
    const version = c.version ? (c.version.exec(output)?.[1] ?? undefined) : undefined;
    const want = spec.minVersion?.(params);
    if (want && version && !versionAtLeast(version, want))
      return { ok: false, version, output: `found ${version}, need ${want} or newer` };
    return { ok: true, ...(version ? { version } : {}), output };
  }
  return { ok: false, output: tail(output) || 'not found' };
}

/** A workload id as a whole word on a line (`maui` must not match `maui-android`). */
function containsToken(output: string, token: string): boolean {
  return output.split('\n').some((l) => l.trim().split(/\s+/)[0] === token);
}

async function ensureTool(
  toolId: string,
  t: { spec: ToolSpec; params: Params; stack: string },
  access: DevOpsAccess,
  detected: DetectedManager[],
  rootMode: string,
  deps: EnsureDeps,
  log: (l: string) => void,
  done: Map<string, ToolReport>,
): Promise<ToolReport> {
  const { spec, params, stack } = t;
  const base = { stack, tool: spec.name };
  const blocker = (spec.after ?? [])
    .map((a) => done.get(a))
    .find((r) => r && r.status !== 'ok' && r.status !== 'installed');
  if (blocker) return { ...base, status: 'skipped', detail: `waiting for ${blocker.tool}` };

  const before = await probe(spec, params, deps);
  if (before.ok) {
    log(`${spec.name}: ok${before.version ? ` ${before.version}` : ''}`);
    return { ...base, status: 'ok', ...(before.version ? { version: before.version } : {}) };
  }
  log(`${spec.name}: missing (${before.output})`);
  const manualBase = spec.manual?.(params, deps.platform);
  // Whatever DevOps installs for the agents has to be registered, or the sandbox cannot see it.
  const manual = manualBase
    ? `${manualBase}. Then register it for the agents: aom toolchain add <name> --bin <its bin folder> (a user-space install is best; .NET under ~/.dotnet is found automatically).`.slice(
        0,
        900,
      )
    : manualBase;
  const needsAccess = (why: string, fix: string): ToolReport => ({
    ...base,
    status: 'needs_access',
    detail: why,
    fix: manual && !fix.includes(manual) ? `${fix} Or do it yourself: ${manual}` : fix,
  });

  // Docker's daemon refusing the runner user is a rights problem, not something to install.
  if (spec.id === 'docker-daemon' && /permission denied/i.test(before.output))
    return {
      ...base,
      status: 'failed',
      detail: 'the runner user may not use Docker (permission denied)',
      fix: 'Add the runner user to the docker group: sudo usermod -aG docker $USER, then restart the runner.',
    };

  if (!access.allowInstall)
    return needsAccess(
      before.output,
      `Allow "Install packages and tools" for this workstation's DevOps engineer, then check again.`,
    );
  if (spec.docker && !access.allowDocker)
    return needsAccess(
      before.output,
      'Allow "Docker" for this workstation\'s DevOps engineer, then check again.',
    );

  // Pick the first installer whose steps can run with the rights there are.
  const managers = detected.map((m) => m.id);
  let recipes = spec.recipes(params, deps.platform);
  if (spec.id === 'dotnet-sdk' && deps.dotnet && deps.platform !== 'win32') {
    // Install into the root the agents use. A user-level root (~/.dotnet) is filled by the official script without
    // administrator rights; a system root (/usr/share/dotnet) keeps the package manager recipes.
    const { sel, gap } = dotnetPlan(params, deps);
    const root = sel.chosen?.root ?? join(homedir(), '.dotnet');
    if (!sel.chosen || dotnetRootWritable(root)) {
      const sdk = gap.channels.length
        ? gap.channels
        : gap.runtimeChannels.length
          ? []
          : [`${params.sdkMajor ?? '8'}.0`];
      recipes = { any: [{ cmd: 'bash', args: ['-c', dotnetInstallInto(root, sdk, gap.runtimeChannels)] }] };
    } else delete recipes.any;
  }
  const candidates: Manager[] = [
    ...managers.filter((m) => recipes[m]),
    ...(recipes.any ? (['any'] as Manager[]) : []),
  ];
  if (!candidates.length)
    return {
      ...base,
      status: 'failed',
      detail: managers.length
        ? `no installer for ${spec.name} with the package managers found here (${managers.join(', ')})`
        : `no installer for ${spec.name}: no package manager found on this ${deps.platform} workstation (looked for ${managerCommands(deps.platform).join(', ')})`,
      ...(managers.length
        ? manual
          ? { fix: manual }
          : {}
        : { fix: [noManagerAdvice(deps.platform), manual].filter(Boolean).join(' Or: ') }),
    };
  const rootAllowed =
    rootMode === 'root' || (access.sudo && (rootMode === 'passwordless' || rootMode === 'password'));
  const runnable = candidates.find((m) => (recipes[m] as Step[]).every((s) => !s.root || rootAllowed));
  if (!runnable) {
    return needsAccess(
      'installing it needs administrator rights',
      access.sudo
        ? 'sudo does not work for the runner user: enter its password in the DevOps access settings.'
        : 'Allow "Administrator (sudo)" for the DevOps engineer, or run the installer yourself.',
    );
  }

  // Homebrew found by its absolute path (not on the service's PATH) is run by that path.
  const chosen = detected.find((m) => m.id === runnable);
  let lastErr = '';
  for (const raw of recipes[runnable] as Step[]) {
    const step: Step = chosen && raw.cmd === chosen.cmd ? { ...raw, cmd: chosen.path } : raw;
    log(`$ ${step.root ? 'sudo ' : ''}${step.cmd} ${step.args.join(' ')}`);
    const r =
      step.root && rootMode !== 'root'
        ? await deps.root.run(step.cmd, step.args, { timeoutMs: 30 * 60_000 })
        : await deps.exec.run(step.cmd, step.args, {
            timeoutMs: 30 * 60_000,
            ...dotnetRunEnv(step.cmd, deps),
          });
    for (const line of `${r.stdout}\n${r.stderr}`.split('\n').slice(-12))
      if (line.trim()) log(`  ${line.trim()}`);
    if (r.exitCode !== 0) {
      lastErr = tail(r.stderr || r.stdout) || `exit code ${r.exitCode}`;
      log(`  exit ${r.exitCode}`);
      break;
    }
  }
  const after = await probe(spec, params, deps);
  if (after.ok) {
    log(`${spec.name}: installed${after.version ? ` ${after.version}` : ''}`);
    return {
      ...base,
      status: 'installed',
      ...(after.version ? { version: after.version } : {}),
      detail: `installed with ${runnable === 'any' ? 'its official installer' : runnable}`,
    };
  }
  return {
    ...base,
    status: 'failed',
    detail: lastErr || after.output || 'still not found after installing',
    ...(manual ? { fix: manual } : {}),
  };
}

export type { Check };

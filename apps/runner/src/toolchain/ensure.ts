import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  type DevOpsAccess,
  type EnvEnsurePayload,
  type EnvironmentReport,
  normalizeProjectPath,
  type ToolReport,
} from '@aom/shared';
import { allowScriptsHint, planInstall } from '../policy/installs.ts';
import { redact } from '../secrets/redact.ts';
import { detectStacks, viewOf } from './detect.ts';
import {
  type DotnetSelection,
  dotnetGaps,
  dotnetProcessEnv,
  dotnetRootWritable,
  shortPath,
} from './dotnet.ts';
import type { Executor } from './exec.ts';
import { type DetectedManager, detectManagers, noManagerAdvice } from './managers.ts';
import { dotnetUserInstall, rustEnv } from './sources.ts';
import { DOCKER_BY_INSTALLER, STACKS, TOOLS } from './stacks.ts';
import type { Check, DepStep, Detection, Params, Platform, Step, ToolSpec } from './types.ts';
import {
  createUserInstaller,
  toolchainsRoot,
  type UserInstaller,
  type UserInstallResolver,
} from './user-install.ts';

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

/** What a tool that only a system package provides says (1.10.0: Guildwise never runs a package manager). */
export const SYSTEM_DEPENDENCY = 'system dependency: Guildwise does not install system packages';

export interface EnsureDeps {
  /** Runs every check and install step, as the runner user (never with root). */
  exec: Executor;
  platform: Platform;
  /**
   * The user-space installs into `<passwd home>/.local/share/guildwise/toolchains` (default: the real downloader).
   * Tests inject a stub.
   */
  userInstaller?: UserInstaller;
  /** The toolchains root (default: from the password database). */
  toolchainsRoot?: string;
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
  /**
   * R18-S: the repository may run its install scripts (policy.json `installScripts`, by normalized remote URL). Absent or
   * false: only the script-free install modes run (`policy/installs.ts`); every other install is refused.
   */
  installScriptsAllowed?: (remoteUrlNormalized: string) => boolean;
  /**
   * uat-runner-fixes-3 finding 5: whether the clone can hold card work (`repoStartState`): empty (no commit anywhere) or
   * its working branch missing. Absent: not checked (tests of the toolchain alone).
   */
  repoState?: (
    localPath: string,
    workingBranch: string | undefined,
  ) => Promise<{ empty: boolean; branch: string; branchMissing: boolean }>;
  /**
   * quiet-approvals [D3] `toolsOnly`: only checksum-verified user-space downloads run (the resolver path). A tool without
   * one, and every dependency step, is not run and is listed in `deferred` (it waits for one local yes).
   */
  toolsOnly?: boolean;
  /** quiet-approvals [B1]: only these tool ids (`aom toolchain ensure <tool>` in the box). */
  onlyTools?: readonly string[];
}

/** The report of `ensureEnvironment`, plus what a `toolsOnly` run left for a local yes. */
export type EnsureReport = EnvironmentReport & { deferred?: string[] };

/** [D3] What a tools-only run says for a tool or step it may not run by itself. */
export const TOOLS_ONLY_DEFERRED =
  'not a checksum-verified download: it waits for a local yes on this computer (Approvals on this computer)';

/**
 * Env for a command: `dotnet` and its installers run with the chosen root first on PATH and as DOTNET_ROOT; the rustup
 * proxies installed under the toolchains root need its RUSTUP_HOME. (`<root>/bin` is first on every command's PATH,
 * `userBinDirs`.)
 */
function dotnetRunEnv(
  cmd: string,
  deps: EnsureDeps,
): { env: Record<string, string> } | Record<string, never> {
  const chosen = cmd === 'dotnet' ? deps.dotnet?.().chosen : undefined;
  const env: Record<string, string> = chosen ? dotnetProcessEnv(chosen, process.env.PATH) : {};
  if (cmd === 'cargo' || cmd === 'rustc' || cmd === 'rustup') {
    const rustup = rustEnv(rootOf(deps)).RUSTUP_HOME as string;
    if (!process.env.RUSTUP_HOME && existsSync(rustup)) env.RUSTUP_HOME = rustup;
  }
  return Object.keys(env).length ? { env } : {};
}

const rootOf = (deps: EnsureDeps): string => deps.toolchainsRoot ?? toolchainsRoot();

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
 * `stacks.ts`; every command goes through `deps.exec` or the user-space installer, as the runner user, and is logged. Nothing runs
 * as root and no package manager runs: a system package is reported with the owner's command.
 */
export async function ensureEnvironment(p: EnvEnsurePayload, deps: EnsureDeps): Promise<EnsureReport> {
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
  const runs: Array<{ name: string; localPath: string; detections: Detection[]; remote: string }> = [];
  const emptyRepos: NonNullable<EnvironmentReport['emptyRepos']> = [];

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
    // An empty repository (no commit in the clone or on origin) has no branch to start a card from: say so plainly, once.
    const start = deps.repoState
      ? await deps.repoState(repo.localPath, r.workingBranch).catch(() => null)
      : null;
    if (start?.empty) {
      emptyRepos.push({ repoId: r.repoId, name: r.name, branch: start.branch });
      reports.push({
        stack: 'repository',
        tool: r.name,
        status: 'failed',
        detail: 'the repository is empty: it has no commits yet',
        fix: `Create the first commit on ${start.branch} (one click on the desk), or push one yourself, then check again.`,
      });
      log(`${r.name}: empty repository (no commits); the first commit would go on ${start.branch}`);
      continue;
    }
    if (start?.branchMissing)
      log(
        `${r.name}: working branch ${start.branch} does not exist yet; the first card creates it from the default branch`,
      );
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
    runs.push({ name: r.name, localPath: projectDir, detections, remote: r.remoteUrlNormalized });
    for (const d of detections) {
      stackList.push({ id: d.id, name: d.name, repo: r.name });
      const stack = tables.stacks.find((s) => s.id === d.id);
      for (const toolId of stack?.tools(d, deps.platform) ?? []) {
        const spec = tables.tools[toolId];
        if (!spec) continue;
        if (deps.onlyTools && !deps.onlyTools.includes(toolId)) continue;
        const seen = need.get(toolId);
        // Two repositories asking for different versions: the higher one wins.
        if (!seen) need.set(toolId, { spec, params: { ...d.params }, stack: d.id });
        else seen.params = mergeParams(seen.params, d.params);
      }
    }
  }

  // 2. Verify, then install what is missing.
  // package managers are only probed to name the owner's command for a system package
  const manager = await detectManagers(deps.exec, deps.platform);
  const done = new Map<string, ToolReport>();
  for (const [toolId, t] of need) {
    const report = await ensureTool(toolId, t, p.access, manager, deps, log, done);
    done.set(toolId, report);
    reports.push(report);
  }

  // 3. D6: the project's own dependencies (pnpm/pip/dotnet restore ...), once its tools are in place.
  // quiet-approvals [D3]: a tools-only run never runs one; each is listed for the local yes instead
  const deferred: string[] = reports
    .filter((r) => r.status === 'needs_access' && r.detail === TOOLS_ONLY_DEFERRED)
    .map((r) => r.tool);
  if (deps.toolsOnly) {
    if (deps.installDependencies !== false && !deps.onlyTools)
      for (const run of runs)
        for (const d of run.detections) {
          const stack = tables.stacks.find((x) => x.id === d.id);
          for (const step of stack?.deps?.(d, deps.platform) ?? [])
            deferred.push(runs.length > 1 ? `${step.name} (${run.name})` : step.name);
        }
  } else if (deps.installDependencies !== false)
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
  return {
    state,
    stacks: stackList,
    tools: reports,
    summary,
    logTail,
    ...(emptyRepos.length ? { emptyRepos } : {}),
    ...(deps.toolsOnly && deferred.length ? { deferred } : {}),
  };
}

/** The program a dependency step runs: a repository script (`./mvnw`, a Windows `.cmd` path) resolved in `dir`, else the command. */
export function depCommand(step: DepStep, dir: string): string {
  const cmd = step.cmd.startsWith('./') || step.cmd.includes('\\') ? join(dir, step.cmd) : step.cmd;
  return isAbsolute(cmd) ? cmd : step.cmd;
}

/**
 * D6: runs each detected stack's dependency steps in the repository folder (`pnpm install`, `dotnet restore`, pip into
 * `.venv`, `go mod download`, `cargo fetch`, ...). A step waits for its tools; nothing runs unless the manager allowed
 * installing. A failing install makes the environment "failed" with the log tail, like a failing tool install.
 */
async function installDependencies(
  runs: Array<{ name: string; localPath: string; detections: Detection[]; remote: string }>,
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
        // R18-S: only installs proven to run no repository code run by themselves
        const plan = planInstall(
          step,
          run.localPath,
          run.remote,
          deps.installScriptsAllowed?.(run.remote) ?? false,
        );
        if (!plan.ok) {
          log(`  refused: ${plan.reason}`);
          out.push({
            ...base,
            status: 'failed',
            detail: plan.reason.slice(0, 500),
            fix: allowScriptsHint(run.remote),
          });
          break;
        }
        log(`$ (${run.name}) ${step.cmd} ${plan.args.join(' ')}`);
        const dotnetEnv = dotnetRunEnv(step.cmd, deps);
        const r = await deps.exec.run(depCommand(step, run.localPath), plan.args, {
          cwd: run.localPath,
          timeoutMs: 30 * 60_000,
          ...dotnetEnv,
          ...(Object.keys(plan.env).length
            ? { env: { ...('env' in dotnetEnv ? dotnetEnv.env : {}), ...plan.env } }
            : {}),
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
  const manual =
    manualBase && !spec.docker
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

  // Docker's daemon refusing the runner user is the installer's business, not something DevOps installs.
  if (spec.id === 'docker-daemon' && /permission denied/i.test(before.output))
    return {
      ...base,
      status: 'failed',
      detail: 'the runner user may not use Docker (permission denied)',
      fix: DOCKER_BY_INSTALLER,
    };

  // What may run: the user-space install (checksum verified) and steps the runner user runs itself.
  const recipes = spec.recipes(params, deps.platform);
  let resolver: UserInstallResolver | undefined = spec.userInstall;
  if (spec.id === 'dotnet-sdk' && deps.dotnet && deps.platform !== 'win32') {
    // Into the root the agents use (or a root of our own under the toolchains folder when there is none).
    const { sel, gap } = dotnetPlan(params, deps);
    const chosenRoot = sel.chosen?.root;
    if (chosenRoot && !dotnetRootWritable(chosenRoot))
      return {
        ...base,
        status: 'failed',
        detail: `the .NET root ${shortPath(chosenRoot)} is not writable by the runner user (${before.output})`,
        fix: `Install the SDK into ${chosenRoot} yourself${ownerCommand(recipes, detected) ? ` (${ownerCommand(recipes, detected)})` : ''}, or set dotnetRoot in the runner's config.json to ${join(rootOf(deps), 'dotnet')} so DevOps installs it there, then check again.`,
      };
    const sdk = gap.channels.length
      ? gap.channels
      : gap.runtimeChannels.length
        ? []
        : [`${params.sdkMajor ?? '8'}.0`];
    resolver = dotnetUserInstall(chosenRoot, sdk, gap.runtimeChannels);
  }
  const steps = recipes.any;
  if (!resolver && !steps?.length) return systemDependency(base, recipes, detected, deps.platform, manual);
  // quiet-approvals [D3]: a tools-only run downloads only through a checksum-verified resolver
  if (deps.toolsOnly && !resolver) return { ...base, status: 'needs_access', detail: TOOLS_ONLY_DEFERRED };

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

  let how = 'its official installer';
  let lastErr = '';
  const installer = deps.userInstaller ?? createUserInstaller();
  const result = resolver ? await installer.install(spec.id, resolver, params, log) : null;
  if (result) {
    if (!result.ok)
      return { ...base, status: 'failed', detail: result.detail, ...(manual ? { fix: manual } : {}) };
    how = "a checksum-verified download into the runner's toolchains folder";
  } else if (steps?.length && !deps.toolsOnly) {
    for (const step of steps) {
      log(`$ ${step.cmd} ${step.args.join(' ')}`);
      const r = await deps.exec.run(step.cmd, step.args, {
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
  } else return systemDependency(base, recipes, detected, deps.platform, manual);
  const after = await probe(spec, params, deps);
  if (after.ok) {
    log(`${spec.name}: installed${after.version ? ` ${after.version}` : ''}`);
    return {
      ...base,
      status: 'installed',
      ...(after.version ? { version: after.version } : {}),
      detail: `installed with ${how}`,
    };
  }
  return {
    ...base,
    status: 'failed',
    detail: lastErr || after.output || 'still not found after installing',
    ...(manual ? { fix: manual } : {}),
  };
}

/**
 * The owner's command for the system packages of a tool, for the first package manager found here (`sudo` where that
 * manager needs root). Shown only; never run.
 */
export function ownerCommand(
  recipes: Partial<Record<string, Step[]>>,
  detected: DetectedManager[],
): string | undefined {
  for (const m of detected) {
    const steps = recipes[m.id];
    if (!steps?.length) continue;
    return steps
      .map((s) => `${m.needsRoot ? 'sudo ' : ''}${s.cmd === m.cmd ? m.path : s.cmd} ${s.args.join(' ')}`)
      .join(' && ');
  }
  return undefined;
}

/** A tool only a system package provides: `failed`, with the command the machine owner can run. */
function systemDependency(
  base: { stack: string; tool: string },
  recipes: Partial<Record<string, Step[]>>,
  detected: DetectedManager[],
  platform: Platform,
  manual: string | undefined,
): ToolReport {
  const cmd = ownerCommand(recipes, detected);
  const hasPackages = Object.keys(recipes).some((k) => k !== 'any');
  const fix = cmd
    ? `Ask the machine owner to run: ${cmd}${manual ? ` (or: ${manual})` : ''}`
    : manual
      ? detected.length || !hasPackages
        ? manual
        : [manual, noManagerAdvice(platform)].join(' Or: ')
      : noManagerAdvice(platform);
  return { ...base, status: 'failed', detail: SYSTEM_DEPENDENCY, fix: fix.slice(0, 1200) };
}

export type { Check };

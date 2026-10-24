import type { AgentPermissions } from '../roles/schema.ts';
import { splitBackendModel } from './backends.ts';

/**
 * The CLI harness runtimes besides Claude Code (docs/RUNNER.md, "Sandbox parity of the other runtimes"). Each runs a vendor's
 * agent CLI on the workstation for card work and chats, inside an OS sandbox the runner (or the CLI) provides. A role may only
 * run on one of them when the sandbox keeps every guarantee the role relies on: this module is the single rule the server (hiring,
 * moving an agent, the CEO's raise-model action), the runner (at session start) and the web (pickers) share.
 */
export const CODEX_RUNTIME = 'codex';
export const GEMINI_RUNTIME = 'gemini';
export const OPENCODE_RUNTIME = 'opencode';

/** Runtimes whose agents run inside a harness sandbox with restrictions, in the order the pickers list them. */
export const CLI_HARNESS_RUNTIMES: readonly string[] = [CODEX_RUNTIME, GEMINI_RUNTIME, OPENCODE_RUNTIME];

/** Roles that never run on another CLI harness whatever their permissions (their guard and full-power profiles are Claude Code's). */
export const HARNESS_REFUSED_ROLES: readonly string[] = ['devops', 'ceo'];

export interface RuntimeGuarantees {
  runtime: string;
  /** For messages: "the Gemini CLI runtime". */
  label: string;
  /** The product's short name: "Gemini CLI". */
  short: string;
  /**
   * A role without the `shell` tool can still run: the runtime has a shell that runs only `aom ...` (the way Claude Code allows
   * `Bash(aom:*)`). False: the runtime always has a full shell, so shell-less roles stay on Claude Code.
   */
  aomOnlyShell: boolean;
  /**
   * `aomOnlyShell` holds only in the runner's own harness sandbox (Codex on Linux and WSL2: the box's `bash` is a shim that runs
   * `aom ...` and nothing else); the sandbox of the same CLI on macOS (its own permission profile) always has a full shell. The
   * runner passes where it runs (`RuntimeEnvironment.harness`); the server, which does not know, lets the role through.
   */
  aomOnlyShellNeedsHarness?: boolean;
  /** Browser roles (Unix sockets for Chromium/Playwright) can be confined. */
  browser: boolean;
  /** A role that may write only some paths (`writableGlobs`) can be confined. */
  pathScopedWrites: boolean;
}

/** What each runtime's sandbox can and cannot give a role. Claude Code is the reference and is not listed. */
export const RUNTIME_GUARANTEES: Readonly<Record<string, RuntimeGuarantees>> = {
  [CODEX_RUNTIME]: {
    runtime: CODEX_RUNTIME,
    label: 'the Codex runtime',
    short: 'Codex',
    // Q68: in the runner's harness sandbox the box's bash is the aom-only shim (docs/RUNNER.md, "Codex without a shell")
    aomOnlyShell: true,
    aomOnlyShellNeedsHarness: true,
    browser: false,
    pathScopedWrites: false,
  },
  [GEMINI_RUNTIME]: {
    runtime: GEMINI_RUNTIME,
    label: 'the Gemini CLI runtime',
    short: 'Gemini CLI',
    aomOnlyShell: true,
    browser: false,
    pathScopedWrites: false,
  },
  [OPENCODE_RUNTIME]: {
    runtime: OPENCODE_RUNTIME,
    label: 'the opencode runtime',
    short: 'opencode',
    aomOnlyShell: true,
    browser: false,
    pathScopedWrites: false,
  },
};

/** Where a runtime runs, for the guarantees that depend on it. */
export interface RuntimeEnvironment {
  /** The session runs in the runner's own harness sandbox (false: the CLI's own sandbox, as Codex does on macOS). Unknown: absent. */
  harness?: boolean;
}

export interface RoleForRuntimeCheck {
  roleKey: string;
  isDevops?: boolean;
  permissions: Pick<AgentPermissions, 'allowedTools' | 'writableGlobs' | 'browser'>;
}

/**
 * Why an agent with this role and these permissions cannot run on `runtime`, or null when it can (or when the runtime is not one
 * with restrictions: Claude Code, the mock). The sandbox of a harness runtime gives a private home, a worktree-only write area, a
 * read allow-list and (Gemini, opencode) a domain allow-list for the network, but it cannot: host the DevOps guard or the CEO's
 * full-power profile, open the Unix sockets a browser needs, limit writes to globs that do not exist yet (a tester's e2e folder),
 * and, for a runtime with `aomOnlyShell: false`, remove the shell tool. The runner applies the same rule at session start.
 */
export function runtimeRoleProblem(
  runtime: string,
  role: RoleForRuntimeCheck,
  /** Where the runtime runs, when known (the runner knows; the server does not and passes nothing). */
  env: RuntimeEnvironment = {},
): string | null {
  const g = RUNTIME_GUARANTEES[runtime];
  if (!g) return null;
  const use = 'use Claude Code';
  if (role.isDevops || HARNESS_REFUSED_ROLES.includes(role.roleKey))
    return `the ${role.roleKey} role needs its own guard and full workstation access, which the ${g.short} sandbox cannot provide: ${use}`;
  const p = role.permissions;
  if (!p.allowedTools.includes('shell') && !g.aomOnlyShell)
    return `this role has no shell, and ${g.short} always has one: ${use} (the shell-less roles are not offered on ${g.short})`;
  if (!p.allowedTools.includes('shell') && g.aomOnlyShellNeedsHarness && env.harness === false)
    return `this role has no shell, and ${g.short} has one on this workstation that the runner cannot limit to aom (its own sandbox, not the runner's): ${use}`;
  if (p.browser && !g.browser)
    return `this role runs browsers, which need Unix sockets the ${g.short} sandbox does not open: ${use}`;
  if (p.allowedTools.includes('edit') && p.writableGlobs !== null && !g.pathScopedWrites)
    return `this role may write only certain paths, which the ${g.short} sandbox cannot limit to files that do not exist yet: ${use}`;
  return null;
}

/** Should the picker offer this runtime for the role at all (a quick yes/no for the web)? */
export const runtimeAllowsRole = (runtime: string, role: RoleForRuntimeCheck): boolean =>
  runtimeRoleProblem(runtime, role) === null;

/**
 * Claude Code through Bedrock, Vertex or a gateway uses a credential the runner holds, which the CEO's full-power turns and the
 * DevOps engineer (the owner's own Claude login, the owner's whole machine) cannot take. Null when the model is not a backend model.
 */
export function claudeBackendRoleProblem(
  model: string,
  role: Pick<RoleForRuntimeCheck, 'roleKey' | 'isDevops'>,
): string | null {
  if (splitBackendModel(model) === null) return null;
  if (role.isDevops || HARNESS_REFUSED_ROLES.includes(role.roleKey))
    return `the ${role.roleKey} role works with the owner's own Claude login and full workstation access, which a Bedrock, Vertex or gateway credential cannot give: use a Claude model`;
  return null;
}

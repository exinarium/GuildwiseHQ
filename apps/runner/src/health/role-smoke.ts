import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { BUILTIN_ROLES, type IpcReportRequest, type IpcRpcResponse } from '@aom/shared';
import { execa } from 'execa';
import { buildShiftSettings, type ClaudePolicyContext, ruleAbs } from '../adapters/claude-policy.ts';
import type { IpcServer } from '../ipc/server.ts';
import type { RunnerPaths } from '../paths.ts';
import { ensureSandbox, sandboxEnv } from '../sandbox/sandbox.ts';

/**
 * The role smoke test (Lean Team v3, runner 0.1.24). On runner start and after every update each built-in role goes down
 * its own handoff path on this workstation, with no call to Claude:
 *
 * 1. the role's permissions are turned into Claude Code settings exactly as a shift does, and a role that cannot edit must
 *    still be allowed to write its scratch folder (the reviewer's risk file, the BA's notes) with no bare `Edit`/`Write`
 *    deny in the way (a bare deny made the reviewers' handoffs fail);
 * 2. the role's own `aom` handoff command runs as the real `bin/aom` shim, with the environment of the role's sandbox
 *    (private HOME, TMPDIR, config dir), against the runner's IPC server, reading the files the agent would have written
 *    in its scratch folder. The runner answers it itself ("dry run": nothing reaches the server).
 *
 * `aom` itself runs outside Claude Code's shell sandbox by design (it has to reach the runner's socket), so this is the
 * path that matters; the bubblewrap boundary is covered by claude-sandbox-real.test.ts. A role that fails is reported
 * to the server, which offers it no work on this workstation until a later run passes.
 */

export interface SmokeResult {
  roleKey: string;
  ok: boolean;
  detail?: string;
}

interface SmokeCase {
  /** Files the agent would have written in its scratch folder first (name -> content). */
  files: Record<string, string>;
  /** `aom` arguments; `{scratch}` stands for the scratch folder. */
  argv: string[];
  /** The report the runner must have received. */
  expect: (r: IpcReportRequest['report']) => boolean;
}

const note = (r: IpcReportRequest['report']): boolean => r.kind === 'outcome' || r.kind === 'comment';

const CASES: Record<string, SmokeCase> = {
  builder: {
    files: { 'note.md': 'smoke test of the build handoff\n' },
    argv: ['handoff', '--note-file', '{scratch}/note.md'],
    expect: (r) => r.kind === 'outcome' && r.outcomeId === 'handoff',
  },
  reviewer: {
    files: { 'risk.md': 'Blast radius: none (smoke test).\nVerified: the file flag path.\n' },
    argv: [
      'review',
      'approve',
      '--note',
      'smoke test',
      '--score',
      '5',
      '--risk',
      'low',
      '--risk-file',
      '{scratch}/risk.md',
    ],
    expect: (r) =>
      r.kind === 'outcome' &&
      r.outcomeId === 'approve' &&
      typeof (r.data as { riskAnalysis?: unknown }).riskAnalysis === 'string',
  },
  tester: {
    files: { 'evidence.md': 'smoke test evidence\n' },
    argv: ['test', 'pass', '--evidence', 'smoke test'],
    expect: (r) => r.kind === 'outcome' && r.outcomeId === 'pass',
  },
  devops: {
    files: {},
    argv: ['devops-done', '--summary', 'smoke test'],
    expect: (r) => r.kind === 'outcome' && r.outcomeId === 'devops_done',
  },
};

/** Every other role comments from a file: the note-file path is the one a no-edit role depends on. */
const DEFAULT_CASE: SmokeCase = {
  files: { 'note.md': 'smoke test note\n' },
  argv: ['comment', '--note-file', '{scratch}/note.md'],
  expect: note,
};

export interface RoleSmokeDeps {
  paths: RunnerPaths;
  ipc: IpcServer;
  /** Roles to test (default: the built-in roles). */
  roles?: ReadonlyArray<{ key: string; permissions: (typeof BUILTIN_ROLES)[number]['permissions'] }>;
  /** Test hook: the `aom` command (default: the runner's own shim, `bin/aom`). */
  aom?: string[];
  timeoutMs?: number;
}

/** What a role's settings must allow, checked on the rules themselves (no process). Null when fine. */
export function settingsProblem(
  role: { key: string; permissions: (typeof BUILTIN_ROLES)[number]['permissions'] },
  paths: RunnerPaths,
  scratch: string,
  cwd: string,
  agentDir: string,
): string | null {
  const ctx: ClaudePolicyContext = {
    runnerRoot: paths.root,
    agentDir,
    cwd,
    addDirs: [],
    gitDirs: [],
    aomReadPaths: [paths.bin],
    realHome: homedir(),
    mode: 'best_effort',
  };
  let s: ReturnType<typeof buildShiftSettings>;
  try {
    s = buildShiftSettings(
      role.permissions,
      ctx,
      {
        home: join(agentDir, 'home'),
        configDir: join(agentDir, 'config'),
        scratch,
        tmp: join(agentDir, 'tmp'),
      },
      role.key,
    );
  } catch (err) {
    return `the role's settings cannot be built: ${err instanceof Error ? err.message : String(err)}`;
  }
  return rulesProblem(s.permissions, role.key, new Set(role.permissions.allowedTools), scratch);
}

/** The rule check behind `settingsProblem`, on the permission rules alone. Null when fine. */
export function rulesProblem(
  permissions: { allow: string[]; deny: string[] },
  roleKey: string,
  tools: ReadonlySet<string>,
  scratch: string,
): string | null {
  const deny = permissions.deny;
  if (tools.has('shell') && deny.includes('Bash')) return 'a bare Bash deny blocks the aom command';
  if (!tools.has('edit') || roleKey === 'tester') {
    const bare = deny.filter((d) => d === 'Edit' || d === 'Write'); // (NotebookEdit does not write a handoff file)
    if (bare.length > 0)
      return `a bare ${bare.join('/')} deny also blocks the scratch folder (the role cannot write the file its handoff reads)`;
    const rule = `Edit(${ruleAbs(scratch)}/**)`;
    if (!permissions.allow.includes(rule))
      return `the scratch folder is not writable (${rule} is not allowed)`;
  }
  return null;
}

export async function runRoleSmoke(deps: RoleSmokeDeps): Promise<SmokeResult[]> {
  const { paths, ipc } = deps;
  const roles = deps.roles ?? BUILTIN_ROLES;
  const out: SmokeResult[] = [];
  for (const role of roles) {
    const c = CASES[role.key] ?? DEFAULT_CASE;
    const agentId = `smoke-${role.key}`;
    const sb = await ensureSandbox(paths, agentId, role.key, {
      name: 'Smoke Test',
      email: 'smoke@localhost',
    }).catch((err) => err as Error);
    if (sb instanceof Error) {
      out.push({
        roleKey: role.key,
        ok: false,
        detail: `the role's sandbox cannot be made: ${sb.message}`.slice(0, 400),
      });
      continue;
    }
    const agentDir = dirname(sb.home);
    const cwd = join(agentDir, 'smoke-worktree');
    const received: IpcReportRequest['report'][] = [];
    let token: string | undefined;
    try {
      mkdirSync(cwd, { recursive: true });
      const policy = settingsProblem(role, paths, sb.scratch, cwd, agentDir);
      if (policy) {
        out.push({ roleKey: role.key, ok: false, detail: policy.slice(0, 400) });
        continue;
      }
      for (const [name, content] of Object.entries(c.files)) writeFileSync(join(sb.scratch, name), content);
      token = ipc.registerShift({
        report: async (req) => {
          received.push(req.report);
          return { accepted: true, message: 'Recorded (smoke test).' };
        },
        rpc: async () => ({ ok: true, result: {} }) as IpcRpcResponse,
      });
      const argv = c.argv.map((a) => a.replaceAll('{scratch}', sb.scratch));
      const [bin, ...pre] = deps.aom ?? [join(paths.bin, 'aom')];
      const r = await execa(bin as string, [...pre, ...argv], {
        cwd: sb.scratch,
        reject: false,
        timeout: deps.timeoutMs ?? 60_000,
        stdin: 'ignore',
        extendEnv: false,
        env: {
          ...sandboxEnv(sb, undefined, undefined, { name: 'Smoke Test', email: 'smoke@localhost' }),
          AOM_IPC_URL: ipc.url,
          ...(ipc.socketPath ? { AOM_IPC_SOCKET: ipc.socketPath } : {}),
          AOM_SHIFT_TOKEN: token,
          AOM_SHIFT_ID: `smoke-${role.key}`,
          PATH: `${paths.bin}${delimiter}${process.env.PATH ?? ''}`,
        },
      });
      if (r.exitCode !== 0) {
        const why = `${r.stderr || r.stdout || r.shortMessage || 'no output'}`
          .trim()
          .split('\n')
          .slice(-3)
          .join(' | ');
        out.push({
          roleKey: role.key,
          ok: false,
          detail: `\`aom ${argv.slice(0, 2).join(' ')}\` failed (exit ${r.exitCode ?? 'none'}): ${why}`.slice(
            0,
            400,
          ),
        });
      } else if (!received.some(c.expect)) {
        out.push({
          roleKey: role.key,
          ok: false,
          detail: 'the runner did not receive the expected report from aom',
        });
      } else out.push({ roleKey: role.key, ok: true });
    } catch (err) {
      out.push({
        roleKey: role.key,
        ok: false,
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 400),
      });
    } finally {
      if (token) ipc.revoke(token);
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(sb.tmp, { recursive: true, force: true });
    }
  }
  return out;
}

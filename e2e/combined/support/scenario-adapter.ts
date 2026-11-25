import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MockAdapter } from '../../../apps/runner/src/adapters/mock.ts';
import type { RuntimeSession, ShiftStartInput } from '../../../apps/runner/src/adapters/types.ts';
import { selfCommand } from '../../../apps/runner/src/shims.ts';
import { type Ctl, ScriptedAdapter, type ScriptResult } from '../../../apps/runner/test/scripted-adapter.ts';
import { reach, waitRelease } from './gates.ts';

/**
 * The agent stand-in of the combined harness. It is the product's own `MockAdapter` (so every flow the existing e2e
 * suite drives works unchanged) with ONE addition: a shift whose card or DevOps request carries a `[scn:...]` token is
 * played by a script here instead. Everything else (supervisor, guard, fence, auto-commit, IPC, `aom` CLI, server) is the
 * real product code. Not exercised: Claude's own sandbox and the PreToolUse hook (DESIGN section 7).
 *
 * Tokens (in a DevOps request text, or in the title of a card):
 *   [scn:gate=NAME]            DevOps: drop reached/NAME, wait for release/NAME, then behave as the mock engineer.
 *   [scn:hold=NAME;path=P]     DevOps: write a file in P (a card worktree), drop reached/NAME, wait; a stop ends it.
 *   [scn:hold=NAME;path=P;limit] same, but after the release the shift exits with a usage limit.
 *   [scn:stubs]                architect: write the 0-byte sandbox stubs, one real docs report, report with `aom design`.
 *   [scn:deps]                 builder: `aom devops install npm add left-pad` first, then the mock builder.
 *   [scn:a8]                   builder (first shift only): commit the stubs, remove them again, hand off (A8).
 */
export const PLACEHOLDERS = [
  '.idea',
  '.vscode',
  '.bashrc',
  '.npmrc',
  '.mcp.json',
  '.github',
  'scripts',
] as const;

interface Brief {
  card?: { ref: string; title: string; fields?: Record<string, unknown> };
  shift?: { stage: string; kind?: string; outcomes: Array<{ id: string; data: string }> };
  devops?: { summary: string };
  investigation?: { reportPath?: string };
}

/**
 * Runs the real `aom` CLI for a shift. ASYNC on purpose: `aom` talks to the runner's IPC server, which lives in this very
 * process, so a blocking spawn would deadlock the runner (and drop the server connection after 45 s).
 */
function aomIn(input: ShiftStartInput, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const [bin, ...pre] = selfCommand('aom') as [string, ...string[]];
  return new Promise((resolve) => {
    const child = spawn(bin, [...pre, ...args], { cwd: input.cwd, env: input.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.once('error', (e) => resolve({ code: 1, out, err: err + String(e) }));
    child.once('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

const briefOf = async (input: ShiftStartInput): Promise<Brief | null> => {
  const r = await aomIn(input, ['card', '--json']);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.out) as Brief;
  } catch {
    return null;
  }
};

/**
 * Where the token travels: the DevOps request text, or the card TITLE (the server drops unknown card fields, so a custom
 * field never reaches the agent; the title and the `context` field do).
 */
const tokenOf = (b: Brief): string | null => {
  const text = b.devops?.summary ?? `${b.card?.title ?? ''} ${String(b.card?.fields?.context ?? '')}`;
  return /\[scn:([^\]]+)\]/.exec(text)?.[1] ?? null;
};

const part = (token: string, key: string): string | undefined => {
  const hit = token
    .split(';')
    .map((p) => p.trim())
    .find((p) => p === key || p.startsWith(`${key}=`));
  return hit === undefined ? undefined : hit.includes('=') ? hit.slice(key.length + 1) : '';
};

export class ScenarioAdapter extends MockAdapter {
  private readonly runnerRoot: string;

  constructor(
    cfg: ConstructorParameters<typeof MockAdapter>[0],
    paths: ConstructorParameters<typeof MockAdapter>[1],
    private readonly gateDir: string,
  ) {
    super(cfg, paths);
    this.runnerRoot = paths.root;
  }

  /**
   * quiet-approvals [B2]: a runtime that builds the DevOps safety box answers "why it cannot start here, or null"; a runtime
   * WITHOUT that answer (the plain mock runtime) never runs a DevOps request in the box, and the runner HOLDS it for one local
   * yes. This adapter stands in for either, switched per spec through a file in the gate dir (`setBoxState`):
   *   absent            a runtime whose box can start: requests are routed into the inner box with no question
   *   `none`            a runtime with no box at all: every request is held for a local yes (fail closed)
   *   `broken:<reason>` a runtime whose box cannot start here: the request is refused, and the `devops.box` step says how to fix it
   * The mock agent does not really sit in a box (bwrap, the egress proxy and the model proxy need real Claude and are owner/machine
   * items); what is real is the runner's routing, holds, approvals memory, refusals and steps around it.
   */
  get boxMissing(): (() => string | null) | undefined {
    const mode = this.boxState();
    if (mode === 'none') return undefined;
    return () => (mode.startsWith('broken:') ? mode.slice(7) || 'the safety box cannot start (test)' : null);
  }

  private boxState(): string {
    try {
      const f = join(this.gateDir, 'box-state');
      return existsSync(f) ? readFileSync(f, 'utf8').trim() : 'ok';
    } catch {
      return 'ok';
    }
  }

  override async start(input: ShiftStartInput): Promise<RuntimeSession> {
    const brief = await briefOf(input);
    // what the runner told the runtime about the box for this DevOps shift (D1 reads it): `devopsBox: true` only inside the inner box
    if (brief?.devops)
      appendFileSync(
        join(this.gateDir, 'box-seen.log'),
        `${input.shiftId} box=${input.devopsBox === true}\n`,
      );
    const token = brief ? tokenOf(brief) : null;
    if (!brief || !token) return super.start(input);
    // Pre-actions, then the product's own mock agent does the rest of the shift (hand-off, `aom devops-done`, the
    // `[edit_worktree:...]` writes of the mock engineer): same env, same `aom` shim.
    const role = input.agent.roleKey;
    const gate = part(token, 'gate');
    if (gate && brief.devops) {
      reach(this.gateDir, gate);
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 300_000).unref();
      await waitRelease(this.gateDir, gate, ac.signal);
      return super.start(input);
    }
    if (
      part(token, 'deps') !== undefined &&
      !brief.devops &&
      role === 'builder' &&
      brief.shift?.stage === 'build'
    ) {
      // what the mock builder's `deps_install` action does (the server's card validator does not list that action): a
      // Node project, then `aom devops install npm add`, whose answer is kept in the worktree for the spec to read
      if (!existsSync(join(input.cwd, 'package.json')))
        writeFileSync(join(input.cwd, 'package.json'), '{"name":"toy","private":true}\n');
      const r = await aomIn(input, ['devops', 'install', 'npm', 'add', 'left-pad@1.3.0', '--dev']);
      mkdirSync(join(input.cwd, '.guildwise-mock'), { recursive: true });
      writeFileSync(join(input.cwd, '.guildwise-mock', 'deps-install.txt'), `${r.code}\n${r.out}${r.err}`);
      return super.start(input);
    }
    if (
      part(token, 'path') !== undefined &&
      !brief.devops &&
      role === 'builder' &&
      brief.shift?.stage === 'build'
    ) {
      // what the agent's shell would have on PATH (the registered toolchains the owner approved are on it, the others are not)
      mkdirSync(join(input.cwd, '.guildwise-mock'), { recursive: true });
      writeFileSync(join(input.cwd, '.guildwise-mock', 'path.txt'), `${input.env.PATH ?? ''}\n`);
      return super.start(input);
    }
    if (
      part(token, 'a8') !== undefined &&
      !brief.devops &&
      role === 'builder' &&
      brief.shift?.stage === 'build'
    ) {
      // the stubs shape runs once (first builder shift); a rework round after it is the plain mock builder
      const done = join(this.gateDir, 'a8.done');
      if (existsSync(done)) return super.start(input);
      writeFileSync(done, '');
    }
    // a token of a card applies to the shift it names; every other shift of that card is the plain mock agent
    const scoped =
      brief.devops ||
      (part(token, 'stubs') !== undefined && role === 'architect') ||
      (part(token, 'a8') !== undefined && role === 'builder');
    if (!scoped) return super.start(input);
    const scripted = new ScriptedAdapter((i, ctl) => this.play(token, brief, i, ctl), 'mock');
    return scripted.start(input);
  }

  private async play(token: string, brief: Brief, input: ShiftStartInput, ctl: Ctl): Promise<ScriptResult> {
    const note = (text: string) => ctl.emit({ kind: 'progress', text });
    const hold = part(token, 'hold');
    if (brief.devops && hold) {
      const path = part(token, 'path') as string;
      // an uncommitted change in a card worktree: what a DevOps shift must never leave behind
      writeFileSync(join(path, 'devops-wrote-this.txt'), 'written during a DevOps shift\n');
      reach(this.gateDir, hold, path);
      note(`scn: holding at ${hold}`);
      const released = await waitRelease(this.gateDir, hold, ctl.signal);
      if (!released) return { exitCode: 1 };
      // the server puts a stopped or limited request back in the queue: the limit happens once, the re-run just finishes
      const limitOnce = join(this.gateDir, `${hold}.limit-done`);
      if (token.includes('limit') && !existsSync(limitOnce)) {
        writeFileSync(limitOnce, '');
        return { usageLimit: { until: new Date(Date.now() + 3_600_000).toISOString() }, exitCode: 1 };
      }
      await aomIn(input, ['devops-done', '--summary', 'scn: finished after the hold']);
      return { finalText: 'scn: devops done' };
    }
    const tool = part(token, 'toolchain');
    if (brief.devops && tool) {
      // Forge registers the user-level toolchain it "installed" (aom toolchain add), then reports. Inside the DevOps box the
      // runner refuses `toolchain.add` and says to ask for the outside: the agent does exactly that (quiet-approvals R1), the
      // owner says yes once, and the same request runs again outside the box.
      const add = await aomIn(input, ['toolchain', 'add', 'stubnode', '--bin', tool]);
      note(`scn: toolchain add -> ${add.code} ${(add.err || add.out).trim().slice(0, 160)}`);
      if (add.code !== 0 && /devops-outside/.test(add.err + add.out)) {
        const ask = await aomIn(input, [
          'devops-outside',
          '--needs',
          'toolchain.add',
          '--why',
          'register the user-level Node as a toolchain',
        ]);
        note(`scn: asked to work outside the box -> ${ask.code}`);
        return { exitCode: 0, finalText: 'scn: asked for the outside' };
      }
      const done = await aomIn(input, [
        'devops-done',
        '--summary',
        `scn: toolchain registered (${add.code})`,
      ]);
      return {
        exitCode: add.code === 0 && done.code === 0 ? 0 : 1,
        finalText: `scn: toolchain ${add.code}/${done.code}`,
      };
    }
    if (brief.devops && part(token, 'access') !== undefined) {
      // what access the shift was really given (the server's switches narrowed by the local limit)
      note(`scn: access ${JSON.stringify((brief.devops as { access?: unknown }).access ?? null)}`);
      await aomIn(input, ['devops-done', '--summary', 'scn: access reported']);
      return { finalText: 'scn: access reported' };
    }
    if (brief.devops && part(token, 'switchblock') !== undefined) return this.switchBlock(brief, input, note);
    if (brief.devops && part(token, 'guard') !== undefined)
      return this.guardProbes(brief, input, token, note);
    if (brief.devops && part(token, 'movebranch') !== undefined)
      return this.moveBranch(brief, input, token, note);
    const a2 = part(token, 'a2');
    if (brief.devops && a2) return this.ceoOverride(brief, input, a2, note);
    if (part(token, 'stubs') !== undefined) return this.architectWithStubs(brief, input, note);
    if (part(token, 'a8') !== undefined) return this.builderAfterStubCommit(brief, input, note);
    return { exitCode: 1, finalText: `scn: unknown token ${token}` };
  }

  private async architectWithStubs(
    brief: Brief,
    input: ShiftStartInput,
    note: (t: string) => void,
  ): Promise<ScriptResult> {
    // what Claude's sandbox leaves in a writable worktree: empty files (and empty dirs) for the names it protects
    for (const p of PLACEHOLDERS) {
      const full = join(input.cwd, p);
      if (existsSync(full)) continue;
      writeFileSync(full, '');
    }
    const path = brief.investigation?.reportPath ?? `docs/investigations/${brief.card?.ref}.md`;
    mkdirSync(join(input.cwd, dirname(path)), { recursive: true });
    writeFileSync(
      join(input.cwd, path),
      `# ${brief.card?.ref}\n\n## Findings\nScripted findings.\n\n## Design\nScripted design.\n`,
    );
    note(`scn: architect wrote ${PLACEHOLDERS.length} stubs and ${path}`);
    const verb = brief.shift?.outcomes.some((o) => o.id === 'report') ? 'investigate' : 'design';
    const r = await aomIn(input, [
      verb,
      '--report',
      path,
      '--summary',
      `Scripted ${verb} summary for ${brief.card?.ref}.`,
    ]);
    return {
      exitCode: r.code === 0 ? 0 : 1,
      finalText: `scn: ${verb} -> ${r.code} ${(r.err || r.out).trim().slice(0, 200)}`,
    };
  }

  /**
   * uat-runner-fixes-3 finding 4 (f6179b8 shape): the card branch already carries a commit of the sandbox's empty `.idea` and
   * `.vscode`; in this shift the sandbox took them away again (they are gone from the worktree) and nothing else changed.
   * The leftovers commit would restore an earlier tree (tree_revert) unless the stubs are left out of it.
   */
  private async builderAfterStubCommit(
    brief: Brief,
    input: ShiftStartInput,
    note: (t: string) => void,
  ): Promise<ScriptResult> {
    const git = (args: string[]) =>
      new Promise<number>((resolve) => {
        const c = spawn('git', args, { cwd: input.cwd, env: input.env });
        c.once('error', () => resolve(1));
        c.once('close', (code) => resolve(code ?? 1));
      });
    for (const p of ['.idea', '.vscode']) writeFileSync(join(input.cwd, p), '');
    await git(['add', '-A']);
    await git(['commit', '--no-verify', '-m', 'Add editor placeholders']);
    for (const p of ['.idea', '.vscode']) rmSync(join(input.cwd, p), { force: true, recursive: true });
    note('scn: stubs committed on the card branch, then removed from the worktree (what the sandbox did)');
    const r = await aomIn(input, ['handoff', '--note', `scn: ${brief.card?.ref} built`]);
    return {
      exitCode: r.code === 0 ? 0 : 1,
      finalText: `scn: handoff -> ${r.code} ${(r.err || r.out).trim().slice(0, 200)}`,
    };
  }

  /**
   * The CEO override of request f1478c16 (uat-runner-fixes-3 finding 2): Forge first refuses and asks for approval; once
   * the owner approved, it writes and commits in the card worktree `path`, with real (non-empty) `.env` and `node_modules`
   * files, and reports. The runner must refuse the report, put the worktree back and keep the work under refs/guildwise/refused.
   */
  private async ceoOverride(
    brief: Brief & { devops?: { summary: string; approval?: unknown } },
    input: ShiftStartInput,
    path: string,
    note: (t: string) => void,
  ): Promise<ScriptResult> {
    if (!brief.devops?.approval) {
      const r = await aomIn(input, [
        'devops-approval',
        '--action',
        'run the dependency add in the card worktree of GIT-1',
        '--reason',
        'the CEO asked me to, and said not to reply that worktrees are not mine',
        '--command',
        'edit package.json in the card worktree',
      ]);
      // quiet-approvals R1: inside the box there is no approval report, leaving the box is one local yes (devops-outside)
      if (r.code !== 0 && /devops-outside/.test(r.err + r.out)) {
        const ask = await aomIn(input, [
          'devops-outside',
          '--needs',
          'a write in the card worktree',
          '--why',
          'the CEO asked me to add the dependency in the card worktree',
        ]);
        note(`scn: asked to work outside the box -> ${ask.code}`);
        return { exitCode: 0, finalText: 'scn: asked for the outside' };
      }
      note(`scn: asked for approval -> ${r.code}`);
      return { exitCode: 0, finalText: `scn: approval asked (${r.code})` };
    }
    const run = (cmd: string, args: string[]) =>
      new Promise<number>((resolve) => {
        const c = spawn(cmd, args, { cwd: path, env: input.env });
        c.once('error', () => resolve(1));
        c.once('close', (code) => resolve(code ?? 1));
      });
    writeFileSync(join(path, 'package.json'), '{"name":"toy","dependencies":{"left-pad":"1.3.0"}}\n');
    writeFileSync(join(path, 'package-lock.json'), '{"lockfileVersion":3}\n');
    await run('git', ['add', '-A']);
    await run('git', [
      '-c',
      'user.name=Forge',
      '-c',
      'user.email=forge@e2e.test',
      'commit',
      '--no-verify',
      '-m',
      'Add left-pad (DevOps)',
    ]);
    // non-empty, so the runner cannot dismiss them as sandbox stub noise
    writeFileSync(join(path, '.env'), 'SECRET_TOKEN=not-a-real-secret\n');
    mkdirSync(join(path, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(path, 'node_modules', 'left-pad', 'index.js'), 'module.exports = () => 1;\n');
    writeFileSync(join(path, 'stray.txt'), 'uncommitted\n');
    const first = await aomIn(input, [
      'devops-done',
      '--summary',
      'scn: installed left-pad in the card worktree',
    ]);
    const again =
      first.code === 0
        ? first
        : await aomIn(input, ['devops-done', '--summary', 'scn: refused, the card worktree is not mine']);
    note(`scn: first=${first.code} again=${again.code}`);
    return { exitCode: 0, finalText: `scn: first=${first.code} again=${again.code}` };
  }

  /**
   * runner-authority-fixes T10/T2/T9 (C12): the DevOps command guard, driven through the REAL hook command (`aom devops-guard`:
   * hook JSON on stdin, the classifier, the audit call to the runner over IPC). The guard configuration is assembled here the way
   * ClaudeCodeAdapter.devopsGuard does (access switches from the brief, the card worktrees folder, the policy folder), because the
   * mock runtime has no Claude to attach the hook to. Results (one line per command) go to `<gate dir>/guard-<name>.json`.
   * Tokens: `guard;path=<card worktree>[;on]` (`on` turns the install and Docker switches on in the config).
   */
  private async guardProbes(
    brief: Brief & {
      devops?: {
        summary: string;
        access?: { allowInstall: boolean; allowDocker: boolean; allowedPaths: string[] };
      };
    },
    input: ShiftStartInput,
    token: string,
    note: (t: string) => void,
  ): Promise<ScriptResult> {
    const wt = part(token, 'path') as string;
    const on = part(token, 'on') !== undefined;
    const access = {
      allowInstall: on || brief.devops?.access?.allowInstall === true,
      allowDocker: on || brief.devops?.access?.allowDocker === true,
      allowedPaths: brief.devops?.access?.allowedPaths ?? [],
    };
    const root = this.runnerRoot;
    const policyRoot = process.env.AOM_RUNNER_POLICY_DIR as string;
    const cfg = {
      sessionRef: `combined-${on ? 'on' : 'off'}`,
      kind: 'shift',
      deleteRoots: [join(root, 'worktrees'), join(root, 'agents'), '/tmp'],
      home: process.env.HOME,
      protectedBranches: [],
      approvedCommands: [],
      shiftKind: 'devops',
      frozenBranches: [],
      cardWorktreesRoot: join(root, 'worktrees'),
      installScriptsOff: true,
      policyRoot,
      access,
      writeRoots: [input.sandbox.home, input.sandbox.scratch, input.sandbox.tmp, '/tmp'],
      secretRoots: ['secrets', 'keys', 'config.json'].map((d) => join(root, d)),
      auditFile: join(root, 'logs', 'devops-audit.jsonl'),
    };
    const cfgFile = join(this.gateDir, `guard-config-${on ? 'on' : 'off'}.json`);
    writeFileSync(cfgFile, JSON.stringify(cfg));
    const probes = [
      'pipx install yt-dlp',
      'docker run --rm alpine true',
      'touch /etc/combined-probe',
      `cat ${policyRoot}/policy.json`,
      'guildwise-runner approve abc123',
      `git -C ${wt} commit --allow-empty -m probe`,
      'ls',
    ];
    const results: Array<{
      command: string;
      decision: 'allowed' | 'denied';
      rule: string | null;
      reason: string;
    }> = [];
    const [bin, ...pre] = selfCommand('aom') as [string, ...string[]];
    for (const command of probes) {
      const out = await new Promise<string>((resolve) => {
        const c = spawn(bin, [...pre, 'devops-guard'], {
          cwd: input.cwd,
          env: { ...input.env, AOM_DEVOPS_GUARD: cfgFile },
        });
        let o = '';
        c.stdout.on('data', (d: Buffer) => {
          o += d.toString();
        });
        c.once('error', () => resolve(o));
        c.once('close', () => resolve(o));
        c.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: input.cwd }));
      });
      const reason = /"permissionDecisionReason":"([^"]*)"/.exec(out)?.[1] ?? '';
      const rule = /Refused by the DevOps guard \(([a-z_]+)\)/.exec(reason)?.[1] ?? null;
      results.push({ command, decision: out.includes('"deny"') ? 'denied' : 'allowed', rule, reason });
    }
    writeFileSync(join(this.gateDir, `guard-${on ? 'on' : 'off'}.json`), JSON.stringify(results, null, 1));
    note(
      `scn: guard probes ${on ? 'with' : 'without'} the switches: ${results.map((r) => `${r.rule ?? r.decision}`).join(',')}`,
    );
    await aomIn(input, ['devops-done', '--summary', 'scn: guard probes done']);
    return { finalText: 'scn: guard probes done' };
  }

  /**
   * runner-authority-fixes T7 (C9): a DevOps shift that moves a CARD branch (update-ref in the clone, no worktree command): the
   * runner puts it back and keeps the work. Tokens: `movebranch;path=<card worktree>;clone=<the clone>`.
   */
  private async moveBranch(
    _brief: Brief,
    input: ShiftStartInput,
    token: string,
    note: (t: string) => void,
  ): Promise<ScriptResult> {
    const wt = part(token, 'path') as string;
    const clone = part(token, 'clone') as string;
    const git = (cwd: string, ...args: string[]) =>
      new Promise<string>((resolve) => {
        const c = spawn('git', ['-C', cwd, ...args], { env: input.env });
        let o = '';
        c.stdout.on('data', (d: Buffer) => {
          o += d.toString();
        });
        c.once('error', () => resolve(''));
        c.once('close', () => resolve(o.trim()));
      });
    const branch = await git(wt, 'rev-parse', '--abbrev-ref', 'HEAD');
    const target = await git(clone, 'rev-parse', 'main');
    await git(clone, 'update-ref', `refs/heads/${branch}`, target);
    note(`scn: moved ${branch} to ${target.slice(0, 7)} in the clone`);
    const first = await aomIn(input, ['devops-done', '--summary', `scn: moved the card branch ${branch}`]);
    if (first.code !== 0)
      await aomIn(input, ['devops-done', '--summary', 'scn: refused, the card branch is not mine']);
    note(`scn: first report ${first.code}`);
    return { finalText: `scn: first=${first.code}` };
  }

  /**
   * What a real DevOps engineer does when a switch is off (T10): the command is refused by the guard hook (the runner records the
   * refusal), then it asks with `aom devops-approval --switch install`, which the runner checks against that recorded refusal
   * before the owner sees it. Only then does the server treat the request as "waiting for the switch".
   */
  private async switchBlock(
    brief: Brief & {
      devops?: { access?: { allowInstall: boolean; allowDocker: boolean; allowedPaths: string[] } };
    },
    input: ShiftStartInput,
    note: (t: string) => void,
  ): Promise<ScriptResult> {
    const approved = (brief.devops as { approval?: unknown } | undefined)?.approval;
    const access = brief.devops?.access ?? { allowInstall: false, allowDocker: false, allowedPaths: [] };
    if (approved || access.allowInstall) {
      // the switch is on (or the owner approved): the same work now just happens
      await aomIn(input, ['devops-done', '--summary', 'scn: installed the tools']);
      return { finalText: 'scn: done' };
    }
    const root = this.runnerRoot;
    const cfgFile = join(this.gateDir, 'guard-config-switch.json');
    writeFileSync(
      cfgFile,
      JSON.stringify({
        sessionRef: 'combined-switch',
        kind: 'shift',
        deleteRoots: [join(root, 'worktrees'), '/tmp'],
        home: process.env.HOME,
        protectedBranches: [],
        approvedCommands: [],
        shiftKind: 'devops',
        frozenBranches: [],
        cardWorktreesRoot: join(root, 'worktrees'),
        policyRoot: process.env.AOM_RUNNER_POLICY_DIR,
        access,
        writeRoots: [input.sandbox.home, input.sandbox.scratch, input.sandbox.tmp, '/tmp'],
        secretRoots: ['secrets', 'keys', 'config.json'].map((d) => join(root, d)),
        auditFile: join(root, 'logs', 'devops-audit.jsonl'),
      }),
    );
    const command = 'pipx install yt-dlp';
    const [bin, ...pre] = selfCommand('aom') as [string, ...string[]];
    const out = await new Promise<string>((resolve) => {
      const c = spawn(bin, [...pre, 'devops-guard'], {
        cwd: input.cwd,
        env: { ...input.env, AOM_DEVOPS_GUARD: cfgFile },
      });
      let o = '';
      c.stdout.on('data', (d: Buffer) => {
        o += d.toString();
      });
      c.once('error', () => resolve(o));
      c.once('close', () => resolve(o));
      c.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: input.cwd }));
    });
    note(
      `scn: the guard said ${out.includes('install_off') ? 'install_off' : out.slice(0, 80) || 'allowed'}`,
    );
    const r = await aomIn(input, [
      'devops-approval',
      '--switch',
      'install',
      '--action',
      command,
      '--reason',
      'installs are off on this computer',
      '--command',
      command,
    ]);
    if (r.code !== 0 && /devops-outside/.test(r.err + r.out)) {
      // inside the box there is no approval report: the owner is asked once to run the request outside, where the guard applies
      const ask = await aomIn(input, [
        'devops-outside',
        '--needs',
        'installing a tool',
        '--why',
        'the request needs pipx install',
      ]);
      note(`scn: asked to work outside the box -> ${ask.code}`);
      return { exitCode: 0, finalText: 'scn: asked for the outside' };
    }
    note(`scn: asked with --switch install -> ${r.code}`);
    return { finalText: `scn: asked (${r.code})` };
  }
}

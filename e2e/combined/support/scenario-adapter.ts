import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  constructor(
    cfg: ConstructorParameters<typeof MockAdapter>[0],
    paths: ConstructorParameters<typeof MockAdapter>[1],
    private readonly gateDir: string,
  ) {
    super(cfg, paths);
  }

  override async start(input: ShiftStartInput): Promise<RuntimeSession> {
    const brief = await briefOf(input);
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
      // Forge registers the user-level toolchain it "installed" (aom toolchain add), then reports
      const add = await aomIn(input, ['toolchain', 'add', 'stubnode', '--bin', tool]);
      note(`scn: toolchain add -> ${add.code} ${(add.err || add.out).trim().slice(0, 160)}`);
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
}

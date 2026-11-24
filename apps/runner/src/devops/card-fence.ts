import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { GuardViolation } from '@aom/shared';
import { excludeStubs, sandboxStubNoise, statusLinesWithoutStubs } from '../adapters/sandbox-placeholders.ts';
import { currentBranch, git } from '../git/git.ts';

/**
 * uat-runner-fixes-3 finding 2 (security): the DevOps engineer runs outside the sandbox, so no mount keeps it out of the
 * card worktrees. The runner therefore checks them itself: it records every card worktree (branch, commit, uncommitted
 * files) when a DevOps shift starts and compares at the report and at the shift end. Whatever the DevOps shift changed
 * there is refused and reverted, whatever the request, a prompt or an approval said: its commits are kept under
 * `refs/guildwise/refused/...` and its files in a stash entry (nothing is lost, nothing stays on the card branch).
 *
 * The one exception is the server's own conflict request (G-Q2, `devops.conflictCard`, never request text): that card's
 * branch may move FORWARD to the resolution (a fast-forward, worktree clean). A worktree another shift used meanwhile is
 * not judged (the change cannot be told apart); the guard hook's refusal still applies there.
 */

export interface CardWorktreeState {
  branch: string | null;
  head: string | null;
  /** Porcelain status lines without the sandbox placeholders. */
  dirty: string[];
  /**
   * The tree of every file git does not ignore, as it is on disk (a temporary index, placeholders left out): a further
   * edit to a file that was already dirty changes it although its status line stays the same (REVIEW S1).
   */
  content: string | null;
  /** Ignored entries (`git status --ignored`, folders collapsed) with their modification time: node_modules, .env ... */
  ignored: Record<string, number>;
}

/** The runner's identity for the evidence it keeps (a local stash entry, never pushed): works without a Commit as. */
const FENCE_IDENTITY = {
  GIT_AUTHOR_NAME: 'Guildwise runner',
  GIT_AUTHOR_EMAIL: 'runner@guildwise.invalid',
  GIT_COMMITTER_NAME: 'Guildwise runner',
  GIT_COMMITTER_EMAIL: 'runner@guildwise.invalid',
};

async function contentKey(path: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), 'aom-fence-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    const idx = await git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const real = idx.stdout.trim();
    if (idx.exitCode === 0 && real && existsSync(real)) await copyFile(real, env.GIT_INDEX_FILE);
    const stubs = excludeStubs(await sandboxStubNoise(path));
    if ((await git(path, ['add', '-A', '--', '.', ...stubs], { env })).exitCode !== 0) return null;
    const t = await git(path, ['write-tree'], { env });
    return t.exitCode === 0 ? t.stdout.trim() : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ignoredEntries(path: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const r = await git(path, ['status', '--porcelain', '--ignored=traditional', '-z']);
  if (r.exitCode !== 0) return out;
  for (const e of r.stdout.split('\0')) {
    if (!e.startsWith('!! ')) continue;
    const name = e.slice(3);
    try {
      out[name] = statSync(join(path, name)).mtimeMs;
    } catch {
      out[name] = -1;
    }
  }
  return out;
}

export type CardWorktreeSnapshot = Map<string, CardWorktreeState>;

/** The card worktrees: `<root>/<KEY>-<project>/<REF>` folders that are git worktrees. */
export function listCardWorktrees(root: string): string[] {
  const out: string[] = [];
  let projects: string[] = [];
  try {
    projects = readdirSync(root);
  } catch {
    return out;
  }
  for (const p of projects) {
    let cards: string[] = [];
    try {
      cards = readdirSync(join(root, p));
    } catch {
      continue;
    }
    for (const c of cards) if (existsSync(join(root, p, c, '.git'))) out.push(join(root, p, c));
  }
  return out.sort();
}

async function stateOf(path: string): Promise<CardWorktreeState> {
  const head = await git(path, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  const status = await statusLinesWithoutStubs(path);
  return {
    branch: await currentBranch(path),
    head: head.exitCode === 0 ? head.stdout.trim() : null,
    dirty: status.ok ? status.lines.map((l) => l.trimEnd()) : ['(status failed)'],
    content: await contentKey(path),
    ignored: await ignoredEntries(path),
  };
}

export async function snapshotCardWorktrees(root: string): Promise<CardWorktreeSnapshot> {
  const snap: CardWorktreeSnapshot = new Map();
  for (const p of listCardWorktrees(root)) snap.set(p, await stateOf(p));
  return snap;
}

/** Ignored entries that are new or were modified (node_modules after an install, a new .env). */
const ignoredWrites = (a: CardWorktreeState, b: CardWorktreeState): string[] =>
  Object.keys(b.ignored).filter((k) => a.ignored[k] !== b.ignored[k]);

const sameTracked = (a: CardWorktreeState, b: CardWorktreeState): boolean =>
  a.branch === b.branch &&
  a.head === b.head &&
  a.dirty.join('\n') === b.dirty.join('\n') &&
  a.content === b.content;

export interface FenceInput {
  root: string;
  before: CardWorktreeSnapshot;
  shiftId: string;
  /** The server's conflict request: this card branch may be fast-forwarded. */
  conflictBranch?: string;
  /** Did another shift work in this worktree since the DevOps shift started? */
  usedByOthers: (path: string) => boolean;
}

export interface FenceFinding {
  path: string;
  /** What changed, in plain words. */
  changed: string;
  reverted: boolean;
  /** Where the refused work is kept. */
  keptAt: string[];
}

/**
 * Compares the card worktrees with the snapshot and reverts what the DevOps shift changed. Returns one finding per
 * worktree it changed (empty: nothing to refuse). Never throws.
 */
export async function enforceCardFence(o: FenceInput): Promise<FenceFinding[]> {
  const out: FenceFinding[] = [];
  const short = o.shiftId.slice(0, 8);
  for (const path of listCardWorktrees(o.root)) {
    try {
      const before = o.before.get(path);
      const now = await stateOf(path);
      if (!before) {
        // a worktree DevOps made in the card folder (a card's own worktree appears only through a card shift)
        if (!o.usedByOthers(path))
          out.push({
            path,
            changed: 'a new worktree in the card worktrees folder',
            reverted: false,
            keptAt: [],
          });
        continue;
      }
      if (o.usedByOthers(path)) continue;
      // git ignores them: new ones are certainly the shift's (nobody else used the worktree) and are removed; ones that
      // existed and were modified cannot be put back and may hold someone's state, so they are reported (REVIEW R2-S2)
      const ignored = await settleIgnored(path, before, now);
      if (sameTracked(before, now)) {
        if (ignored.text)
          out.push({ path, changed: ignored.text, reverted: ignored.allReverted, keptAt: [] });
        continue;
      }
      if (
        o.conflictBranch &&
        before.branch === o.conflictBranch &&
        now.branch === before.branch &&
        now.dirty.length === 0 &&
        before.head &&
        now.head &&
        (await git(path, ['merge-base', '--is-ancestor', before.head, now.head])).exitCode === 0
      )
        continue;
      const f = await revert(path, before, now, short);
      if (ignored.text) {
        f.changed += `; ${ignored.text}`;
        if (!ignored.allReverted) f.reverted = false;
      }
      out.push(f);
    } catch (err) {
      out.push({
        path,
        changed: `could not be checked (${err instanceof Error ? err.message : String(err)})`,
        reverted: false,
        keptAt: [],
      });
    }
  }
  return out;
}

async function revert(
  path: string,
  before: CardWorktreeState,
  now: CardWorktreeState,
  short: string,
): Promise<FenceFinding> {
  const what: string[] = [];
  if (now.head !== before.head)
    what.push(`HEAD moved from ${before.head?.slice(0, 7)} to ${now.head?.slice(0, 7)}`);
  if (now.branch !== before.branch)
    what.push(`switched from ${before.branch} to ${now.branch ?? 'a detached HEAD'}`);
  const newDirt = now.dirty.filter((l) => !before.dirty.includes(l));
  if (newDirt.length) what.push(`${newDirt.length} file(s) changed: ${newDirt.slice(0, 10).join(', ')}`);
  else if (now.content !== before.content)
    what.push('files that were already uncommitted were changed further');
  const keptAt: string[] = [];
  // the commits the shift made stay reachable, never on the card branch
  if (now.head && now.head !== before.head) {
    // the short sha keeps a second refusal in the same shift from overwriting the first (REVIEW N1)
    const ref = `${refBase(short, before.branch)}-${now.head.slice(0, 10)}`;
    if ((await git(path, ['update-ref', ref, now.head])).exitCode === 0) keptAt.push(ref);
  }
  const finding = (reverted: boolean): FenceFinding => ({ path, changed: what.join('; '), reverted, keptAt });
  if (before.dirty.length > 0) {
    // the worktree already had uncommitted work: never stash or reset files that may be someone else's. Undo only the
    // commits (the files stay as they are) when the branch is still checked out.
    if (now.branch === before.branch && before.head && now.head !== before.head) {
      const r = await git(path, ['reset', '--soft', before.head]);
      const after = await stateOf(path);
      return finding(r.exitCode === 0 && after.content === before.content);
    }
    return finding(false);
  }
  if (!before.head || !before.branch) return finding(false);
  // clean before: what the shift left uncommitted is kept as a commit under the refused ref (no refs/stash, no index
  // lock: REVIEW R2-B1), with the runner's own identity (no Commit as needed)
  let kept = now.dirty.length === 0;
  if (!kept && now.content) {
    const c = await git(
      path,
      [
        'commit-tree',
        now.content,
        '-p',
        now.head ?? before.head,
        '-m',
        `refused: uncommitted changes of DevOps shift ${short}`,
      ],
      { env: FENCE_IDENTITY },
    );
    const sha = c.stdout.trim();
    const ref = `${refBase(short, before.branch)}-wip-${sha.slice(0, 10)}`;
    if (c.exitCode === 0 && sha && (await git(path, ['update-ref', ref, sha])).exitCode === 0) {
      keptAt.push(ref);
      kept = true;
    }
  }
  if (!kept) {
    // nothing could be kept: the files stay (nothing discarded), but the commits leave the card branch all the same
    if (now.head !== before.head)
      await git(path, [
        'update-ref',
        `refs/heads/${before.branch}`,
        before.head,
        ...(now.head ? [now.head] : []),
      ]);
    return finding(false);
  }
  const co = await git(path, ['checkout', '-f', '-B', before.branch, before.head]);
  // clean before: every untracked file is the shift's (kept above); ignored files are settled separately
  if (co.exitCode === 0) await git(path, ['clean', '-fdq']);
  const after = await stateOf(path);
  return finding(co.exitCode === 0 && after.dirty.length === 0 && after.head === before.head);
}

const refBase = (short: string, branch: string | null): string =>
  `refs/guildwise/refused/${short}/${(branch ?? 'detached').replace(/[^\w.-]+/g, '-')}`;

/** New ignored entries are removed (confined to the worktree, links not followed); modified ones are reported. */
async function settleIgnored(
  path: string,
  before: CardWorktreeState,
  now: CardWorktreeState,
): Promise<{ text: string; allReverted: boolean }> {
  const changed = ignoredWrites(before, now);
  if (changed.length === 0) return { text: '', allReverted: true };
  const removed: string[] = [];
  const left: string[] = [];
  for (const name of changed) {
    const target = resolve(path, name);
    const isNew = !(name in before.ignored);
    if (isNew && target.startsWith(`${resolve(path)}/`) && !name.split('/').includes('..')) {
      try {
        rmSync(target, { recursive: true, force: true });
        removed.push(name);
        continue;
      } catch {
        /* reported below */
      }
    }
    left.push(name);
  }
  const parts: string[] = [];
  if (removed.length) parts.push(`new ignored files removed: ${removed.slice(0, 10).join(', ')}`);
  if (left.length)
    parts.push(
      `ignored files that existed before were changed: ${left.slice(0, 10).join(', ')} (not reverted: check them, for example reinstall or remove them)`,
    );
  return { text: parts.join('; '), allReverted: left.length === 0 };
}

/** The violation the shift end reports, and the text for the agent. */
export function fenceViolation(findings: FenceFinding[]): GuardViolation {
  return {
    rule: 'devops_card_worktree',
    detail: `The DevOps engineer changed a card worktree, which it never may (whoever asked, whatever was approved). The runner ${findings.every((f) => f.reverted) ? 'reverted it' : 'reverted what it could'}: ${findings
      .map(
        (f) =>
          `${f.path}: ${f.changed}${f.reverted ? ' (reverted)' : ' (NOT fully reverted: check it)'}${f.keptAt.length ? `; kept at ${f.keptAt.join(', ')}` : ''}`,
      )
      .join(' | ')
      .slice(0, 1800)}`,
  };
}

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BRANCH_MOVING_DENIED,
  buildChatSettings,
  buildDevopsBoxSettings,
  buildMentionWorkSettings,
  buildShiftSettings,
  forRunnerBox,
  GIT_ALWAYS_VERBS,
  GIT_BRANCH_VERBS,
  GIT_PUSH_DENIED,
  gitDenyForms,
  headFence,
  STASH_REMOVING_DENIED,
  shadowedWrites,
} from '../src/adapters/claude-policy.ts';
import { codexFilesystem, codexRules } from '../src/adapters/codex.ts';
import { deniedShellPrefixes } from '../src/adapters/denied-shell.ts';
import { gitWriteScope, materializeLooseRefs, refFence } from '../src/git/harden.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

/**
 * gate-fixes-1 F1 and F1b. F1: the runner-built inner box fenced Claude's shell with `blockReadsOutsideWorkingDirectories`,
 * which in Claude Code 2.1.332 turns every `cd <clone> && git ...` into a denial (gate items 7 and 8); the inner box now fences
 * only the file tools, through a launch-only key. F1b: the bare git deny rules are prefix rules (`git -C d checkout` slipped
 * past them); the wildcard forms close what a rule can name, and read-only HEAD files are the OS fence behind them.
 */
const perms = (key: string) => {
  const r = BUILTIN_ROLES.find((x) => x.key === key);
  if (!r) throw new Error(key);
  return r.permissions;
};

/** A Claude Code `Bash(...)` rule as a regular expression: `*` is any text, a trailing `:*` a prefix match. */
function ruleRe(rule: string): RegExp | null {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m?.[1]) return null;
  let p = m[1];
  const prefix = p.endsWith(':*');
  if (prefix) p = p.slice(0, -2);
  const body = p
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${prefix ? '( .*)?' : ''}$`, 's');
}
const denies = (deny: string[], command: string): boolean =>
  deny.some((r) => ruleRe(r)?.test(command) === true);

/** The design's bypass table (one example per row a rule can name). */
const BRANCH_FORMS = [
  'git checkout -b x',
  'git -C /w checkout -b x',
  'git --git-dir=/w/.git switch -c x',
  'git -c core.x=1 rebase main',
  'git --exec-path=/usr/lib/git-core checkout x',
  'git -P switch -c x',
  'git -c alias.co=checkout co -b x',
  'git --config-env=alias.co=FOO co',
  'git config --global alias.co checkout',
  'git config include.path /tmp/x',
  'GIT_DIR=/w/.git git checkout -b x',
  'env GIT_WORK_TREE=/w git switch -c x',
  'GIT_DIR=/w/.git git -c a=b checkout -b x',
  'GIT_CONFIG_KEY_0=alias.co GIT_CONFIG_VALUE_0=checkout GIT_CONFIG_COUNT=1 git co -b x',
  'GIT_CONFIG_GLOBAL=/tmp/g git status',
  '/usr/bin/git checkout -b x',
  '/usr/bin/git -C /w switch -c x',
  '/usr/lib/git-core/git-checkout -b x',
  'git symbolic-ref HEAD refs/heads/x',
  'git -C /w symbolic-ref HEAD refs/heads/x',
];
const ALWAYS_FORMS = [
  'git push origin main',
  'git -C /w push',
  'git --git-dir=/w/.git push origin',
  'GIT_DIR=/w/.git git push',
  '/usr/bin/git push',
  'git reset --hard HEAD',
  'git -C /w reset --hard HEAD',
  'GIT_DIR=/w/.git git reset --hard',
  'git stash drop',
  'git -C /w stash pop',
  '/usr/bin/git stash clear',
];
const LEGIT = [
  'git status',
  'git -C /w status',
  'git log --oneline -1',
  'git commit -m "fix the build"',
  'git -C /w log -1 --format=%s',
  'git branch --show-current',
  'git stash list',
  'git stash',
  'git stash apply',
  'git diff HEAD',
  'git add -A',
  'git merge --ff-only main',
];

describe('F1b: the wildcard git deny forms', () => {
  it('every table row is denied by the forms, the legitimate commands are not', () => {
    const deny = [
      ...GIT_PUSH_DENIED,
      'Bash(git reset --hard:*)',
      ...STASH_REMOVING_DENIED,
      ...BRANCH_MOVING_DENIED,
      ...gitDenyForms([...GIT_ALWAYS_VERBS, ...GIT_BRANCH_VERBS]),
    ];
    for (const c of [...BRANCH_FORMS, ...ALWAYS_FORMS]) expect(denies(deny, c), c).toBe(true);
    for (const c of LEGIT) expect(denies(deny, c), c).toBe(false);
  });

  it('the bare constants alone miss the option forms (why the forms exist)', () => {
    const bare = ['Bash(git push:*)', 'Bash(git reset --hard:*)', ...BRANCH_MOVING_DENIED];
    expect(denies(bare, 'git -C /w checkout -b x')).toBe(false);
    expect(denies(bare, 'git --git-dir=/w/.git push origin')).toBe(false);
    expect(denies(bare, 'git -C /w symbolic-ref HEAD refs/heads/x')).toBe(false);
  });

  it('reviewer, tester and a mention get every form; the builder only push, reset --hard and stash', () => {
    for (const key of ['reviewer', 'tester']) {
      const deny = buildShiftSettings(perms(key), policyCtx(), POLICY_PATHS, key).permissions.deny;
      for (const c of [...BRANCH_FORMS, ...ALWAYS_FORMS]) expect(denies(deny, c), `${key}: ${c}`).toBe(true);
    }
    const mention = buildMentionWorkSettings(perms('builder'), policyCtx(), POLICY_PATHS).permissions.deny;
    for (const c of [...BRANCH_FORMS, ...ALWAYS_FORMS])
      expect(denies(mention, c), `mention: ${c}`).toBe(true);
    const chat = buildChatSettings(true, [], policyCtx(), POLICY_PATHS).permissions.deny;
    for (const c of [...BRANCH_FORMS, ...ALWAYS_FORMS]) expect(denies(chat, c), `chat: ${c}`).toBe(true);
    const builder = buildShiftSettings(perms('builder'), policyCtx(), POLICY_PATHS, 'builder').permissions
      .deny;
    for (const c of ALWAYS_FORMS) expect(denies(builder, c), `builder: ${c}`).toBe(true);
    expect(denies(builder, 'git -C /w checkout -b x')).toBe(false);
    expect(denies(builder, 'git rebase main')).toBe(false);
  });

  it('the inner DevOps box creates its conflict branch: no branch denies, push and reset --hard still denied', () => {
    const deny = buildDevopsBoxSettings(
      perms('devops'),
      policyCtx({ cwd: '/data/agents/a1/devops/r1' }),
      POLICY_PATHS,
    ).permissions.deny;
    for (const r of BRANCH_MOVING_DENIED) expect(deny).not.toContain(r);
    expect(denies(deny, 'git checkout -b conflict/x-a1')).toBe(false);
    expect(denies(deny, 'git -C /c switch -c conflict/x-a1')).toBe(false);
    for (const c of ALWAYS_FORMS) expect(denies(deny, c), c).toBe(true);
  });

  it('Codex and the denied-shell list are unchanged (cfbc8864 output)', () => {
    const want: Record<string, [string[], string]> = {
      builder: [
        ['git push', 'git reset --hard', 'git stash drop', 'git stash pop', 'git stash clear', 'sudo'],
        '0a4416f362b4d61e8dc19043ff56ae84d6418791498fb055eb3048bee518409b',
      ],
      reviewer: [
        [
          'git push',
          'git reset --hard',
          'git stash drop',
          'git stash pop',
          'git stash clear',
          'git rebase',
          'git checkout',
          'git switch',
          'sudo',
          'git commit',
          'git add',
        ],
        '53504fc0dda4e73796439a706ba34749f3f5259b55b86638a9bde37f5c9f1d09',
      ],
      tester: [
        [
          'git push',
          'git reset --hard',
          'git stash drop',
          'git stash pop',
          'git stash clear',
          'git rebase',
          'git checkout',
          'git switch',
          'sudo',
        ],
        '8c76d18f444c76c8895d0b7bc33e3caa732e05ec88acbb5af79a130dcdd14a8c',
      ],
    };
    for (const [key, [prefixes, hash]] of Object.entries(want)) {
      expect(deniedShellPrefixes(perms(key), key)).toEqual(prefixes);
      expect(
        createHash('sha256')
          .update(codexRules(perms(key), key))
          .digest('hex'),
      ).toBe(hash);
    }
  });
});

describe('F1b: read-only HEAD files (the OS fence)', () => {
  const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.aom-head-fence-')));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.test',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.test',
  };
  const repo = join(root, 'repo');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { env });
  writeFileSync(join(repo, 'a'), 'a\n');
  spawnSync('git', ['-C', repo, 'add', '-A'], { env });
  spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'a'], { env });
  const card = join(root, 'card');
  spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'card', card], { env });
  const common = join(repo, '.git');
  const admin = join(common, 'worktrees', 'card');

  it('the main HEAD for every role; the card HEAD for every role but the builder; a plain clone: none', () => {
    expect(headFence(card, true)).toEqual([join(common, 'HEAD')]);
    expect(headFence(card, false)).toEqual([join(common, 'HEAD'), join(admin, 'HEAD')]);
    expect(headFence(repo, false)).toEqual([]);
    const fs = (key: string) =>
      buildShiftSettings(perms(key), policyCtx({ cwd: card, gitDirs: [common] }), POLICY_PATHS, key).sandbox
        ?.filesystem;
    expect(fs('builder')?.denyWrite).toContain(join(common, 'HEAD'));
    expect(fs('builder')?.denyWrite).not.toContain(join(admin, 'HEAD'));
    for (const key of ['reviewer', 'tester']) {
      expect(fs(key)?.denyWrite).toContain(join(common, 'HEAD'));
      expect(fs(key)?.denyWrite).toContain(join(admin, 'HEAD'));
    }
    const mention = buildMentionWorkSettings(
      perms('builder'),
      policyCtx({ cwd: card, gitDirs: [common] }),
      POLICY_PATHS,
    ).sandbox?.filesystem;
    expect(mention?.denyWrite).toEqual(expect.arrayContaining([join(common, 'HEAD'), join(admin, 'HEAD')]));
    // gate-fixes-2 B1: only the card's own admin dir, objects, refs and logs are writable (commits still work there,
    // the Codex and harness box set); the rest of the git dir (packed-refs, info/, shallow, the main index) is not
    expect(mention?.allowWrite).toEqual(
      expect.arrayContaining([admin, join(common, 'objects'), join(common, 'refs'), join(common, 'logs')]),
    );
    expect(mention?.allowWrite).not.toContain(common);
    expect(mention?.denyWrite).not.toContain(common);
    expect(mention?.denyWrite).not.toContain(admin);
  });
});

describe('F1: the settings of a runner-built box', () => {
  const s = () =>
    buildDevopsBoxSettings(perms('devops'), policyCtx({ cwd: '/data/agents/a1/devops/r1' }), POLICY_PATHS);

  it('inner: no shell-binding read block, no Claude sandbox; the file-tool block goes to the launch file', () => {
    const base = s();
    expect(base.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    const r = forRunnerBox(base, 'inner');
    expect(r.settings.permissions.blockReadsOutsideWorkingDirectories).toBeUndefined();
    expect(r.settings.sandbox).toBeUndefined();
    expect(r.launch).toEqual({ permissions: { blockFileToolReadsOutsideWorkingDirectories: true } });
    // everything else is unchanged, and the input is not mutated
    expect(r.settings.permissions.deny).toEqual(base.permissions.deny);
    expect(r.settings.permissions.allow).toEqual(base.permissions.allow);
    expect(r.settings.permissions.additionalDirectories).toEqual(base.permissions.additionalDirectories);
    expect(base.sandbox).toBeDefined();
  });

  it('outer: only the Claude sandbox goes, no launch file', () => {
    const base = buildShiftSettings(perms('devops'), policyCtx(), POLICY_PATHS, 'devops', true);
    const r = forRunnerBox(base, 'outer');
    expect(r.launch).toBeUndefined();
    expect(r.settings.sandbox).toBeUndefined();
    expect(r.settings.permissions).toEqual(base.permissions);
  });
});

describe('F4: shadowedWrites', () => {
  it('a deny equal to an allow is reported; a denied working folder alone is not', () => {
    expect(shadowedWrites({ allowWrite: ['/r/.git'], denyWrite: ['/r/.git'] }, '/w')).toEqual(['/r/.git']);
    expect(shadowedWrites({ allowWrite: ['/r/.git'], denyWrite: ['/r'] }, '/w')).toEqual(['/r']);
    expect(shadowedWrites({ allowWrite: ['/h'], denyWrite: ['/w'] }, '/w')).toEqual([]);
    expect(shadowedWrites({ allowWrite: ['/r/.git'], denyWrite: ['/r/.git/HEAD'] }, '/w')).toEqual([]);
  });
});

describe('gate-fixes-2 S7/B1: the ref fence and the narrow git write scope for every writer', () => {
  const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.aom-ref-fence-')));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.test',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.test',
  };
  const g = (cwd: string, ...a: string[]) => spawnSync('git', ['-C', cwd, ...a], { env, encoding: 'utf8' });
  const repo = join(root, 'repo');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { env });
  writeFileSync(join(repo, 'a'), 'a\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'a');
  g(repo, 'tag', 'v1');
  g(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  g(repo, 'branch', 'aom/toy-2-other');
  g(repo, 'pack-refs', '--all');
  const card = join(root, 'card');
  g(repo, 'worktree', 'add', '-q', '-b', 'aom/toy-1-x', card);
  const common = join(repo, '.git');
  const admin = join(common, 'worktrees', 'card');

  it('loose files for packed-only branches and an empty refs/replace exist before a writer starts', () => {
    const tips = Object.fromEntries(
      g(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/')
        .stdout.trim()
        .split('\n')
        .map((l) => l.split(' ')),
    );
    materializeLooseRefs(common, tips);
    expect(existsSync(join(common, 'refs', 'heads', 'main'))).toBe(true);
    expect(existsSync(join(common, 'refs', 'heads', 'aom', 'toy-2-other'))).toBe(true);
    expect(existsSync(join(common, 'refs', 'replace'))).toBe(true);
    expect(g(repo, 'rev-parse', 'main').stdout.trim()).toBe(tips['refs/heads/main']);
  });

  it('the fence: packed-refs, remotes, tags, replace, other branches; never the own branch', () => {
    const fence = refFence(card);
    for (const p of [
      join(common, 'packed-refs'),
      join(common, 'refs', 'remotes'),
      join(common, 'refs', 'tags'),
      join(common, 'refs', 'replace'),
      join(common, 'refs', 'heads', 'main'),
      join(common, 'refs', 'heads', 'aom', 'toy-2-other'),
    ])
      expect(fence).toContain(p);
    expect(fence).not.toContain(join(common, 'refs', 'heads', 'aom', 'toy-1-x'));
    expect(fence).not.toContain(join(common, 'refs', 'heads', 'aom'));
    expect(gitWriteScope(card, [common])).toEqual([
      admin,
      join(common, 'objects'),
      join(common, 'refs'),
      join(common, 'logs'),
    ]);
  });

  it('Claude: the narrow write scope and the fence for a committing role; no git writes for a read-only role', () => {
    const fs = (key: string) =>
      buildShiftSettings(perms(key), policyCtx({ cwd: card, gitDirs: [common] }), POLICY_PATHS, key).sandbox
        ?.filesystem;
    const b = fs('builder');
    expect(b?.allowWrite).toEqual(expect.arrayContaining(gitWriteScope(card, [common])));
    expect(b?.allowWrite).not.toContain(common);
    expect(b?.denyWrite).toEqual(expect.arrayContaining(refFence(card)));
    expect(shadowedWrites(b ?? { allowWrite: [], denyWrite: [] }, card)).toEqual([]);
    const r = fs('reviewer');
    expect((r?.allowWrite ?? []).filter((p) => p.startsWith(common))).toEqual([]);
    // the work mention gets the same
    const m = buildMentionWorkSettings(
      perms('builder'),
      policyCtx({ cwd: card, gitDirs: [common] }),
      POLICY_PATHS,
    ).sandbox?.filesystem;
    expect(m?.denyWrite).toEqual(expect.arrayContaining(refFence(card)));
  });

  it('Codex: the fence is read-only inside the writable refs', () => {
    const fs = codexFilesystem({
      cwd: card,
      readOnlyCwd: false,
      sandbox: { home: '/r/a/home', scratch: '/r/a/scratch', tmp: '/tmp/aom-x', cacheRoot: '/r/cache' },
      gitDirs: [common],
      mayCommit: true,
      readDirs: [],
      addDirs: [],
      toolchainReadPaths: [],
      aomReadPaths: [],
      codexReadPaths: [],
    } as unknown as Parameters<typeof codexFilesystem>[0]);
    expect(fs[join(common, 'refs')]).toBe('write');
    for (const p of refFence(card)) expect(fs[p], p).toBe('read');
  });

  it('update-ref and pack-refs are denied to every Claude role, in their written forms', () => {
    expect(GIT_ALWAYS_VERBS).toEqual(expect.arrayContaining(['update-ref', 'pack-refs']));
  });
});

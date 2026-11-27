import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTOCOMMIT_MAX_DELETED_FILES,
  autoCommit,
  autoCommitRefusedNote,
  describeRefusal,
  uncommittedFiles,
  unreportedWorkNote,
} from '../src/shifts/autocommit.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';

const calls: { args: string[]; env?: Record<string, string> }[] = [];
vi.mock('../src/git/git.ts', async (orig) => {
  const real = await orig<typeof import('../src/git/git.ts')>();
  return {
    ...real,
    git: (cwd: string, args: string[], opts?: { env?: Record<string, string> }) => {
      calls.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
      return real.git(cwd, args, opts);
    },
  };
});

cleanupTmp();

const env = {
  GIT_AUTHOR_NAME: 'a',
  GIT_AUTHOR_EMAIL: 'a@x.test',
  GIT_COMMITTER_NAME: 'a',
  GIT_COMMITTER_EMAIL: 'a@x.test',
};

/** A repo with `n` tracked files f0..f(n-1) (and a README), committed once. */
function repo(n: number): string {
  const dir = join(tmp(), 'r');
  mkdirSync(dir, { recursive: true });
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.name', 'a']);
  sh(dir, 'git', ['config', 'user.email', 'a@x.test']);
  writeFileSync(join(dir, 'README.md'), '# r\n');
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `f${i}.txt`), `file ${i}\n`);
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-qm', 'initial']);
  return dir;
}
const rm = (dir: string, from: number, count: number) => {
  for (let i = from; i < from + count; i++) sh(dir, 'rm', [`f${i}.txt`]);
};
const head = (dir: string) => sh(dir, 'git', ['rev-parse', 'HEAD']);
const staged = (dir: string) => sh(dir, 'git', ['diff', '--cached', '--name-status']);

describe('autoCommit: normal changes', () => {
  it('commits edits, additions and a few deletions as Work in progress', async () => {
    const dir = repo(40);
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, `f${i}.txt`), 'edited\n');
    writeFileSync(join(dir, 'new1.txt'), 'n\n');
    writeFileSync(join(dir, 'new2.txt'), 'n\n');
    rm(dir, 10, 1);
    const r = await autoCommit({ worktree: dir, ticket: 'DCPL-4276', env });
    expect(r.committed).toBe(true);
    if (!r.committed) return;
    expect(r.sha).toBe(head(dir));
    expect(sh(dir, 'git', ['log', '-1', '--format=%s|%an'])).toBe('DCPL-4276: Work in progress|a');
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('commits without a ticket and reports clean when there is nothing', async () => {
    const dir = repo(3);
    expect(await autoCommit({ worktree: dir, env })).toEqual({ committed: false, skipped: 'clean' });
    writeFileSync(join(dir, 'x.txt'), 'x\n');
    expect((await autoCommit({ worktree: dir, env })).committed).toBe(true);
    expect(sh(dir, 'git', ['log', '-1', '--format=%s'])).toBe('Work in progress');
  });

  it('commits the deletion of one of the few files of a tiny repository (below the percentage floor)', async () => {
    const dir = repo(1);
    rm(dir, 0, 1);
    expect((await autoCommit({ worktree: dir, env })).committed).toBe(true);
  });

  it('a rename of 40 files is not a loss and is committed', async () => {
    const dir = repo(40);
    mkdirSync(join(dir, 'moved'));
    for (let i = 0; i < 40; i++) sh(dir, 'mv', [`f${i}.txt`, `moved/f${i}.txt`]);
    const r = await autoCommit({ worktree: dir, env });
    expect(r.committed).toBe(true);
  });

  it('deleting exactly the limit in a large repository is committed', async () => {
    const dir = repo(300);
    rm(dir, 0, AUTOCOMMIT_MAX_DELETED_FILES);
    expect((await autoCommit({ worktree: dir, env })).committed).toBe(true);
  });
});

describe('autoCommit: refusals leave everything as it is', () => {
  it('refuses more than the limit of deletions, commits nothing and keeps the index and the files', async () => {
    const dir = repo(40);
    const before = head(dir);
    rm(dir, 0, AUTOCOMMIT_MAX_DELETED_FILES + 1);
    writeFileSync(join(dir, 'untracked.txt'), 'u\n');
    const stagedBefore = staged(dir);
    const r = await autoCommit({ worktree: dir, env });
    expect(r.committed).toBe(false);
    const f = r.refused;
    expect(f?.reason).toBe('mass_deletion');
    expect(f?.deleted).toBe(26);
    expect(f?.tracked).toBe(41);
    expect(f?.added).toBe(1);
    expect(head(dir)).toBe(before);
    expect(staged(dir)).toBe(stagedBefore);
    expect(existsSync(join(dir, 'f0.txt'))).toBe(false);
    expect(existsSync(join(dir, 'untracked.txt'))).toBe(true);
    const porcelain = sh(dir, 'git', ['status', '--porcelain']).split('\n');
    expect(porcelain.filter((l) => l.trim().startsWith('D '))).toHaveLength(26);
    expect(porcelain).toContain('?? untracked.txt');
    if (!f) return;
    const note = autoCommitRefusedNote(f, { shiftId: 'shift-x', branch: 'aom/x', where: 'shift_end' });
    expect(note).toContain('shift-x');
    expect(note).toContain('deletes 26 of 41');
    expect(note).toContain('`f0.txt`');
  });

  it('refuses by percentage in a small repository (5 of 20 files)', async () => {
    const dir = repo(19);
    rm(dir, 0, 5);
    const r = await autoCommit({ worktree: dir, env });
    expect(r.refused?.reason).toBe('mass_deletion');
    expect(r.refused?.deleted).toBe(5);
  });

  it('refuses a tree that equals the tree of an ancestor and leaves the index alone', async () => {
    const dir = repo(5);
    const first = head(dir);
    writeFileSync(join(dir, 'x.ts'), 'x\n');
    writeFileSync(join(dir, 'README.md'), '# changed\n');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-qm', 'B']);
    // restore the first commit's tree in the working tree only
    sh(dir, 'git', ['checkout', first, '--', '.']);
    sh(dir, 'git', ['rm', '-q', '--cached', '-f', 'x.ts']);
    sh(dir, 'rm', ['x.ts']);
    sh(dir, 'git', ['reset', '-q', '--mixed']);
    const before = head(dir);
    const stagedBefore = staged(dir);
    const r = await autoCommit({ worktree: dir, env });
    expect(r.refused?.reason).toBe('tree_revert');
    expect(r.refused?.revertsTo).toBe(first);
    expect(head(dir)).toBe(before);
    expect(staged(dir)).toBe(stagedBefore);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# r\n');
    if (r.refused) expect(describeRefusal(r.refused)).toContain(first.slice(0, 7));
  });

  it('never runs reset, checkout, restore, clean, rm, stash or commit, and adds only on a temporary index', async () => {
    const dir = repo(40);
    rm(dir, 0, 30);
    calls.length = 0;
    const r = await autoCommit({ worktree: dir, env });
    expect(r.refused).toBeDefined();
    // the subcommand comes after any `-c <setting>` pairs (the install-output excludes file)
    const sub = (args: string[]) => args[args.findIndex((a, i) => a !== '-c' && args[i - 1] !== '-c')];
    const names = calls.map((c) => sub(c.args));
    for (const bad of ['reset', 'checkout', 'restore', 'clean', 'rm', 'stash', 'commit', 'switch'])
      expect(names).not.toContain(bad);
    const adds = calls.filter((c) => sub(c.args) === 'add');
    expect(adds.length).toBeGreaterThan(0);
    for (const a of adds) expect(a.env?.GIT_INDEX_FILE).toBeTruthy();
  });
});

describe('autoCommit: sandbox stubs', () => {
  it('stubs are not counted, not committed, and not a reason to commit', async () => {
    const dir = repo(40);
    // an empty untracked file that is a sandbox stub
    writeFileSync(join(dir, '.gitmodules'), '');
    expect(await autoCommit({ worktree: dir, env })).toEqual({ committed: false, skipped: 'clean' });
    writeFileSync(join(dir, 'f1.txt'), 'edited\n');
    const r = await autoCommit({ worktree: dir, env });
    expect(r.committed).toBe(true);
    expect(sh(dir, 'git', ['ls-files'])).not.toContain('.gitmodules');
  });

  it('26 deletions plus a stub: the deleted count is 26', async () => {
    const dir = repo(40);
    writeFileSync(join(dir, '.gitmodules'), '');
    rm(dir, 0, 26);
    const r = await autoCommit({ worktree: dir, env });
    expect(r.refused?.deleted).toBe(26);
  });
});

describe('unreportedWorkNote', () => {
  it('says the runner refused when the commit was refused', () => {
    const note = unreportedWorkNote(['a.ts'], { outcome: 'no_report', committed: false, refused: true });
    expect(note).toContain('refused to commit');
    expect(note).not.toContain('merge of the main branch');
  });
});

// ------------------------------------------------------------------------------------- devops-box-access (A)

/** node_modules with a package and its `.bin` link, a .venv with a pyvenv.cfg, a cargo target folder. */
function installOutput(dir: string, under = ''): void {
  const nm = join(dir, under, 'node_modules');
  mkdirSync(join(nm, 'left-pad'), { recursive: true });
  mkdirSync(join(nm, '.bin'), { recursive: true });
  writeFileSync(join(nm, 'left-pad', 'index.js'), 'module.exports = 1;\n');
  writeFileSync(join(nm, 'left-pad', 'package.json'), '{"bin":"index.js"}\n');
  symlinkSync('../left-pad/index.js', join(nm, '.bin', 'left-pad'));
  mkdirSync(join(dir, under, '.venv', 'bin'), { recursive: true });
  writeFileSync(join(dir, under, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
  writeFileSync(join(dir, under, '.venv', 'bin', 'python'), '');
  mkdirSync(join(dir, under, 'target', 'debug'), { recursive: true });
  writeFileSync(join(dir, under, 'target', 'debug', 'app'), 'ELF');
}
const committedFiles = (dir: string) =>
  sh(dir, 'git', ['show', '--name-only', '--format=', 'HEAD']).split('\n');

describe('devops-box-access: the WIP commit never adds install output', () => {
  it('AC3: no .gitignore, node_modules (with .bin links), .venv and target present: only the source change is committed', async () => {
    const dir = repo(3);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    installOutput(dir);
    writeFileSync(join(dir, 'f1.txt'), 'edited\n');
    writeFileSync(join(dir, 'src.ts'), 'export const x = 1;\n');
    const r = await autoCommit({ worktree: dir, env });
    expect(r.committed).toBe(true);
    expect(committedFiles(dir).sort()).toEqual(['f1.txt', 'src.ts']);
    const all = sh(dir, 'git', ['ls-files']);
    for (const bad of ['node_modules', '.venv', 'target']) expect(all).not.toContain(bad);
    // the repository is untouched: no .gitignore, no info/exclude entry
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    const info = join(dir, '.git', 'info', 'exclude');
    if (existsSync(info)) expect(readFileSync(info, 'utf8')).not.toContain('node_modules');
  });

  it('a nested app/node_modules is left out; a tracked target/x edit still commits; a .yarn/cache zip is committed', async () => {
    const dir = repo(2);
    mkdirSync(join(dir, 'target'));
    writeFileSync(join(dir, 'target', 'x'), 'tracked\n');
    sh(dir, 'git', ['add', '-f', 'target/x']);
    sh(dir, 'git', ['commit', '-qm', 'track target/x']);
    installOutput(dir, 'app');
    writeFileSync(join(dir, 'target', 'x'), 'changed\n');
    mkdirSync(join(dir, '.yarn', 'cache'), { recursive: true });
    writeFileSync(join(dir, '.yarn', 'cache', 'left-pad-npm-1.0.0.zip'), 'PK');
    const r = await autoCommit({ worktree: dir, env });
    expect(r.committed).toBe(true);
    expect(committedFiles(dir).sort()).toEqual(['.yarn/cache/left-pad-npm-1.0.0.zip', 'target/x']);
  });

  it('the user excludes (GIT_CONFIG_GLOBAL core.excludesFile) and a repo-local excludes file are honoured', async () => {
    const dir = repo(2);
    const home = tmp('aom-ac-home-');
    writeFileSync(join(home, 'ignore'), '*.log\n');
    writeFileSync(join(home, 'gitconfig'), `[core]\n\texcludesFile = ${join(home, 'ignore')}\n`);
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
    try {
      writeFileSync(join(dir, 'debug.log'), 'x\n');
      writeFileSync(join(dir, 'a.ts'), 'a\n');
      installOutput(dir);
      expect((await autoCommit({ worktree: dir, env })).committed).toBe(true);
      expect(committedFiles(dir)).toEqual(['a.ts']);
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }
    const dir2 = repo(2);
    writeFileSync(join(dir2, 'local-ignore'), '*.tmp\nlocal-ignore\n');
    sh(dir2, 'git', ['config', 'core.excludesFile', join(dir2, 'local-ignore')]);
    writeFileSync(join(dir2, 'x.tmp'), 'x\n');
    writeFileSync(join(dir2, 'b.ts'), 'b\n');
    expect((await autoCommit({ worktree: dir2, env })).committed).toBe(true);
    expect(committedFiles(dir2)).toEqual(['b.ts']);
  });

  it('a tracked node_modules/a.js edit is refused (install_output); the note names git rm -r --cached; nothing is touched', async () => {
    const dir = repo(2);
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'a.js'), '1\n');
    sh(dir, 'git', ['add', '-f', 'node_modules/a.js']);
    sh(dir, 'git', ['commit', '-qm', 'GIT-2 style: node_modules committed']);
    const before = head(dir);
    writeFileSync(join(dir, 'node_modules', 'a.js'), '2\n');
    writeFileSync(join(dir, 'f0.txt'), 'real work\n');
    const stagedBefore = staged(dir);
    const r = await autoCommit({ worktree: dir, env });
    expect(r.refused?.reason).toBe('install_output');
    expect(r.refused?.paths).toEqual(['node_modules']);
    expect(head(dir)).toBe(before);
    expect(staged(dir)).toBe(stagedBefore);
    if (!r.refused) return;
    const note = autoCommitRefusedNote(r.refused, { shiftId: 's1', where: 'shift_end' });
    expect(note).toContain('git rm -r --cached node_modules');
    expect(note).not.toMatch(/Deleted files|restore the files from HEAD/);
    // the clean-up itself (only deletions under node_modules, below the mass-deletion limit) is committed
    sh(dir, 'git', ['checkout', '--', 'node_modules/a.js']);
    sh(dir, 'git', ['rm', '-q', '-r', '--cached', 'node_modules']);
    const c = await autoCommit({ worktree: dir, env });
    expect(c.committed).toBe(true);
    expect(sh(dir, 'git', ['ls-files'])).not.toContain('node_modules');
  });

  it('a source folder named venv is real work: a tracked src/venv/x.py edit commits; a tracked virtualenv venv/ is refused', async () => {
    const dir = repo(2);
    mkdirSync(join(dir, 'src', 'venv'), { recursive: true });
    writeFileSync(join(dir, 'src', 'venv', 'x.py'), 'a = 1\n');
    sh(dir, 'git', ['add', '-f', 'src/venv/x.py']);
    sh(dir, 'git', ['commit', '-qm', 'a package named venv']);
    writeFileSync(join(dir, 'src', 'venv', 'x.py'), 'a = 2\n');
    const r = await autoCommit({ worktree: dir, env });
    expect(r.committed).toBe(true);
    expect(committedFiles(dir)).toEqual(['src/venv/x.py']);
    mkdirSync(join(dir, 'venv', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
    writeFileSync(join(dir, 'venv', 'lib', 'site.py'), '1\n');
    sh(dir, 'git', ['add', '-f', 'venv']);
    sh(dir, 'git', ['commit', '-qm', 'a committed virtualenv']);
    writeFileSync(join(dir, 'venv', 'lib', 'site.py'), '2\n');
    expect((await autoCommit({ worktree: dir, env })).refused?.reason).toBe('install_output');
  });

  it('PREREVIEW 1: a new untracked src/venv/x.py (no pyvenv.cfg) commits; an untracked virtualenv venv/ is left out', async () => {
    const dir = repo(2);
    mkdirSync(join(dir, 'src', 'venv'), { recursive: true });
    writeFileSync(join(dir, 'src', 'venv', 'x.py'), 'a = 1\n');
    mkdirSync(join(dir, 'venv', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
    writeFileSync(join(dir, 'venv', 'lib', 'site.py'), '1\n');
    mkdirSync(join(dir, 'app', 'venv'), { recursive: true });
    writeFileSync(join(dir, 'app', 'venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
    const r = await autoCommit({ worktree: dir, env });
    expect(r.committed).toBe(true);
    expect(committedFiles(dir)).toEqual(['src/venv/x.py']);
  });

  it('REVIEW 1: a symlinked ~/.config/git/ignore and a symlinked core.excludesFile are followed (secret.env is not committed)', async () => {
    const home = tmp('aom-ac-dotfiles-');
    const dotfiles = join(home, 'dotfiles');
    mkdirSync(dotfiles);
    writeFileSync(join(dotfiles, 'ignore'), 'secret.env\n');
    mkdirSync(join(home, 'xdg', 'git'), { recursive: true });
    symlinkSync(join(dotfiles, 'ignore'), join(home, 'xdg', 'git', 'ignore'));
    writeFileSync(join(home, 'empty-gitconfig'), '');
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, x: process.env.XDG_CONFIG_HOME };
    const restore = () => {
      for (const [k, v] of [
        ['GIT_CONFIG_GLOBAL', saved.g],
        ['XDG_CONFIG_HOME', saved.x],
      ] as const)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    };
    try {
      // the XDG default, a symlink into a dotfiles folder
      process.env.GIT_CONFIG_GLOBAL = join(home, 'empty-gitconfig');
      process.env.XDG_CONFIG_HOME = join(home, 'xdg');
      const dir = repo(2);
      writeFileSync(join(dir, 'secret.env'), 'TOKEN=x\n');
      writeFileSync(join(dir, 'a.ts'), 'a\n');
      expect((await autoCommit({ worktree: dir, env })).committed).toBe(true);
      expect(committedFiles(dir)).toEqual(['a.ts']);
      // a configured core.excludesFile that is a symlink
      symlinkSync(join(dotfiles, 'ignore'), join(home, 'linked-ignore'));
      writeFileSync(join(home, 'gitconfig'), `[core]\n\texcludesFile = ${join(home, 'linked-ignore')}\n`);
      process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
      delete process.env.XDG_CONFIG_HOME;
      const dir2 = repo(2);
      writeFileSync(join(dir2, 'secret.env'), 'TOKEN=x\n');
      writeFileSync(join(dir2, 'b.ts'), 'b\n');
      expect((await autoCommit({ worktree: dir2, env })).committed).toBe(true);
      expect(committedFiles(dir2)).toEqual(['b.ts']);
    } finally {
      restore();
    }
  });

  it('REVIEW 2: a node_modules that is a symlink (to a shared store) is not committed', async () => {
    const dir = repo(2);
    const store = tmp('aom-ac-store-');
    mkdirSync(join(store, 'left-pad'));
    symlinkSync(store, join(dir, 'node_modules'));
    mkdirSync(join(dir, 'pkg'));
    symlinkSync(store, join(dir, 'pkg', 'node_modules'));
    writeFileSync(join(dir, 'c.ts'), 'c\n');
    expect((await autoCommit({ worktree: dir, env })).committed).toBe(true);
    expect(committedFiles(dir)).toEqual(['c.ts']);
  });

  it('a nested git init repo is refused (embedded_repo); a submodule listed in .gitmodules passes', async () => {
    const dir = repo(2);
    const nested = join(dir, 'vendored');
    mkdirSync(nested);
    sh(nested, 'git', ['init', '-q', '-b', 'main']);
    writeFileSync(join(nested, 'r.txt'), 'r\n');
    sh(nested, 'git', ['add', '-A']);
    sh(nested, 'git', ['commit', '-qm', 'nested']);
    const before = head(dir);
    const r = await autoCommit({ worktree: dir, env });
    expect(r.refused?.reason).toBe('embedded_repo');
    expect(r.refused?.paths).toEqual(['vendored']);
    expect(head(dir)).toBe(before);
    if (r.refused)
      expect(autoCommitRefusedNote(r.refused, { shiftId: 's', where: 'report' })).toContain(
        'remove it or add it as a submodule',
      );
    writeFileSync(
      join(dir, '.gitmodules'),
      '[submodule "vendored"]\n\tpath = vendored\n\turl = ./vendored\n',
    );
    const ok = await autoCommit({ worktree: dir, env });
    expect(ok.committed).toBe(true);
  });

  it('more than 1000 added files are refused (mass_addition) with the folders and counts; the real index is untouched', async () => {
    const dir = repo(2);
    mkdirSync(join(dir, 'deps'));
    for (let i = 0; i < 1001; i++) writeFileSync(join(dir, 'deps', `f${i}.js`), `${i}\n`);
    writeFileSync(join(dir, 'top.ts'), 't\n');
    const before = head(dir);
    const stagedBefore = staged(dir);
    const r = await autoCommit({ worktree: dir, env });
    expect(r.refused?.reason).toBe('mass_addition');
    expect(r.refused?.added).toBe(1002);
    expect(head(dir)).toBe(before);
    expect(staged(dir)).toBe(stagedBefore);
    if (!r.refused) return;
    const note = autoCommitRefusedNote(r.refused, { shiftId: 's', where: 'shift_end' });
    expect(note).toContain('`deps/` (1001)');
    expect(note).toContain('add an ignore rule');
    expect(note).not.toContain('Deleted files');
  });

  it('the unreported-work list has no install output lines', async () => {
    const dir = repo(2);
    installOutput(dir);
    writeFileSync(join(dir, 'w.ts'), 'w\n');
    const files = await uncommittedFiles(dir);
    expect(files).toEqual(['?? w.ts']);
    const note = unreportedWorkNote(files, { outcome: 'no_report', committed: false, refused: true });
    expect(note).not.toContain('node_modules');
  });

  it('a repository with no HEAD commits the source only', async () => {
    const dir = join(tmp(), 'nohead');
    mkdirSync(dir);
    sh(dir, 'git', ['init', '-q', '-b', 'main']);
    installOutput(dir);
    writeFileSync(join(dir, 'main.ts'), 'm\n');
    const r = await autoCommit({ worktree: dir, env });
    expect(r.committed).toBe(true);
    expect(sh(dir, 'git', ['ls-files'])).toBe('main.ts');
  });
});

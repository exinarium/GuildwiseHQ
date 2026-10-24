import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type BundleEntry,
  bundleHash,
  DELIVERY_DIR,
  findSecret,
  isSafeVaultPath,
  type LintItem,
  lintRecipe,
  parseRecipe,
  parseSetupText,
  RECIPE_FILE,
  type RecipeInspectResult,
  SETUP_FILE,
} from '@aom/shared';
import { execa } from 'execa';
import { git } from '../git/git.ts';
import { GIT_HARDEN_ENV, hardenedGitArgs } from '../git/harden.ts';

/**
 * The delivery bundle: every file of `<folder>/delivery/` of a project vault, with the owner-executable bit and a content
 * hash (docs/design/ceo-front-door.md 9.4). From a git vault it is read AT A COMMIT (`git ls-tree` and `git cat-file`),
 * never from the working tree, so an edit nobody committed cannot change what was approved. From a local vault there are no
 * commits: the folder is read once, and the caller hashes and runs the copy it took.
 */

export const MAX_BUNDLE_FILES = 200;
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

export interface BundleFile extends BundleEntry {
  content: Buffer;
}
export interface Bundle {
  files: BundleFile[];
  hash: string;
}

export class BundleError extends Error {
  constructor(
    readonly code: 'too_big' | 'unsafe' | 'no_commit' | 'unreadable',
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export function makeBundle(files: BundleFile[]): Bundle {
  return { files, hash: bundleHash(files.map(({ path, mode, sha256: h }) => ({ path, mode, sha256: h }))) };
}

const exec = (mode: number): '755' | '644' => (mode & 0o111 ? '755' : '644');

/** Does the commit exist in this clone? */
export async function hasCommit(dir: string, commit: string): Promise<boolean> {
  return (await git(dir, ['cat-file', '-e', `${commit}^{commit}`])).exitCode === 0;
}

export async function headCommit(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', 'HEAD']);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/** The bundle of `<folder>/delivery/` at `commit`. An absent folder is an empty bundle. */
export async function readBundleAtCommit(dir: string, folder: string, commit: string): Promise<Bundle> {
  if (!(await hasCommit(dir, commit)))
    throw new BundleError('no_commit', `commit ${commit.slice(0, 10)} is not in the vault clone`);
  const prefix = `${folder}/${DELIVERY_DIR}`;
  const ls = await execa('git', hardenedGitArgs(['ls-tree', '-r', '-z', commit, '--', prefix]), {
    cwd: dir,
    env: { ...GIT_HARDEN_ENV },
    extendEnv: true,
    reject: false,
    stdin: 'ignore',
  });
  if (ls.exitCode !== 0)
    throw new BundleError('unreadable', `git ls-tree failed: ${String(ls.stderr).slice(0, 200)}`);
  const files: BundleFile[] = [];
  let total = 0;
  for (const rec of String(ls.stdout).split('\0').filter(Boolean)) {
    const m = /^(\d{6}) (blob|commit|tree) ([0-9a-f]{40,64})\t(.+)$/s.exec(rec);
    if (!m) continue;
    const [, mode, type, oid, full] = m as unknown as [string, string, string, string, string];
    const path = full.slice(prefix.length + 1);
    if (type !== 'blob' || mode === '120000')
      throw new BundleError('unsafe', `${path} is a symlink or a submodule: recipes hold plain files only`);
    if (!isSafeVaultPath(`${prefix}/${path}`)) throw new BundleError('unsafe', `unsafe path ${path}`);
    const blob = await execa('git', hardenedGitArgs(['cat-file', 'blob', oid]), {
      cwd: dir,
      env: { ...GIT_HARDEN_ENV },
      extendEnv: true,
      encoding: 'buffer',
      stripFinalNewline: false,
      reject: false,
      stdin: 'ignore',
    });
    if (blob.exitCode !== 0) throw new BundleError('unreadable', `could not read ${path}`);
    const content = Buffer.from(blob.stdout as Uint8Array);
    total += content.length;
    if (files.length >= MAX_BUNDLE_FILES || total > MAX_BUNDLE_BYTES)
      throw new BundleError('too_big', 'the delivery folder is too big');
    files.push({ path, mode: mode === '100755' ? '755' : '644', sha256: sha256(content), content });
  }
  return makeBundle(files);
}

/** The bundle of a local folder. Symlinks are refused (they could point anywhere). */
export function readBundleFromDir(root: string): Bundle {
  const files: BundleFile[] = [];
  let total = 0;
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs).sort()) {
      if (name === '.git') continue;
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isSymbolicLink())
        throw new BundleError('unsafe', `${r} is a symlink: recipes hold plain files only`);
      if (st.isDirectory()) {
        walk(p, r);
        continue;
      }
      if (!st.isFile()) continue;
      const content = readFileSync(p);
      total += content.length;
      if (files.length >= MAX_BUNDLE_FILES || total > MAX_BUNDLE_BYTES)
        throw new BundleError('too_big', 'the delivery folder is too big');
      files.push({ path: r, mode: exec(st.mode), sha256: sha256(content), content });
    }
  };
  if (existsSync(root)) walk(root, '');
  return makeBundle(files);
}

/** Writes a bundle into `dest` (created fresh) with its modes. */
export function exportBundle(bundle: Bundle, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const f of bundle.files) {
    const file = join(dest, ...f.path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, f.content, { mode: f.mode === '755' ? 0o755 : 0o644 });
    chmodSync(file, f.mode === '755' ? 0o755 : 0o644);
  }
}

const isText = (b: Buffer): boolean => !b.subarray(0, 4096).includes(0);

/** Parses the recipe of a bundle and lints what only the files can show: secrets, missing and non-executable scripts. */
export function inspectBundle(bundle: Bundle, vaultCommit: string | null): RecipeInspectResult {
  const recipeFile = bundle.files.find((f) => f.path === RECIPE_FILE);
  const present = bundle.files.length > 0;
  const files = bundle.files.map((f) => ({
    path: f.path,
    mode: f.mode,
    sha256: f.sha256,
    secret: isText(f.content) ? findSecret(f.content.toString('utf8')) : null,
  }));
  if (!recipeFile)
    return {
      ok: true,
      present,
      vaultCommit,
      hash: bundle.hash,
      files,
      recipe: null,
      ...(present ? { parseError: `there is no ${RECIPE_FILE} in delivery/` } : {}),
      lint: present
        ? ([
            { level: 'error', code: 'no_recipe', message: `there is no ${RECIPE_FILE} in delivery/` },
          ] satisfies LintItem[])
        : [],
    };
  const parsed = parseRecipe(recipeFile.content.toString('utf8'));
  // The guided setup, when the bundle has a valid one: the server compiles it to find scripts that were edited by hand.
  const setupFile = bundle.files.find((f) => f.path === SETUP_FILE);
  const setup = setupFile ? parseSetupText(setupFile.content.toString('utf8')) : null;
  const lint = lintRecipe({
    recipe: parsed.ok ? parsed.recipe : null,
    ...(parsed.ok ? {} : { parseError: parsed.error }),
    files,
  });
  return {
    ok: true,
    present: true,
    vaultCommit,
    hash: bundle.hash,
    files,
    recipe: parsed.ok ? parsed.recipe : null,
    ...(parsed.ok ? {} : { parseError: parsed.error }),
    lint,
    ...(setup?.ok ? { setup: setup.setup } : {}),
  };
}

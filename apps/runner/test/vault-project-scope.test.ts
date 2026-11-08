import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentPermissions, BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  buildChatSettings,
  buildShiftSettings,
  type ClaudePolicyContext,
  type ClaudeSettings,
  scopedVaultHidden,
  vaultSiblingMasks,
} from '../src/adapters/claude-policy.ts';
import { SECRET_FILE_GLOBS, sandboxReadEntries } from '../src/adapters/read-only-dirs.ts';
import { cardScopedVaults } from '../src/shifts/supervisor.ts';
import { readVaultContexts } from '../src/vaults/context.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

cleanupTmp();

const builder = BUILTIN_ROLES.find((r) => r.key === 'builder')!.permissions as AgentPermissions;
const ba = BUILTIN_ROLES.find((r) => r.key === 'ba')!.permissions as AgentPermissions;

/** A git-synced organization vault: .git, root files, org/, projects/a (with a secret), projects/b and projects/c. */
function orgVault(projects = ['a', 'b', 'c']): string {
  const dir = join(tmp('aom-org-vault-'), 'vault-org');
  const files: Record<string, string> = {
    'README.md': '# Org\n',
    'standing-orders.md': 'rules\n',
    '.env': 'SECRET=1\n',
    'org/people.md': 'people\n',
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.git/objects/pack/history.pack': 'every project\n',
  };
  for (const p of projects) {
    files[`projects/${p}/PROJECT.md`] = `# ${p}\n`;
    files[`projects/${p}/notes/n.md`] = 'n\n';
  }
  if (projects.includes('a')) files['projects/a/deploy.pem'] = 'key\n';
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

const ruleAbs = (p: string) => `/${p}`;
const shift = (vault: string, keep: string | null, over: Partial<ClaudePolicyContext> = {}, p = builder) =>
  buildShiftSettings(
    p,
    policyCtx({
      readDirs: [vault],
      ...(keep !== null ? { scopedVaults: [{ dir: vault, keep: join(vault, keep) }] } : {}),
      ...over,
    }),
    POLICY_PATHS,
    'builder',
  );
const allowRead = (s: ClaudeSettings) => s.sandbox?.filesystem.allowRead ?? [];
const denyRead = (s: ClaudeSettings) => s.sandbox?.filesystem.denyRead ?? [];
const denyRules = (s: ClaudeSettings) => s.permissions.deny;
/** Whether a path is readable from the shell: covered by an allowRead entry (itself or a parent). */
const shellReads = (s: ClaudeSettings, path: string) =>
  allowRead(s).some((a) => path === a || path.startsWith(`${a}/`));

describe('vaultSiblingMasks', () => {
  it('lists every projects/* entry except the card’s own folder', () => {
    const v = orgVault();
    expect(vaultSiblingMasks({ dir: v, keep: join(v, 'projects/a') }).sort()).toEqual([
      join(v, 'projects/b'),
      join(v, 'projects/c'),
    ]);
  });
  it('a project with no folder yet: every sibling is masked', () => {
    const v = orgVault(['b', 'c']);
    expect(vaultSiblingMasks({ dir: v, keep: join(v, 'projects/a') }).sort()).toEqual([
      join(v, 'projects/b'),
      join(v, 'projects/c'),
    ]);
  });
  it('a vault without projects/: nothing to mask', () => {
    const v = join(tmp(), 'empty');
    mkdirSync(join(v, 'org'), { recursive: true });
    expect(vaultSiblingMasks({ dir: v, keep: join(v, 'projects/a') })).toEqual([]);
  });
});

describe('card shift: the organization vault is read without the other projects', () => {
  it('Read tool: projects/b and projects/c are denied; the root, org/ and projects/a are not', () => {
    const v = orgVault();
    const deny = denyRules(shift(v, 'projects/a'));
    for (const p of ['projects/b', 'projects/c']) {
      expect(deny).toContain(`Read(${ruleAbs(join(v, p))}/**)`);
      expect(deny).toContain(`Read(${ruleAbs(join(v, p))})`);
    }
    const blocks = (path: string) =>
      deny.some((r) => {
        const m = /^Read\((.*?)(\/\*\*)?\)$/.exec(r);
        if (!m || m[1]!.includes('*')) return false;
        const base = m[1]!.slice(1);
        return m[2] ? path.startsWith(`${base}/`) : path === base;
      });
    for (const p of ['README.md', 'org/people.md', 'projects/a/PROJECT.md', 'projects/a/notes/n.md'])
      expect(blocks(join(v, p)), p).toBe(false);
    for (const p of ['projects/b/PROJECT.md', 'projects/c/notes/n.md'])
      expect(blocks(join(v, p)), p).toBe(true);
  });

  it('shell: the clone is opened entry by entry, without projects/b, projects/c or secret files', () => {
    const v = orgVault();
    const s = shift(v, 'projects/a');
    expect(allowRead(s)).not.toContain(v);
    for (const p of [
      'README.md',
      'standing-orders.md',
      'org/people.md',
      'projects/a/PROJECT.md',
      'projects/a/notes/n.md',
    ])
      expect(shellReads(s, join(v, p)), p).toBe(true);
    for (const p of ['projects/b/PROJECT.md', 'projects/c/notes/n.md', '.env', 'projects/a/deploy.pem'])
      expect(shellReads(s, join(v, p)), p).toBe(false);
    expect(denyRead(s)).toEqual(expect.arrayContaining([join(v, 'projects/b'), join(v, 'projects/c')]));
    expect(denyRead(s)).not.toContain(join(v, 'projects/a'));
  });

  it('secret-file denies stay exactly as before, the card’s own folder included', () => {
    const v = orgVault();
    const scoped = denyRules(shift(v, 'projects/a'));
    for (const g of SECRET_FILE_GLOBS) expect(scoped).toContain(`Read(${ruleAbs(v)}/**/${g})`);
    // the scoped rules are today's rules plus the sibling denies, nothing removed
    const before = denyRules(shift(v, null));
    expect(scoped.filter((r) => !before.includes(r)).sort()).toEqual(
      ['.git', 'projects/b', 'projects/c']
        .flatMap((p) => [`Read(${ruleAbs(join(v, p))})`, `Read(${ruleAbs(join(v, p))}/**)`])
        .sort(),
    );
    expect(before.filter((r) => !scoped.includes(r))).toEqual([]);
  });

  it('the vault stays read-only (no write anywhere in it)', () => {
    const v = orgVault();
    const s = shift(v, 'projects/a');
    expect(s.sandbox?.filesystem.denyWrite).toContain(v);
    expect(denyRules(s)).toContain(`Edit(${ruleAbs(v)}/**)`);
  });

  it('a project whose folder differs from its key sees its own folder (the folder is what the server sent)', () => {
    const v = orgVault(['toy-legacy', 'b']);
    const s = shift(v, 'projects/toy-legacy');
    expect(shellReads(s, join(v, 'projects/toy-legacy/PROJECT.md'))).toBe(true);
    expect(shellReads(s, join(v, 'projects/b/PROJECT.md'))).toBe(false);
    expect(denyRules(s)).not.toContain(`Read(${ruleAbs(join(v, 'projects/toy-legacy'))}/**)`);
  });

  it('a project with no folder yet: the shift settings build, root and org/ readable, every project masked', () => {
    const v = orgVault(['b', 'c']);
    const s = shift(v, 'projects/a');
    expect(shellReads(s, join(v, 'README.md'))).toBe(true);
    expect(shellReads(s, join(v, 'org/people.md'))).toBe(true);
    expect(shellReads(s, join(v, 'projects/b/PROJECT.md'))).toBe(false);
    expect(shellReads(s, join(v, 'projects/c/PROJECT.md'))).toBe(false);
  });

  it('a read-only role (BA) gets the same masks', () => {
    const v = orgVault();
    const s = shift(v, 'projects/a', {}, ba);
    expect(denyRules(s)).toContain(`Read(${ruleAbs(join(v, 'projects/b'))}/**)`);
    expect(shellReads(s, join(v, 'projects/b/PROJECT.md'))).toBe(false);
  });

  it('only the scoped clone is masked: another read-only folder (the project vault) opens as before', () => {
    const v = orgVault();
    const prj = orgVault(['a']);
    const s = shift(v, 'projects/a', { readDirs: [prj, v] });
    expect(allowRead(s)).toEqual(expect.arrayContaining(sandboxReadEntries(prj) ?? []));
    expect(shellReads(s, join(prj, 'projects/a/PROJECT.md'))).toBe(true);
    expect(denyRules(s).some((r) => r.startsWith(`Read(${ruleAbs(prj)}/projects`))).toBe(false);
  });

  it('a scope for a folder that is not a read-only folder of the session is ignored', () => {
    const v = orgVault();
    const s = buildShiftSettings(
      builder,
      policyCtx({ readDirs: [], scopedVaults: [{ dir: v, keep: join(v, 'projects/a') }] }),
      POLICY_PATHS,
      'builder',
    );
    expect(denyRules(s).some((r) => r.includes(v))).toBe(false);
    expect(denyRead(s).some((r) => r.startsWith(v))).toBe(false);
  });
});

describe('card shift: the scoped clone hides its git history and its links', () => {
  it('the clone’s .git is not readable from the shell or the Read tool (its history holds every project)', () => {
    const v = orgVault();
    const s = shift(v, 'projects/a');
    for (const p of ['.git', '.git/HEAD', '.git/objects/pack/history.pack'])
      expect(shellReads(s, join(v, p)), p).toBe(false);
    expect(denyRead(s)).toContain(join(v, '.git'));
    expect(denyRules(s)).toContain(`Read(${ruleAbs(join(v, '.git'))}/**)`);
    expect(denyRules(s)).toContain(`Read(${ruleAbs(join(v, '.git'))})`);
    expect(shellReads(s, join(v, 'org/people.md'))).toBe(true);
  });

  it('an unscoped clone still opens its .git as before', () => {
    const v = orgVault();
    const s = shift(v, null);
    expect(shellReads(s, join(v, '.git/HEAD'))).toBe(true);
    expect(denyRead(s)).not.toContain(join(v, '.git'));
    expect(denyRules(s).some((r) => r.includes(join(v, '.git')))).toBe(false);
  });

  it('scopedVaultHidden: the clone’s .git plus the other projects', () => {
    const v = orgVault();
    expect(scopedVaultHidden({ dir: v, keep: join(v, 'projects/a') }).sort()).toEqual(
      [join(v, '.git'), join(v, 'projects/b'), join(v, 'projects/c')].sort(),
    );
  });

  it('a link at the root or in projects/ is not opened to the shell (its target would be bound)', () => {
    const v = orgVault();
    symlinkSync(join(v, 'projects/b'), join(v, 'shortcut'));
    symlinkSync(join(v, 'projects/c/PROJECT.md'), join(v, 'c.md'));
    symlinkSync(join(v, 'projects/b'), join(v, 'projects/a-alias'));
    const s = shift(v, 'projects/a');
    for (const p of ['shortcut', 'c.md', 'projects/a-alias'])
      expect(
        allowRead(s).some((a) => a === join(v, p) || a.startsWith(`${join(v, p)}/`)),
        p,
      ).toBe(false);
    expect(shellReads(s, join(v, 'projects/a/PROJECT.md'))).toBe(true);
    expect(shellReads(s, join(v, 'README.md'))).toBe(true);
  });
});

describe('cardScopedVaults (supervisor): only the organization vault of a card shift is scoped', () => {
  const ctxs = [
    { kind: 'org', addDir: '/v/org', folder: 'projects/toy-legacy' },
    { kind: 'project', addDir: '/v/prj', folder: 'projects/toy' },
  ];
  it('a card shift scopes the org vault to the folder the server sent', () => {
    expect(cardScopedVaults('card', ctxs)).toEqual([
      { dir: '/v/org', keep: join('/v/org', 'projects', 'toy-legacy') },
    ]);
  });
  it('non-card shifts are not scoped', () => {
    for (const k of ['question', 'ba_task', 'ceo', 'devops', undefined])
      expect(cardScopedVaults(k, ctxs), String(k)).toEqual([]);
  });
  it('an org vault without a folder is not scoped', () => {
    expect(cardScopedVaults('card', [{ kind: 'org', addDir: '/v/org' }])).toEqual([]);
  });
});

describe('sessions without a scope behave as before', () => {
  it('a shift with the vault but no scope: the clone opens whole, no sibling denies', () => {
    const v = orgVault(['b']); // no secret below projects/ apart from the root .env
    const s = shift(v, null);
    expect(denyRules(s).some((r) => r.includes('/projects/'))).toBe(false);
    expect(denyRead(s).some((r) => r.startsWith(v))).toBe(false);
  });

  it('chat settings are unchanged when no scope is given', () => {
    const v = orgVault();
    const paths = POLICY_PATHS;
    const a = buildChatSettings(true, [], policyCtx({ readDirs: [v] }), paths);
    const b = buildChatSettings(true, [], policyCtx({ readDirs: [v], scopedVaults: undefined }), paths);
    expect(a).toEqual(b);
    expect(a.permissions.deny.some((r) => r.includes('/projects/'))).toBe(false);
  });
});

describe('readVaultContexts carries the folder the server sent', () => {
  it('each context keeps its vault’s folder', async () => {
    const root = tmp('aom-vaults-');
    for (const id of ['vault-org', 'vault-prj']) {
      mkdirSync(join(root, id, '.git'), { recursive: true });
      writeFileSync(join(root, id, 'standing-orders.md'), `rules ${id}\n`);
    }
    const ctxs = await readVaultContexts(root, [
      { vaultId: 'vault-prj', kind: 'project', folder: 'projects/toy' },
      { vaultId: 'vault-org', kind: 'org', folder: 'projects/toy-legacy' },
    ]);
    expect(ctxs.map((c) => [c.kind, c.folder])).toEqual([
      ['project', 'projects/toy'],
      ['org', 'projects/toy-legacy'],
    ]);
  });
});

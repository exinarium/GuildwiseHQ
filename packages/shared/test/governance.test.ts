import { describe, expect, it } from 'vitest';
import {
  checkScopes,
  GATE_CLASSES,
  GATE_INFO,
  indexPack,
  normalizeScopes,
  PushPayloadSchema,
  packItemOf,
  redactForExport,
} from '../src/index.ts';

const fm = (f: Record<string, string>, body = 'Body.') =>
  `---\n${Object.entries(f)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n\n${body}\n`;

describe('scopes', () => {
  it('normalizes a list or a comma/space separated string', () => {
    expect(normalizeScopes('Shell, web  edit')).toEqual(['shell', 'web', 'edit']);
    expect(normalizeScopes(['shell', 'shell', 'Web', 'bad scope!', 5])).toEqual(['shell', 'web']);
    expect(normalizeScopes(undefined)).toEqual([]);
    expect(normalizeScopes(Array.from({ length: 40 }, (_, i) => `s${i}`))).toHaveLength(20);
  });

  it('compares scopes with what an agent has; unknown scopes never block', () => {
    const facts = {
      allowedTools: ['read', 'edit', 'mcp:github'],
      mayCommit: false,
      browser: false,
      readOrgRepos: false,
      hasDelegation: false,
      scriptsEnabled: false,
    };
    const c = checkScopes(['read', 'shell', 'mcp', 'commit', 'delegate', 'weird.scope'], facts);
    const byScope = Object.fromEntries(c.map((x) => [x.scope, x]));
    expect(byScope.read?.has).toBe(true);
    expect(byScope.shell?.has).toBe(false);
    expect(byScope.mcp?.has).toBe(true);
    expect(byScope.commit?.has).toBe(false);
    expect(byScope.delegate?.has).toBe(false);
    expect(byScope['weird.scope']).toMatchObject({ known: false, has: true });
  });

  it('reads scopes from a skill’s metadata, a playbook’s frontmatter and the manifest (pack level and per entry)', () => {
    const tree = {
      'pack.yaml': [
        'scopes: [web]',
        'playbooks:',
        '  - dir: flows/ship',
        '    scopes: [shell, commit]',
        '',
      ].join('\n'),
      'skills/lint/SKILL.md': `---\nname: lint\ndescription: Lint things\nmetadata:\n  scopes: "edit, shell"\n---\n\nRun the linter.\n`,
      'flows/ship/workflow.md': fm({ name: 'ship', description: 'Ship it' }),
      'flows/ship/steps/step-01-go.md': '# Step 1\n\nGo.\n',
      'playbooks/own/workflow.md': fm({ name: 'own', description: 'Own scopes', scopes: '[browser]' }),
    };
    const idx = indexPack({ name: 'acme', tree });
    expect(idx.issues).toEqual([]);
    const by = (kind: string, key: string) => idx.entries.find((e) => e.kind === kind && e.key === key);
    expect(by('skill', 'acme:lint')?.scopes).toEqual(['edit', 'shell', 'web']);
    expect(by('playbook', 'acme:ship')?.scopes).toEqual(['web', 'shell', 'commit']);
    expect(by('playbook', 'acme:own')?.scopes).toEqual(['browser', 'web']);
    const item = packItemOf(by('playbook', 'acme:ship') as never, 'acme');
    expect(item.scopes).toEqual(['web', 'shell', 'commit']);
  });

  it('a scope added by the manifest changes the hash (the owner reviews again); frontmatter scopes are in the files already', () => {
    const base = {
      'flows/ship/workflow.md': fm({ name: 'ship', description: 'Ship it' }),
      'flows/ship/steps/step-01-go.md': '# Step 1\n\nGo.\n',
    };
    const a = indexPack({
      name: 'acme',
      tree: { ...base, 'pack.yaml': 'playbooks:\n  - dir: flows/ship\n' },
    });
    const b = indexPack({
      name: 'acme',
      tree: { ...base, 'pack.yaml': 'playbooks:\n  - dir: flows/ship\n    scopes: [shell]\n' },
    });
    expect(a.entries[0]?.hash).not.toBe(b.entries[0]?.hash);
    // no scopes anywhere: the hash is what it always was
    const c = indexPack({
      name: 'acme',
      tree: { ...base, 'pack.yaml': 'playbooks:\n  - dir: flows/ship\n' },
    });
    expect(c.entries[0]?.hash).toBe(a.entries[0]?.hash);
  });
});

describe('gates', () => {
  it('describes every class and says where it is enforced', () => {
    for (const c of GATE_CLASSES) expect(GATE_INFO[c].label).toBeTruthy();
    expect(GATE_INFO.outbound_mail.enforcement).toBe('always');
    expect(GATE_INFO.pack_scripts.enforcement).toBe('not_enforced');
    expect(GATE_INFO.merge_push.enforcement).toBe('opt_in');
  });
});

describe('push payload actions', () => {
  it('allows at most two actions and stays valid without any', () => {
    const base = { title: 't', body: 'b', url: '/desk', tag: 'x', badge: 1 };
    expect(PushPayloadSchema.safeParse(base).success).toBe(true);
    const a = (n: number) => ({ action: `a${n}`, title: `A${n}`, url: `/m/desk/t${n}` });
    expect(PushPayloadSchema.safeParse({ ...base, actions: [a(1), a(2)] }).success).toBe(true);
    expect(PushPayloadSchema.safeParse({ ...base, actions: [a(1), a(2), a(3)] }).success).toBe(false);
  });
});

describe('export redaction', () => {
  it('replaces secret-looking keys and masks secret-looking text, and keeps ids and e-mail addresses', () => {
    const out = redactForExport({
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'a@b.example',
      password: 'hunter2hunter2',
      nested: {
        apiKey: 'sk-abcdefghijklmnop',
        note: 'use Bearer abcdefghijklmnop1234 to call',
        ciphertext: 'zzz',
      },
      list: [{ token: 'x' }, 'password=swordfish123'],
    }) as Record<string, any>;
    expect(out.userId).toBe('11111111-1111-4111-8111-111111111111');
    expect(out.email).toBe('a@b.example');
    expect(out.password).toBe('[redacted]');
    expect(out.nested.apiKey).toBe('[redacted]');
    expect(out.nested.ciphertext).toBe('[redacted]');
    expect(out.nested.note).not.toContain('abcdefghijklmnop1234');
    expect(out.list[0].token).toBe('[redacted]');
    expect(out.list[1]).not.toContain('swordfish123');
  });
});

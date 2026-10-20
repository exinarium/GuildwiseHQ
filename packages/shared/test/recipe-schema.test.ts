import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bundleHash,
  DeployExecPayloadSchema,
  expandTemplate,
  findSecret,
  lintHasErrors,
  lintRecipe,
  parseRecipe,
  resolveGate,
  unknownTemplateVars,
} from '../src/index.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'p5-recipe');
const p5 = readFileSync(join(FIXTURE, 'recipe.yaml'), 'utf8');

describe('recipe.yaml (docs/design/ceo-front-door.md 9.2)', () => {
  it('expresses a P5-shaped recipe: a local Docker target, a long script and a log health check', () => {
    const r = parseRecipe(p5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const local = r.recipe.environments[0];
    expect(local).toMatchObject({
      name: 'local',
      targets: ['p5-local'],
      script: 'scripts/local.sh',
      args: ['${checkout}'],
      triggers: ['after_merge'],
      timeoutSec: 3600,
      health: { kind: 'log', regex: 'P5 DEPLOY READY' },
      secrets: ['P5_ADMIN_PASSWORD'],
      envFile: '~/.config/guildwise/p5/local.env',
      docker: true,
      releasedBy: 'auto',
      gate: 'none',
    });
    const prod = r.recipe.environments[1];
    expect(prod).toMatchObject({ name: 'production', targets: ['p5-prod'], releasedBy: 'owner' });
    expect(typeof prod?.gate).toBe('object');
  });

  it('defaults the releaser to the release queue: the CEO is never the releaser unless the recipe says so', () => {
    const r = parseRecipe('version: 1\nenvironments:\n  - { name: prod, target: t, script: scripts/p.sh }\n');
    expect(r.ok && r.recipe.environments[0]?.releasedBy).toBe('owner');
    const ceo = parseRecipe(
      'version: 1\nenvironments:\n  - { name: prod, target: t, script: scripts/p.sh, releasedBy: ceo }\n',
    );
    expect(ceo.ok && ceo.recipe.environments[0]?.releasedBy).toBe('ceo');
  });

  it.each([
    ['a missing target', 'version: 1\nenvironments:\n  - { name: a, script: scripts/a.sh }\n'],
    [
      'both target and targets',
      'version: 1\nenvironments:\n  - { name: a, target: t, targets: [u], script: scripts/a.sh }\n',
    ],
    ['an absolute script path', 'version: 1\nenvironments:\n  - { name: a, target: t, script: /bin/sh }\n'],
    ['a path that climbs out', 'version: 1\nenvironments:\n  - { name: a, target: t, script: ../x.sh }\n'],
    [
      'a lower-case secret name',
      'version: 1\nenvironments:\n  - { name: a, target: t, script: s.sh, secrets: [token] }\n',
    ],
    [
      'an unknown releaser',
      'version: 1\nenvironments:\n  - { name: a, target: t, script: s.sh, releasedBy: everyone }\n',
    ],
    [
      'the same environment twice',
      'version: 1\nenvironments:\n  - { name: a, target: t, script: s.sh }\n  - { name: a, target: t, script: s.sh }\n',
    ],
    ['text that is not yaml', 'version: 1\n  environments: [\n'],
  ])('refuses %s', (_n, text) => {
    expect(parseRecipe(text).ok).toBe(false);
  });

  it('templates: known variables expand, unknown ones are reported', () => {
    expect(expandTemplate('${checkout}/x ${commit}', { checkout: '/w', commit: 'abc' })).toBe('/w/x abc');
    expect(unknownTemplateVars('${checkout} ${nope}')).toEqual(['nope']);
  });

  it('presets resolve by name, inline gates stand alone, a missing preset is null', () => {
    expect(resolveGate({ gate: 'none' }, {})).toEqual({ requires: [] });
    expect(resolveGate({ gate: 'standard' }, {})).toBeNull();
    expect(resolveGate({ gate: 'standard' }, { standard: { requires: [], freeze: true } })).toEqual({
      requires: [],
      freeze: true,
    });
  });

  it('the exec payload pins the approved hash', () => {
    const p = DeployExecPayloadSchema.safeParse({
      runId: '019da000-0000-7000-8000-000000000001',
      orgId: '019da000-0000-7000-8000-000000000002',
      projectId: '019da000-0000-7000-8000-000000000003',
      projectKey: 'P5',
      vault: { vaultId: 'v', storage: 'git', folder: 'projects/p5' },
      vaultCommit: 'abc1234',
      hash: 'a'.repeat(64),
      env: 'local',
      target: { id: null, name: 'p5-local', kind: 'local_docker', host: null, appUrl: null },
      commit: null,
      repo: null,
      expiresAt: new Date().toISOString(),
    });
    expect(p.success).toBe(true);
    expect(DeployExecPayloadSchema.safeParse({ hash: 'short' }).success).toBe(false);
  });
});

describe('the recipe lint (docs section 9.4)', () => {
  const files = [
    { path: 'recipe.yaml', mode: '644' as const },
    { path: 'scripts/local.sh', mode: '755' as const },
    { path: 'scripts/smoke-local.sh', mode: '755' as const },
    { path: 'scripts/production.sh', mode: '755' as const },
  ];
  const recipe = (() => {
    const r = parseRecipe(p5);
    if (!r.ok) throw new Error(r.error);
    return r.recipe;
  })();

  it('passes the P5 fixture', () => {
    const l = lintRecipe({
      recipe,
      files,
      targets: [
        { name: 'p5-local', production: false },
        { name: 'p5-prod', production: true },
      ],
      presets: [],
    });
    expect(l.filter((x) => x.level === 'error')).toEqual([]);
  });

  it('flags a missing or non-executable script, an unknown target, an unknown preset and a secret in a file', () => {
    const r = parseRecipe(
      'version: 1\nenvironments:\n  - { name: a, target: nope, script: scripts/a.sh, gate: standard }\n  - { name: b, target: t, script: scripts/b.sh }\n',
    );
    if (!r.ok) throw new Error(r.error);
    const l = lintRecipe({
      recipe: r.recipe,
      files: [
        { path: 'scripts/b.sh', mode: '644' },
        { path: 'scripts/x.sh', mode: '755', secret: 'a private key' },
      ],
      targets: [{ name: 't', production: false }],
      presets: [],
    });
    const codes = l.map((x) => x.code).sort();
    expect(codes).toEqual([
      'missing_script',
      'not_executable',
      'secret_in_file',
      'unknown_preset',
      'unknown_target',
    ]);
    expect(lintHasErrors(l)).toBe(true);
  });

  it('refuses an automatic production environment with no gate; the Owner or the CEO as releaser is fine', () => {
    const mk = (extra: string) => {
      const r = parseRecipe(
        `version: 1\nenvironments:\n  - { name: p, target: prod, script: scripts/p.sh${extra} }\n`,
      );
      if (!r.ok) throw new Error(r.error);
      return lintRecipe({
        recipe: r.recipe,
        files: [{ path: 'scripts/p.sh', mode: '755' }],
        targets: [{ name: 'prod', production: true }],
        presets: [],
      });
    };
    expect(mk(', releasedBy: auto').map((x) => x.code)).toEqual(['production_no_gate']);
    expect(mk('')).toEqual([]);
    expect(mk(', releasedBy: ceo')).toEqual([]);
  });

  it('finds secrets in content without returning them', () => {
    expect(findSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nabc')).toBe('a private key');
    expect(findSecret('export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('a GitHub token');
    expect(findSecret('password = "correct-horse-battery"')).toBe('a hard-coded credential');
    expect(findSecret('echo "${P5_ADMIN_PASSWORD}"')).toBeNull();
    expect(findSecret(readFileSync(join(FIXTURE, 'scripts', 'local.sh'), 'utf8'))).toBeNull();
  });
});

describe('the bundle hash (docs section 9.4)', () => {
  const e = (path: string, sha: string, mode: '755' | '644' = '644') => ({ path, mode, sha256: sha });
  it('does not depend on order, and changes with content, path or the executable bit', () => {
    const a = e('recipe.yaml', '1'.repeat(64));
    const b = e('scripts/x.sh', '2'.repeat(64), '755');
    expect(bundleHash([a, b])).toBe(bundleHash([b, a]));
    expect(bundleHash([a, b])).toHaveLength(64);
    expect(bundleHash([a, e('scripts/x.sh', '3'.repeat(64), '755')])).not.toBe(bundleHash([a, b]));
    expect(bundleHash([a, e('scripts/y.sh', '2'.repeat(64), '755')])).not.toBe(bundleHash([a, b]));
    expect(bundleHash([a, e('scripts/x.sh', '2'.repeat(64), '644')])).not.toBe(bundleHash([a, b]));
  });
});

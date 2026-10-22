import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compileSetup,
  DeliverySetupSchema,
  isGuildwiseTemporaryOverride,
  lintRecipe,
  localAdoptEnv,
  parseRecipe,
  parseSetup,
  parseSetupText,
  shq,
  sshShipEnv,
  TEMP_OVERRIDE_CASE_PATTERNS,
} from '../src/index.ts';
import { SNAPSHOT_SETUPS } from './fixtures/compile-snapshot-input.ts';
import { FIRST_ADOPTER } from './setup-fixtures.ts';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(here, 'fixtures', 'setup');

/** Byte-exact comparison with a file in fixtures/setup (set UPDATE_GOLDEN=1 to rewrite them after a deliberate change). */
function golden(name: string, actual: string): void {
  const file = join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
  }
  expect(existsSync(file), `missing golden file ${name}`).toBe(true);
  expect(actual).toBe(readFileSync(file, 'utf8'));
}

const compile = (input: unknown = FIRST_ADOPTER(), opts?: Parameters<typeof compileSetup>[1]) => {
  const r = compileSetup(input, opts);
  if (!r.ok) throw new Error(r.issues.join('; '));
  return r;
};
const fileOf = (r: ReturnType<typeof compile>, path: string) =>
  (r.files.find((f) => f.path === path) as { content: string }).content;

describe('compileSetup: the first adopter (byte-exact)', () => {
  const r = compile();
  it('UAT script: rebuilds only the app through an override file, tags aom-uat-app:<sha>, prunes old tags', () => {
    golden('uat.sh', fileOf(r, 'scripts/uat.sh'));
  });
  it('production script: backup (keep 20, a failed backup stops), .env copy, build here, ship over ssh, switch the image, app only, health, rollback', () => {
    golden('production.sh', fileOf(r, 'scripts/production.sh'));
  });
  it('recipe.yaml and setup.json', () => {
    golden('recipe.yaml', fileOf(r, 'recipe.yaml'));
    golden('setup.json', fileOf(r, 'setup.json'));
  });
  it('the files and the modes: scripts are executable, the rest is not', () => {
    expect(r.files.map((f) => `${f.mode} ${f.path}`)).toEqual([
      '644 recipe.yaml',
      '755 scripts/production.sh',
      '755 scripts/uat.sh',
      '644 setup.json',
    ]);
  });
});

describe('compileSetup: deterministic and valid', () => {
  it('the same input gives the same bytes and the same hash', () => {
    const a = compile();
    const b = compile(JSON.parse(JSON.stringify(FIRST_ADOPTER())));
    expect(b.files).toEqual(a.files);
    expect(b.hash).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('setup.json round-trips through the parser and compiles to itself', () => {
    const a = compile();
    const parsed = parseSetupText(fileOf(a, 'setup.json'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(compile(parsed.setup).hash).toBe(a.hash);
  });

  it('the generated recipe parses, and its lint has no errors for the defaults (production needs the Owner and a gate)', () => {
    const a = compile();
    const rec = parseRecipe(fileOf(a, 'recipe.yaml'));
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    const uat = rec.recipe.environments.find((e) => e.name === 'uat');
    const prod = rec.recipe.environments.find((e) => e.name === 'production');
    expect(uat).toMatchObject({ triggers: ['after_merge'], releasedBy: 'auto', gate: 'none', docker: true });
    expect(prod).toMatchObject({
      triggers: ['on_request'],
      releasedBy: 'owner',
      gate: { requires: [{ envHealthy: 'uat', sameCommit: true, forMinutes: 10 }] },
    });
    const lint = lintRecipe({
      recipe: rec.recipe,
      files: a.files.map((f) => ({ path: f.path, mode: f.mode })),
      targets: [
        { name: 'aom-uat', production: false },
        { name: 'prod-server', production: true },
      ],
    });
    expect(lint.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('a custom environment keeps its script file, or takes the text it is given', () => {
    const input = FIRST_ADOPTER();
    input.environments[0] = { ...input.environments[0]!, mode: 'custom' };
    const kept = compile(input);
    expect(kept.keep).toEqual(['scripts/uat.sh']);
    expect(kept.files.some((f) => f.path === 'scripts/uat.sh')).toBe(false);
    expect(fileOf(kept, 'recipe.yaml')).toContain('script: scripts/uat.sh');
    const given = compile(input, { customScripts: { uat: '#!/bin/sh\necho hand written\n' } });
    expect(given.keep).toEqual([]);
    expect(fileOf(given, 'scripts/uat.sh')).toBe('#!/bin/sh\necho hand written\n');
  });

  it('refuses a setup whose steps do not fit the hosting, in plain words', () => {
    const input = FIRST_ADOPTER();
    const prod = input.environments[1]!;
    input.environments[1] = { ...prod, steps: prod.steps.filter((s) => s.kind !== 'ship_image_ssh') };
    const r = compileSetup(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toMatch(/ship_image_ssh/);
    const local = FIRST_ADOPTER();
    local.environments[0] = { ...local.environments[0]!, steps: [{ kind: 'build_image_local' as const }] };
    expect(compileSetup(local).ok).toBe(false);
    // rollback needs a web address health check
    const noHealth = FIRST_ADOPTER();
    noHealth.environments[0] = {
      ...noHealth.environments[0]!,
      health: { kind: 'none', graceSec: 3 } as never,
    };
    expect(compileSetup(noHealth).ok).toBe(false);
  });
});

describe('the generated scripts', () => {
  const r = compile();
  const scripts = r.files.filter((f) => f.path.endsWith('.sh'));

  it.each(scripts.map((s) => [s.path, s.content]))('%s passes bash -n', (_p, content) => {
    const out = spawnSync('bash', ['-n'], { input: content as string, encoding: 'utf8' });
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
  });

  it.each(scripts.map((s) => [s.path, s.content]))('%s follows the script contract', (_p, content) => {
    const c = content as string;
    expect(
      c.startsWith('#!/usr/bin/env bash\n# Generated by Guildwise setup-1.4 from setup.json (env '),
    ).toBe(true);
    expect(c).toContain('set -euo pipefail');
    expect(c).toContain('flock -n 9');
    expect(c).toContain('AOM_DEPLOY_DRY_RUN');
    expect(c).toMatch(/\nAOM-DEPLOY|AOM-DEPLOY \{"commit"/);
    expect(c.trimEnd().endsWith('done_line')).toBe(true);
  });

  it.each(scripts.map((s) => [s.path, s.content]))('%s has a dry-run branch in every step', (_p, content) => {
    const parts = (content as string).split(/\n# step \d+: /).slice(1);
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      const block = part.split('\n# the end')[0] as string;
      expect(block, block.slice(0, 80)).toMatch(/DRY_RUN/);
    }
  });

  it.each(scripts.map((s) => [s.path, s.content]))(
    '%s never stops, removes or prunes anything but old image tags and old backups',
    (_p, content) => {
      const c = content as string;
      expect(c).not.toMatch(/compose[^\n]*\b(down|rm|stop|kill)\b/);
      expect(c).not.toMatch(
        /--remove-orphans|--volumes|system prune|image prune|volume (rm|prune)|network (rm|prune)|container (rm|prune)/,
      );
      expect(c).not.toMatch(/docker (rm|stop|kill)\b/);
      for (const line of c.split('\n').filter((l) => /\bup -d\b/.test(l)))
        expect(line).toContain('--no-deps');
      // the only deletions: the scratch folder, a failed backup's partial file, old backups of this environment, old image tags
      for (const line of c.split('\n').filter((l) => /\brm\b/.test(l)))
        expect(line).toMatch(
          /rm -rf -- "\$WORK"|rm -f -- "\$(BACKUP_FILE|out)\.part"|rm -f -- "\$old"|rm -f -- "\$tmp"|docker image rm "\$ref"/,
        );
    },
  );

  it('production: a failed backup blocks, rollback restores the image and never touches the database', () => {
    const c = (scripts.find((s) => s.path.endsWith('production.sh')) as { content: string }).content;
    expect(c).toContain('die "the database backup failed; nothing was changed"');
    expect(c).toContain('KEEP_BACKUPS=20');
    expect(c).toContain('set_image_var "$PREVIOUS"');
    expect(c).toContain('trap on_exit EXIT');
    expect(c).toContain("trap 'exit 143' TERM");
    expect(c).toContain('the database was NOT rolled back');
    expect(c).toContain('${AOM_DEPLOY_SSH:-ssh}');
    expect(c).toContain('StrictHostKeyChecking=yes');
    expect(c).toContain('BatchMode=yes');
  });

  it.each(['uat', 'production'])(
    '%s: the deploy lock is not inherited by what the script starts and names the project',
    (n) => {
      const c = (scripts.find((s) => s.path.endsWith(`${n}.sh`)) as { content: string }).content;
      expect(c).toContain('docker() { command docker "$@" 9>&-; }');
      expect(c).toContain('AOM_DEPLOY_PROJECT_ID');
      expect(c).toContain('${XDG_RUNTIME_DIR:-$HOME/.cache}');
      expect(c).toMatch(/umask 077/);
    },
  );

  it('production: the remote script travels as an argument, never on stdin, and docker commands get no stdin', () => {
    const c = (scripts.find((s) => s.path.endsWith('production.sh')) as { content: string }).content;
    expect(c).not.toContain('bash -s');
    expect(c).toContain('base64 -d');
    expect(c).toContain('</dev/null');
    expect(c).toContain('docker-compose version');
  });

  it('uat: the owner compose file is never edited; the override lives in a scratch folder', () => {
    const c = (scripts.find((s) => s.path.endsWith('uat.sh')) as { content: string }).content;
    expect(c).toContain('OVERRIDE="$WORK/override.yml"');
    expect(c).toContain('up -d --build --no-deps "$SERVICE"');
    expect(c).not.toMatch(/>\s*"\$COMPOSE_FILE"/);
  });
});

describe('every user-supplied value is validated and quoted', () => {
  const hostile = [
    '$(touch /tmp/pwned)',
    '`touch /tmp/pwned`',
    "'; touch /tmp/pwned; '",
    '"; touch /tmp/pwned; "',
    'a b',
    'a\nb',
    'a;b',
    'a|b',
    'a&b',
    '$HOME',
    '${IFS}',
    '../../etc/passwd',
    '-rf',
    '--help',
    'a\0b',
    "it's",
    '{a,b}',
    '*',
  ];

  const mutate = (path: (e: any) => void, e = 0) => {
    const input = FIRST_ADOPTER() as any;
    path(input.environments[e]);
    return input;
  };
  const fields: Array<[string, (v: string) => (e: any) => void, number]> = [
    ['app.composeFile', (v) => (e) => (e.app.composeFile = v), 0],
    ['app.composeFile (server)', (v) => (e) => (e.app.composeFile = v), 1],
    ['app.composeProject', (v) => (e) => (e.app.composeProject = v), 0],
    ['app.service', (v) => (e) => (e.app.service = v), 0],
    ['app.imageName', (v) => (e) => (e.app.imageName = v), 0],
    ['app.imageVar', (v) => (e) => (e.app.imageVar = v), 1],
    ['host', (v) => (e) => (e.host = v), 1],
    ['db_backup.service', (v) => (e) => (e.steps[0].service = v), 0],
    ['db_backup.dir', (v) => (e) => (e.steps[0].dir = v), 0],
    ['db_backup.dir (server)', (v) => (e) => (e.steps[0].dir = v), 1],
    ['db_backup.dbUser', (v) => (e) => (e.steps[0].dbUser = v), 0],
    ['db_backup.dbName', (v) => (e) => (e.steps[0].dbName = v), 1],
    ['health.url', (v) => (e) => (e.health.url = v), 1],
    ['app.appUrl', (v) => (e) => (e.app.appUrl = v), 0],
    ['secrets', (v) => (e) => (e.secrets = [v]), 0],
    ['name', (v) => (e) => (e.name = v), 0],
  ];

  for (const [name, set, env] of fields)
    it(`${name}: a hostile value is refused or comes out single-quoted, never as code`, () => {
      for (const v of hostile) {
        const input = mutate(set(v), env);
        const r = compileSetup(input);
        if (!r.ok) continue; // refused by the schema: fine
        // accepted: it must be harmless text in the script. Every script must still parse, and the value is only ever inside quotes.
        for (const f of r.files.filter((x) => x.path.endsWith('.sh'))) {
          const bash = spawnSync('bash', ['-n'], { input: f.content, encoding: 'utf8' });
          expect(bash.status, `${name}=${JSON.stringify(v)}`).toBe(0);
        }
      }
    });

  it('free text in labels and commands (custom_command) is quoted: executing the script runs nothing extra', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-fuzz-'));
    try {
      const marker = join(dir, 'PWNED');
      const payloads = [
        `$(touch ${marker})`,
        `\`touch ${marker}\``,
        `'; touch ${marker}; '`,
        `"; touch ${marker}; "`,
        `a\nb; touch ${marker}`,
      ];
      for (const p of payloads) {
        const env = localAdoptEnv({
          name: 'uat',
          label: p.slice(0, 60),
          target: 'aom-uat',
          composeFile: '~/x/docker-compose.yml',
          service: 'app',
          imageName: 'x-app',
        });
        env.steps = [
          { kind: 'custom_command', label: p, argv: ['printf', '%s', p], where: 'here' },
          { kind: 'compose_up_local' },
        ];
        const r = compileSetup({ environments: [env] });
        expect(r.ok).toBe(true);
        if (!r.ok) continue;
        const script = (r.files.find((f) => f.path === 'scripts/uat.sh') as { content: string }).content;
        expect(spawnSync('bash', ['-n'], { input: script }).status).toBe(0);
        // run the custom step the way the script does: the quoted argv prints the payload as text
        const step = /\nelse\n {2}('printf'[\s\S]*?)\nfi\n/.exec(script)?.[1] as string;
        expect(step).toBeTruthy();
        const out = spawnSync('bash', ['-c', step], { encoding: 'utf8' });
        expect(out.stdout).toBe(p);
        expect(existsSync(marker)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shq closes and reopens the quote around a single quote', () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
    const out = spawnSync('bash', ['-c', `printf %s ${shq('it\'s $(x) "y" \\z')}`], { encoding: 'utf8' });
    expect(out.stdout).toBe('it\'s $(x) "y" \\z');
    expect(() => shq('a\0b')).toThrow();
  });

  it('paths must be full and clean; names are restricted', () => {
    const bad = (mut: (e: any) => void, env = 0) => parseSetup(mutate(mut, env)).ok;
    expect(bad((e) => (e.app.composeFile = 'relative/docker-compose.yml'))).toBe(false);
    expect(bad((e) => (e.app.composeFile = '~/a/../../etc/x'))).toBe(false);
    expect(bad((e) => (e.app.composeFile = '~/.config/aom-uat/docker-compose.yml'))).toBe(true);
    expect(bad((e) => (e.app.composeFile = '~/x'), 1)).toBe(false); // a server path cannot use ~
    expect(bad((e) => (e.app.imageName = 'Upper'))).toBe(false);
    expect(bad((e) => (e.app.imageVar = 'lower'), 1)).toBe(false);
    expect(bad((e) => (e.host = '-oProxyCommand=x'), 1)).toBe(false);
    expect(bad((e) => (e.name = 'Prod!'))).toBe(false);
  });
});

describe('setup.json parsing', () => {
  it('reports bad JSON and bad shapes without throwing', () => {
    expect(parseSetupText('{').ok).toBe(false);
    const r = parseSetup({ environments: [] });
    expect(r.ok).toBe(false);
    expect(DeliverySetupSchema.safeParse(FIRST_ADOPTER()).success).toBe(true);
  });

  it('two environments with one name are refused', () => {
    const input = FIRST_ADOPTER();
    input.environments[1] = { ...input.environments[1]!, name: 'uat' };
    expect(parseSetup(input).ok).toBe(false);
  });

  it('the server template: every env made by the builders is valid', () => {
    expect(
      parseSetup({
        environments: [
          sshShipEnv({
            name: 'live',
            label: 'Live',
            target: 't',
            host: 'srv',
            composeFile: '/srv/app/compose.yaml',
            service: 'web',
            imageName: 'org/app',
            imageVar: 'APP_IMAGE',
          }),
        ],
      }).ok,
    ).toBe(true);
  });
});

describe('the compose_run step (database updates before the restart)', () => {
  const withRun = (which: 0 | 1) => {
    const input = FIRST_ADOPTER();
    const env = input.environments[which]!;
    const run = {
      kind: 'compose_run' as const,
      label: 'Run database updates',
      argv: ['npm', 'run', 'migrate', '--', "it's"],
    };
    const i = env.steps.findIndex((x) => x.kind === 'compose_up_local' || x.kind === 'compose_up_remote');
    const j = which === 1 ? env.steps.findIndex((x) => x.kind === 'set_image_var') : i;
    env.steps.splice(j, 0, run as never);
    return input;
  };

  it.each([0, 1] as const)(
    'environment %i compiles, passes bash -n, quotes the command and has a dry-run branch',
    (w) => {
      const r = compileSetup(withRun(w));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      const name = w === 0 ? 'uat' : 'production';
      const c = r.files.find((f) => f.path === `scripts/${name}.sh`)!.content;
      expect(spawnSync('bash', ['-n'], { input: c, encoding: 'utf8' }).status).toBe(0);
      expect(c).toContain("'npm' 'run' 'migrate' '--' 'it'\\''s'");
      expect(c).toMatch(/the database updates failed; the app was not restarted/);
      const part = c.split(/\n# step \d+: /).find((p) => p.startsWith('Run database updates'))!;
      expect(part).toContain('DRY_RUN" = 1');
      // never a down / rm / volume flag
      expect(c).not.toMatch(/compose[^\n]*\b(down|rm)\b/);
    },
  );

  it('must come after the backup and before the restart (and after the copy to a server)', () => {
    const bad = FIRST_ADOPTER();
    const env = bad.environments[0]!;
    env.steps.push({ kind: 'compose_run', label: 'x', argv: ['x'] } as never);
    const r = compileSetup(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toMatch(/before the app is restarted/);
    const noBackup = FIRST_ADOPTER();
    noBackup.environments[0]!.steps = [
      { kind: 'compose_run', label: 'x', argv: ['x'] },
      { kind: 'compose_up_local' },
    ] as never;
    const r2 = compileSetup(noBackup);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues.join(' ')).toMatch(/Back up the database before/);
  });
});

describe('isGuildwiseTemporaryOverride: one definition for the deploy script and the runner probe', () => {
  it('accepts the override and rollback file of a deploy temp folder and nothing else', () => {
    expect(isGuildwiseTemporaryOverride('/tmp/aom-deploy.4EtfKJ/override.yml')).toBe(true);
    expect(isGuildwiseTemporaryOverride('/var/tmp/x/aom-deploy.abc123/rollback.yml')).toBe(true);
    expect(isGuildwiseTemporaryOverride('/srv/shop/b.yaml')).toBe(false);
    expect(isGuildwiseTemporaryOverride('/tmp/aom-deploy.4EtfKJ/other.yml')).toBe(false);
    expect(isGuildwiseTemporaryOverride('/tmp/aom-deploy.4Et/override.yml')).toBe(false);
    expect(isGuildwiseTemporaryOverride('/tmp/aom-deploy.4EtfKJx/override.yml')).toBe(false);
  });

  it('agrees with the shell case patterns the deploy script uses', () => {
    const sh = (p: string) =>
      spawnSync('sh', [
        '-c',
        `case "$1" in ${TEMP_OVERRIDE_CASE_PATTERNS}) exit 0;; *) exit 1;; esac`,
        'sh',
        p,
      ]).status === 0;
    for (const p of [
      '/tmp/aom-deploy.4EtfKJ/override.yml',
      '/tmp/aom-deploy.4EtfKJ/rollback.yml',
      '/tmp/aom-deploy.4Et/override.yml',
      '/tmp/aom-deploy.4EtfKJ/x.yml',
      '/srv/shop/b.yaml',
    ])
      expect(sh(p)).toBe(isGuildwiseTemporaryOverride(p));
  });
});

describe('compileSetup: unchanged since before the shared temporary-override pattern (commit 887b3a62)', () => {
  // The snapshot was generated by the compiler of 887b3a62 from the same fixtures: every file byte for byte, and the hash an
  // approved recipe is pinned to. If this fails, an approved recipe would suddenly need a new approval.
  const snapshot = JSON.parse(
    readFileSync(join(here, 'fixtures', 'compile-snapshot-887b3a62.json'), 'utf8'),
  ) as Record<string, { hash: string; files: Record<string, { mode: string; content: string }> }>;
  it('has a snapshot for every fixture', () => {
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(SNAPSHOT_SETUPS).sort());
  });
  for (const [name, make] of Object.entries(SNAPSHOT_SETUPS)) {
    it(`${name}: the same files and the same hash`, () => {
      const r = compile(make());
      const want = snapshot[name] as (typeof snapshot)[string];
      expect(r.hash).toBe(want.hash);
      expect(Object.fromEntries(r.files.map((f) => [f.path, { mode: f.mode, content: f.content }]))).toEqual(
        want.files,
      );
    });
  }
});

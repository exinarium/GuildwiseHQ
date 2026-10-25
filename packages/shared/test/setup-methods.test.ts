import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileSetup, parseSetup, sshShipEnv, updateMethodOf } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(here, 'fixtures', 'setup', 'methods');

function golden(name: string, actual: string): void {
  const file = join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
  }
  expect(existsSync(file), `missing golden file ${name}`).toBe(true);
  expect(actual).toBe(readFileSync(file, 'utf8'));
}

/** The owner's case: a compose stack in a home folder with a literal image tag and no .env variable. */
const base = {
  name: 'production',
  label: 'Live site',
  target: 'flow5-server',
  host: 'flow5-server',
  composeFile: '/home/administrator/demo/flow5-full/compose.yaml',
  composeProject: 'demo-flow5-remote',
  service: 'demo-server',
  imageName: 'demo-server',
  healthUrl: 'http://192.168.1.13:5500/ready',
  database: { service: 'postgres', dir: '/home/administrator/demo/flow5-full/backups' },
};
const cases = {
  copy: () => sshShipEnv({ ...base }),
  'copy-envvar': () => sshShipEnv({ ...base, imageVar: 'DEMO_IMAGE' }),
  registry: () => sshShipEnv({ ...base, method: 'registry', registry: '192.168.1.11:5000' }),
  'registry-ci': () =>
    sshShipEnv({ ...base, method: 'registry', registry: '192.168.1.11:5000', registryPush: false }),
  'build-on-server': () => sshShipEnv({ ...base, method: 'build_on_server' }),
} as const;

const compile = (env: unknown) => {
  const r = compileSetup({ environments: [env] });
  if (!r.ok) throw new Error(r.issues.join('; '));
  return r;
};
const script = (r: ReturnType<typeof compile>) =>
  (r.files.find((f) => f.path === 'scripts/production.sh') as { content: string }).content;

describe('update methods for a server (golden files)', () => {
  it.each(Object.keys(cases))('%s: byte-exact, valid bash, only the app is restarted', (k) => {
    const c = script(compile(cases[k as keyof typeof cases]()));
    golden(`${k}.sh`, c);
    expect(spawnSync('bash', ['-n'], { input: c, encoding: 'utf8' }).status).toBe(0);
    expect(c).not.toMatch(
      /compose[^\n]*\b(down|rm|stop|kill)\b|--remove-orphans|--volumes|prune|docker (rm|stop|kill)\b/,
    );
    for (const line of c.split('\n').filter((l) => /\bup -d\b/.test(l))) expect(line).toContain('--no-deps');
    // the database is backed up first and a failed backup stops everything
    expect(c.indexOf('# step 1: back up the database')).toBeGreaterThan(0);
    expect(c).toContain('die "the database backup failed; nothing was changed"');
    expect(c).toContain('trap on_exit EXIT');
    // every step has a dry-run branch
    for (const part of c.split(/\n# step \d+: /).slice(1))
      expect(part.split('\n# the end')[0], part.slice(0, 60)).toMatch(/DRY_RUN|dry/);
  });

  it('no variable: the user’s compose file and .env are never edited, an override names the image', () => {
    const c = script(compile(cases.copy()));
    expect(c).toContain('docker-compose.guildwise.yml');
    expect(c).not.toContain('set_image_var');
    expect(c).not.toContain('.env.bak');
    expect(c).toContain('rollback_override "$PREVIOUS"');
    expect(c).toContain('remove_override()');
    expect(c).toContain('--no-build');
    expect(c).toContain('if [ "$RUNNING_IMAGE" = "$TAG" ] && healthy; then');
  });

  it('a variable: the original script is unchanged', () => {
    const c = script(compile(cases['copy-envvar']()));
    expect(c).toContain('set_image_var "$PREVIOUS"');
    expect(c).not.toContain('guildwise.yml');
  });

  it('registry: the image carries the registry address; CI mode never builds or pushes', () => {
    const c = script(compile(cases.registry()));
    expect(c).toContain(`TAG="$REGISTRY/$TAG"`);
    expect(c).toContain('docker push "$TAG"');
    expect(c).toContain('docker pull');
    const ci = script(compile(cases['registry-ci']()));
    expect(ci).not.toContain('docker push');
    expect(ci).not.toContain('docker build');
  });

  it('build on the server: files are copied, nothing is pulled from git there', () => {
    const c = script(compile(cases['build-on-server']()));
    expect(c).toContain('git -C "$CHECKOUT" archive');
    expect(c).toContain('build_image_server'.length ? 'build "$svc"' : '');
    expect(c).not.toContain('docker save');
  });

  it('methods are derived from the steps', () => {
    expect(updateMethodOf(cases.copy())).toBe('ship');
    expect(updateMethodOf(cases.registry())).toBe('registry');
    expect(updateMethodOf(cases['build-on-server']())).toBe('build_on_server');
  });

  it('wrong combinations are refused in plain words', () => {
    const noRegistry = cases.registry();
    delete (noRegistry.app as { registry?: string }).registry;
    expect(parseSetup({ environments: [noRegistry] }).ok).toBe(false);
    const mixed = cases.copy();
    mixed.steps.splice(2, 0, { kind: 'set_image_var' });
    const r = compileSetup({ environments: [mixed] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toMatch(/override/);
    const swapped = cases['build-on-server']();
    swapped.steps.reverse();
    expect(compileSetup({ environments: [swapped] }).ok).toBe(false);
  });
});

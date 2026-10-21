import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileSetup, isOlderGenerator, SETUP_GENERATOR } from '../src/index.ts';
import { FIRST_ADOPTER } from './setup-fixtures.ts';

// v2 review fixes in the generated scripts (M4, M5, m8, m9, m10).
const compile = (input: unknown = FIRST_ADOPTER()) => {
  const r = compileSetup(input);
  if (!r.ok) throw new Error(r.issues.join('; '));
  return r;
};
const script = (r: ReturnType<typeof compile>, name: string) =>
  (r.files.find((f) => f.path === `scripts/${name}.sh`) as { content: string }).content;

describe('generated scripts, v2 review', () => {
  const r = compile();
  const prod = script(r, 'production');
  it('is generator 1.4, so older stored setups show "improved steps available"', () => {
    expect(SETUP_GENERATOR).toBe('setup-1.4');
    expect(prod).toContain('setup-1.4');
    // a stored 1.3 setup is an "improved version is available", never a hand edit
    expect(isOlderGenerator('setup-1.3')).toBe(true);
    expect(isOlderGenerator('setup-1.4')).toBe(false);
  });
  it('M4: the health address must be a web address before anything changes', () => {
    const at = prod.indexOf('[[ "$HEALTH_URL" =~ ^https?:// ]] || die');
    expect(at).toBeGreaterThan(0);
    // before the lock, the first remote call and the first step
    expect(at).toBeLessThan(prod.indexOf('flock -n 9'));
    expect(at).toBeLessThan(prod.indexOf('# step 1'));
    expect(script(r, 'uat')).toContain('[[ "$HEALTH_URL" =~ ^https?:// ]] || die');
  });
  it('M4: a health check on ${appUrl} without an app address is refused when compiling', () => {
    const bad = FIRST_ADOPTER() as { environments: Array<{ app: Record<string, unknown>; name: string }> };
    const uat = bad.environments[0] as { app: Record<string, unknown> };
    delete uat.app.appUrl;
    const c = compileSetup(bad);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.issues.join(' ')).toContain('no app address is set');
  });
  it('M5: prints the engine and compose versions and warns about compose v1 on engine 25 or newer', () => {
    expect(prod).toContain('say "server tools: docker engine');
    expect(prod).toContain('ContainerConfig');
    expect(prod).toMatch(/v1\*\)/);
    // never works around it by removing or recreating anything
    expect(prod).not.toMatch(/rm -sf|compose[^\n]* down( |$)/);
  });
  it('m8: the quick ssh calls read /dev/null; the image copy still pipes into ssh', () => {
    expect(prod).toContain("rsh 'true' </dev/null");
    expect(prod).toContain('docker save "$TAG" | gzip | rsh');
  });
  it('m9: the version to go back to is the one that RUNS, not only the settings file value', () => {
    expect(prod).toContain('PREVIOUS="${RUNNING_IMAGE:-$CURRENT_IMAGE}"');
  });
});

describe('m10: switching the image line keeps CRLF line ends', () => {
  const prod = script(compile(), 'production');
  const m = /VAR="\$var" VAL="\$val" awk '([\s\S]*?)' "\$envf" > "\$tmp"/.exec(prod);
  const prog = m?.[1] as string;
  const run = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-awk-'));
    try {
      writeFileSync(join(dir, '.env'), text);
      const r = spawnSync('awk', [prog, join(dir, '.env')], {
        encoding: 'utf8',
        env: { ...process.env, VAR: 'APP_IMAGE', VAL: 'app:new' },
      });
      return r.stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  it('replaces the line and keeps the file as it was', () => {
    expect(prog).toBeTruthy();
    expect(run('A=1\r\nAPP_IMAGE=app:old\r\nB=2\r\n')).toBe('A=1\r\nAPP_IMAGE=app:new\r\nB=2\r\n');
    expect(run('A=1\nAPP_IMAGE=app:old\nB=2\n')).toBe('A=1\nAPP_IMAGE=app:new\nB=2\n');
  });
  it('appends the line with the same ending when it is not there', () => {
    expect(run('A=1\r\nB=2\r\n')).toBe('A=1\r\nB=2\r\nAPP_IMAGE=app:new\r\n');
    expect(run('A=1\nB=2\n')).toBe('A=1\nB=2\nAPP_IMAGE=app:new\n');
  });
});

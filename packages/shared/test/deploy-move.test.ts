import { describe, expect, it } from 'vitest';
import {
  buildMoveSpec,
  DeliverySetupSchema,
  DeployMovePayloadSchema,
  DeployMoveResultSchema,
  dnsVerdict,
  domainOfUrl,
  MOVE_ERRORS,
  MOVE_STEPS,
  moveErrorText,
  moveStateAfter,
  nextMoveStep,
  resumeStep,
  standbyName,
} from '../src/index.ts';
import { FIRST_ADOPTER } from './setup-fixtures.ts';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const prod = () => DeliverySetupSchema.parse(FIRST_ADOPTER()).environments[1]!;
const from = { targetId: T1, alias: 'prod-server' };
const to = { targetId: T2, alias: 'aom-new-shop' };

describe('buildMoveSpec: what the runner is told about the app comes from the approved setup', () => {
  it('takes the compose file, the app and database parts, the backup folder and the health path', () => {
    const r = buildMoveSpec(prod(), from, to);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec).toMatchObject({
      composeFile: '/opt/app/docker-compose.yml',
      appService: 'app',
      imageVar: 'GUILDWISE_IMAGE',
      dbService: 'postgres',
      backupDir: '/opt/app/backups',
      healthPath: '/ready',
    });
    expect(
      DeployMovePayloadSchema.safeParse({ projectId: T1, moveId: T2, step: 'check', spec: r.spec }).success,
    ).toBe(true);
  });
  it('refuses, in plain words, a setup it cannot move safely', () => {
    const custom = { ...prod(), mode: 'custom' as const };
    const a = buildMoveSpec(custom, from, to);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.blockers.join(' ')).toContain('edited by hand');
    const noBackup = { ...prod(), steps: prod().steps.filter((s) => s.kind !== 'db_backup') };
    const b = buildMoveSpec(noBackup, from, to);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.blockers.join(' ')).toContain('no database backup step');
    const local = DeliverySetupSchema.parse(FIRST_ADOPTER()).environments[0]!;
    const c = buildMoveSpec(local, from, to);
    expect(c.ok).toBe(false);
  });
  it('a path or service name with shell characters never reaches the spec', () => {
    const e = prod();
    e.app.composeFile = '/opt/x; rm -rf /';
    const r = buildMoveSpec(e, from, to);
    expect(r.ok).toBe(false);
  });
});

describe('the chain of steps', () => {
  it('prepares without touching the old server, waits for the person, then switches', () => {
    expect(nextMoveStep('check')).toBe('copy_config');
    expect(nextMoveStep('copy_config')).toBe('copy_image');
    expect(nextMoveStep('copy_image')).toBe('start_database');
    expect(nextMoveStep('start_database')).toBeNull();
    expect(moveStateAfter('start_database', true)).toBe('ready');
    expect(nextMoveStep('stop_and_backup')).toBe('restore');
    expect(nextMoveStep('restore')).toBe('start_app');
    expect(nextMoveStep('start_app')).toBeNull();
    expect(moveStateAfter('start_app', true)).toBe('app_ready');
    expect(moveStateAfter('restore', false)).toBe('failed');
  });
  it('a failed restore starts over from the backup (the old app was started again)', () => {
    expect(resumeStep('restore')).toBe('stop_and_backup');
    expect(resumeStep('start_app')).toBe('start_app');
  });
  it('every step and error has words', () => {
    for (const e of MOVE_ERRORS) expect(moveErrorText(e, 'some detail here').length).toBeGreaterThan(10);
    expect(MOVE_STEPS).toContain('retire_keys');
  });
});

describe('the answer of a step', () => {
  it('accepts facts but never an unknown (possibly secret) field', () => {
    const ok = DeployMoveResultSchema.safeParse({
      ok: true,
      step: 'check',
      facts: { image: 'x:1', appPort: 3000 },
    });
    expect(ok.success).toBe(true);
    const bad = DeployMoveResultSchema.safeParse({
      ok: true,
      step: 'copy_config',
      facts: { env: 'SECRET=1' },
    });
    expect(bad.success).toBe(false);
  });
});

describe('dnsVerdict', () => {
  const exp = ['203.0.113.9'];
  const old = ['198.51.100.7'];
  it('new, old, none, other, error', () => {
    expect(dnsVerdict('shop.example.com', ['203.0.113.9'], exp, old).state).toBe('new');
    expect(dnsVerdict('shop.example.com', ['198.51.100.7'], exp, old).state).toBe('old');
    expect(dnsVerdict('shop.example.com', [], exp, old).state).toBe('none');
    expect(dnsVerdict('shop.example.com', ['192.0.2.1'], exp, old).state).toBe('other');
    expect(dnsVerdict('shop.example.com', ['203.0.113.9', '198.51.100.7'], exp, old).state).toBe('other');
    expect(dnsVerdict('shop.example.com', [], exp, old, 'timeout').state).toBe('error');
  });
  it('tells the person what to change', () => {
    expect(dnsVerdict('shop.example.com', ['198.51.100.7'], exp, old).text).toContain('203.0.113.9');
  });
});

describe('small helpers', () => {
  it('domainOfUrl gives a real name only', () => {
    expect(domainOfUrl('https://hq.example.com/ready')).toBe('hq.example.com');
    expect(domainOfUrl('http://localhost:4700')).toBeNull();
    expect(domainOfUrl('http://203.0.113.9:3000')).toBeNull();
    expect(domainOfUrl(null)).toBeNull();
  });
  it('standbyName keeps names unique', () => {
    expect(standbyName('Live site')).toBe('Live site (old server)');
    expect(standbyName('Live site', ['live site (old server)'])).toBe('Live site (old server) 2');
  });
});

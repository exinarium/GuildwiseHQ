import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideStartup,
  type HostFacts,
  rootEquivalentReasons,
  writableByOthers,
} from '../src/policy/startup.ts';

const clean: HostFacts = {
  uid: 1001,
  passwordlessSudo: false,
  groups: ['guildwise-runner'],
  writableDockerSocket: null,
  writableByOthers: [],
};
const refusing = { startupRefusal: true, acceptRootEquivalent: false };
const warnOnly = { acceptRootEquivalent: false };

describe('the start-up check (R18-P, R21)', () => {
  it('names every root-equivalent property', () => {
    expect(rootEquivalentReasons({ ...clean, uid: 0 })).toEqual(['runs as root (uid 0)']);
    expect(rootEquivalentReasons({ ...clean, passwordlessSudo: true })[0]).toMatch(/sudo without a password/);
    expect(rootEquivalentReasons({ ...clean, groups: ['docker'] })[0]).toMatch(/docker group/);
    expect(rootEquivalentReasons({ ...clean, writableDockerSocket: '/var/run/docker.sock' })[0]).toMatch(
      /Docker socket/,
    );
  });

  it('refuses under uid 0, passwordless sudo, the docker group or a writable socket when startupRefusal is set', () => {
    for (const f of [
      { ...clean, uid: 0 },
      { ...clean, passwordlessSudo: true },
      { ...clean, groups: ['docker'] },
      { ...clean, writableDockerSocket: '/run/docker.sock' },
    ])
      expect(decideStartup({ facts: f, policy: refusing, serverRequiresSigned: false })).toMatchObject({
        action: 'refuse',
      });
    expect(decideStartup({ facts: clean, policy: refusing, serverRequiresSigned: false })).toEqual({
      action: 'ok',
    });
  });

  it('refuses when the server reports "Only signed runners" even without the local setting (it may narrow)', () => {
    expect(
      decideStartup({
        facts: { ...clean, groups: ['docker'] },
        policy: warnOnly,
        serverRequiresSigned: true,
      }),
    ).toMatchObject({
      action: 'refuse',
    });
  });

  it('acceptRootEquivalent lets it start with the warning, but never overrides "writable by another user"', () => {
    const accepted = { startupRefusal: true, acceptRootEquivalent: true };
    expect(
      decideStartup({
        facts: { ...clean, passwordlessSudo: true },
        policy: accepted,
        serverRequiresSigned: true,
      }),
    ).toMatchObject({
      action: 'warn',
    });
    expect(
      decideStartup({
        facts: { ...clean, writableByOthers: ['/home/x/.config/aom-runner/policy.json'] },
        policy: accepted,
        serverRequiresSigned: false,
      }),
    ).toMatchObject({ action: 'refuse', reason: expect.stringMatching(/writable by another user/) });
  });

  it('a runner that self-updated without setup (no startupRefusal) and a server with the setting off only warns', () => {
    expect(
      decideStartup({
        facts: { ...clean, uid: 0, groups: ['docker'] },
        policy: warnOnly,
        serverRequiresSigned: false,
      }),
    ).toMatchObject({
      action: 'warn',
      reasons: expect.arrayContaining([expect.stringMatching(/root/)]),
    });
  });

  it('detects files group or others may write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-startup-'));
    const f = join(dir, 'policy.json');
    writeFileSync(f, '{}');
    chmodSync(f, 0o600);
    const uid = process.getuid?.() ?? null;
    expect(writableByOthers(f, uid)).toBe(false);
    chmodSync(f, 0o666);
    expect(writableByOthers(f, uid)).toBe(true);
    chmodSync(f, 0o620);
    expect(writableByOthers(f, uid)).toBe(true);
  });
});

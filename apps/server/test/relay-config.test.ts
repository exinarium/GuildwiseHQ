import { RELAY_BODY_HARD_MAX_BYTES, RELAY_KINDS } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig, relayBodyLimits, relayTimeouts } from '../src/config.ts';

const MIB = 1024 * 1024;

describe('relayBodyLimits', () => {
  it('gives whatsapp_cloud 3 MiB and every other kind the global limit when nothing is set', () => {
    const l = relayBodyLimits(MIB, '');
    for (const k of RELAY_KINDS) expect(l[k]).toBe(k === 'whatsapp_cloud' ? 3 * MIB : MIB);
  });

  it('follows a global limit above 3 MiB for whatsapp_cloud too', () => {
    expect(relayBodyLimits(4 * MIB, '').whatsapp_cloud).toBe(4 * MIB);
  });

  it('lets a global limit below 3 MiB leave whatsapp_cloud at 3 MiB', () => {
    const l = relayBodyLimits(512 * 1024, '');
    expect(l.whatsapp_cloud).toBe(3 * MIB);
    expect(l.generic).toBe(512 * 1024);
  });

  it('applies one or several overrides, and the override wins over the built-in default', () => {
    expect(relayBodyLimits(MIB, 'whatsapp_cloud=2097152').whatsapp_cloud).toBe(2 * MIB);
    const l = relayBodyLimits(MIB, 'whatsapp_cloud=2097152, generic=2048');
    expect(l.generic).toBe(2048);
    expect(l.whatsapp_cloud).toBe(2 * MIB);
  });

  it('caps a value at the hard ceiling', () => {
    expect(relayBodyLimits(MIB, 'generic=999999999').generic).toBe(RELAY_BODY_HARD_MAX_BYTES);
  });

  // Bad entries are handled as in AOM_RELAY_TIMEOUTS: unknown kind and non-number are skipped, zero/negative go to the floor.
  it('skips an unknown kind and a non-numeric value, like relayTimeouts', () => {
    const base = relayBodyLimits(MIB, '');
    for (const bad of ['nope=5000', 'generic=abc', 'generic', '=5', ',,']) {
      expect(relayBodyLimits(MIB, bad)).toEqual(base);
      expect(relayTimeouts(5000, bad)).toEqual(relayTimeouts(5000, ''));
    }
  });

  it('sends zero and negative to the floor, like relayTimeouts', () => {
    expect(relayBodyLimits(MIB, 'generic=0').generic).toBe(1);
    expect(relayBodyLimits(MIB, 'generic=-5').generic).toBe(1);
    expect(relayTimeouts(5000, 'generic=0').generic).toBe(1000);
    expect(relayTimeouts(5000, 'generic=-5').generic).toBe(1000);
  });

  it('is read by loadConfig next to the global limit', () => {
    const base = { AOM_PUBLIC_ORIGIN: 'http://localhost:4600', DATABASE_URL: 'postgres://x/y' };
    const c = loadConfig({ ...base, AOM_RELAY_MAX_BODY_BYTES_BY_KIND: 'generic=2048' });
    expect(c.relay.maxBodyBytes).toBe(MIB);
    expect(c.relay.maxBodyBytesByKind.generic).toBe(2048);
    expect(c.relay.maxBodyBytesByKind.whatsapp_cloud).toBe(3 * MIB);
  });
});

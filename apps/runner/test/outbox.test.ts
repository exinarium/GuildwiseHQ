import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Outbox } from '../src/connection/outbox.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
const frame = (id: string, type = 'shift.report') => ({ v: 1, id, type, ts: '2026-10-03T12:00:00.000Z' });

describe('outbox', () => {
  it('persists entries in creation order and deletes on ack', () => {
    const dir = join(tmp(), 'outbox');
    const o = new Outbox(dir);
    o.add(frame('b'));
    o.add(frame('a'));
    o.add(frame('c'));
    expect(o.list().map((e) => e.id)).toEqual(['b', 'a', 'c']);
    expect(o.ack('a')).toBe(true);
    expect(o.ack('a')).toBe(false);
    expect(o.count()).toBe(2);
  });

  it('survives a process restart (new instance on the same dir) and keeps ordering for new entries', () => {
    const dir = join(tmp(), 'outbox');
    const first = new Outbox(dir);
    first.add(frame('1'));
    first.add(frame('2'));
    const second = new Outbox(dir);
    second.add(frame('3'));
    expect(second.list().map((e) => e.id)).toEqual(['1', '2', '3']);
    expect(second.has('2')).toBe(true);
  });

  it('discards entries by predicate', () => {
    const o = new Outbox(join(tmp(), 'outbox'));
    o.add({ ...frame('r1'), shiftId: 's1' });
    o.add({ ...frame('r2', 'shift.ended'), shiftId: 's1' });
    expect(o.discard((e) => e.type === 'shift.report' && e.frame.shiftId === 's1')).toBe(1);
    expect(o.list().map((e) => e.id)).toEqual(['r2']);
  });
});

import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { LOG_REDACT } from '../src/app.ts';
import { cardOutput, outputDelivery, sampleOutput } from '../src/commands/schedule-output.ts';
import type { Ctx } from '../src/context.ts';
import type { Queryable } from '../src/db/sql.ts';

// No database: a fake Queryable answers by the text of the query.
const ctx = {
  config: { publicOrigin: 'https://aom.test' },
  clock: { now: () => new Date('2026-10-30T10:00:00Z') },
} as unknown as Ctx;
const fake = (card: Record<string, unknown> | undefined, handoff?: string, done?: string): Queryable =>
  ({
    query: async (text: string) => {
      if (text.includes('FROM thread_messages'))
        return { rows: handoff === undefined ? [] : [{ body: handoff }] };
      if (text.includes("status='done'")) return { rows: done ? [{ id: done }] : [] };
      return { rows: card ? [card] : [] };
    },
  }) as never;
const CARD = { id: 'c1', ref: 'GWP-9', title: 'Quote', investigation: null, investigation_only: false };

describe('cardOutput', () => {
  it('is the latest agent handoff note with a link to the card', async () => {
    const o = await cardOutput(ctx, fake(CARD, '  Done: sent the quote.  '), 'c1');
    expect(o).toMatchObject({ ref: 'GWP-9', text: 'Done: sent the quote.', source: 'handoff' });
    expect(o?.link).toBe('https://aom.test/cards/GWP-9');
  });
  it('is the investigation summary for an investigation-only card', async () => {
    const card = { ...CARD, investigation: { summary: 'Findings' }, investigation_only: true };
    expect(await cardOutput(ctx, fake(card, 'ignored'), 'c1')).toMatchObject({
      text: 'Findings',
      source: 'report',
    });
  });
  it('falls back to the report when there is no handoff, and is null for a missing card', async () => {
    const card = { ...CARD, investigation: { summary: 'Report text' } };
    expect(await cardOutput(ctx, fake(card, ''), 'c1')).toMatchObject({
      text: 'Report text',
      source: 'report',
    });
    expect(await cardOutput(ctx, fake(undefined), 'c1')).toBeNull();
  });
});

describe('sampleOutput', () => {
  it('uses a fixed text when the schedule has no done card', async () => {
    const o = await sampleOutput(ctx, fake(undefined), { id: 's1', name: 'Weekly' } as never);
    expect(o.ref).toBe('TEST-1');
    expect(o.text).toContain('Weekly');
  });
});

describe('outputDelivery', () => {
  const s = { id: 's1', name: 'Weekly' } as never;
  const o = {
    ref: 'GWP-9',
    title: 'Quote',
    text: 'Secret result text',
    source: 'handoff' as const,
    link: 'https://aom.test/cards/GWP-9',
  };
  const at = new Date('2026-10-30T10:00:00Z');
  it('marks a webhook as signed with the output secret and a test as schedule.test', () => {
    const d = outputDelivery(
      ctx,
      s,
      { kind: 'webhook', url: 'https://example.com/h', format: 'generic' },
      0,
      o,
      'c1',
      { at },
    );
    expect(d).toMatchObject({ kind: 'webhook', secret: 'output', event: 'schedule.output' });
    const t = outputDelivery(
      ctx,
      s,
      { kind: 'webhook', url: 'https://example.com/h', format: 'generic' },
      0,
      o,
      'c1',
      { at, test: true },
    );
    expect(t).toMatchObject({ event: 'schedule.test' });
  });
  it('keeps the message text out of runner deliveries', () => {
    const d = outputDelivery(
      ctx,
      s,
      { kind: 'whatsapp', workstationId: 'w1', instance: '123', to: ['+27821234567'] } as never,
      1,
      o,
      'c1',
      { at },
    );
    expect(d).toMatchObject({ kind: 'runner', channel: 'whatsapp', destination: 1, cardId: 'c1' });
    expect(JSON.stringify(d)).not.toContain('Secret result text');
  });
});

describe('log redaction of output text', () => {
  it('never prints a WhatsApp text or a sheet row', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = Fastify({ logger: { level: 'info', redact: LOG_REDACT, stream } }).log;
    log.info({ payload: { whatsapp: { text: 'WA-MARK' }, sheet: { row: ['ROW-MARK'] } } }, 'command');
    log.info({ cmd: { whatsapp: { text: 'WA-MARK' }, sheet: { row: ['ROW-MARK'] } } }, 'command');
    const out = lines.join('');
    expect(out).not.toContain('WA-MARK');
    expect(out).not.toContain('ROW-MARK');
    expect(out).toContain('[redacted]');
  });
});

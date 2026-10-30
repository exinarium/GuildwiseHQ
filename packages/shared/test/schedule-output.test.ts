import { describe, expect, it } from 'vitest';
import {
  DeliverOutputSchema,
  OUTPUT_EMPTY_TEXT,
  OutputDestinationSchema,
  outputEmail,
  outputTarget,
  outputWebhookBody,
  ScheduleActionSchema,
  ScheduleDeliverySchema,
  sheetRange,
  sheetRow,
  spreadsheetIdFrom,
  WHATSAPP_EXCERPT_MAX,
  whatsappText,
} from '../src/index.ts';

const o = {
  ref: 'WEB-12',
  title: 'Quote for Acme',
  text: 'Line one\nLine two   with   spaces',
  source: 'handoff' as const,
  link: 'https://hq.example/cards/WEB-12',
};

describe('output formatters', () => {
  it('e-mail: default subject, text then link, cut at 20,000', () => {
    const m = outputEmail(o, 'Weekly', { kind: 'email', to: ['a@b.co'], subject: '' });
    expect(m.subject).toBe('Weekly: WEB-12 Quote for Acme');
    expect(m.text).toBe(`${o.text}\n\n${o.link}`);
    const long = outputEmail({ ...o, text: 'x'.repeat(30_000) }, 'W', {
      kind: 'email',
      to: ['a@b.co'],
      subject: '{ref} done',
    });
    expect(long.subject).toBe('WEB-12 done');
    expect(long.text.length).toBeLessThan(20_100);
  });

  it('empty output becomes a pointer to the card', () => {
    expect(
      outputEmail({ ...o, text: '  ' }, 'W', { kind: 'email', to: ['a@b.co'], subject: '' }).text,
    ).toContain(OUTPUT_EMPTY_TEXT);
  });

  it('webhook generic body carries the card and the source; slack gets a text', () => {
    const c = { scheduleId: 's1', scheduleName: 'Weekly', at: '2026-10-30T10:00:00.000Z' };
    const g = outputWebhookBody('generic', o, c) as Record<string, any>;
    expect(g.event).toBe('schedule.output');
    expect(g.trigger).toBe('event');
    expect(g.data).toEqual({
      card: { ref: 'WEB-12', title: 'Quote for Acme', url: o.link },
      output: { source: 'handoff' },
    });
    expect((outputWebhookBody('generic', o, { ...c, test: true }) as Record<string, any>).event).toBe(
      'schedule.test',
    );
    const sl = outputWebhookBody('slack', o, c) as { text: string };
    expect(sl.text).toContain('WEB-12 Quote for Acme');
    expect(sl.text).toContain(o.link);
  });

  it('WhatsApp text: flattened, squeezed, cut at the limit, link last', () => {
    expect(whatsappText(o)).toBe(`Line one · Line two with spaces ${o.link}`);
    const t = whatsappText({ ...o, text: 'y'.repeat(2000) });
    expect(t.length).toBe(WHATSAPP_EXCERPT_MAX + 1 + o.link.length);
    expect(t).toContain('…');
    expect(t.endsWith(o.link)).toBe(true);
    expect(whatsappText(o)).not.toMatch(/[\n\t]/);
  });

  it('sheet row has the five agreed columns, output and link in the last', () => {
    const r = sheetRow('2026-10-30T10:00:00.000Z', 'Weekly', o);
    expect(r).toHaveLength(5);
    expect(r.slice(0, 4)).toEqual(['2026-10-30T10:00:00.000Z', 'Weekly', 'WEB-12', 'Quote for Acme']);
    expect(r[4]).toBe(`${o.text}\n\n${o.link}`);
  });

  it('targets never hold secrets and sheet ranges are quoted when needed', () => {
    expect(outputTarget({ kind: 'webhook', url: 'https://x.example/hook?k=1', format: 'generic' })).toBe(
      'x.example',
    );
    expect(
      outputTarget({
        kind: 'google_sheet',
        workstationId: crypto.randomUUID(),
        instance: 'sa@p.iam.gserviceaccount.com',
        spreadsheetId: '1AbCdEfGhIjKlMnOpQrStUv',
        sheet: 'Sheet1',
      }),
    ).toBe('Sheet 1AbCdEfG… / Sheet1');
    expect(sheetRange('Sheet1')).toBe('Sheet1!A:E');
    expect(sheetRange("Q3 'plan'")).toBe("'Q3 ''plan'''!A:E");
    expect(
      spreadsheetIdFrom('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUv/edit#gid=0'),
    ).toBe('1AbCdEfGhIjKlMnOpQrStUv');
    expect(spreadsheetIdFrom('1AbCdEfGhIjKlMnOpQrStUv')).toBe('1AbCdEfGhIjKlMnOpQrStUv');
  });
});

describe('output schemas', () => {
  const ws = crypto.randomUUID();
  it('validates destinations', () => {
    expect(
      OutputDestinationSchema.safeParse({
        kind: 'whatsapp',
        workstationId: ws,
        instance: '1',
        to: ['0821234567'],
      }).success,
    ).toBe(false);
    expect(
      OutputDestinationSchema.safeParse({
        kind: 'whatsapp',
        workstationId: ws,
        instance: '1',
        to: ['+27821234567'],
      }).success,
    ).toBe(true);
    expect(
      OutputDestinationSchema.safeParse({
        kind: 'google_sheet',
        workstationId: ws,
        instance: 'a@b',
        spreadsheetId: 'short',
      }).success,
    ).toBe(false);
    expect(DeliverOutputSchema.safeParse({ destinations: [] }).success).toBe(false);
    expect(
      DeliverOutputSchema.safeParse({
        destinations: Array.from({ length: 6 }, () => ({ kind: 'email', to: ['a@b.co'] })),
      }).success,
    ).toBe(false);
  });

  it('is additive: a create_card without deliverOutput parses as before, and the delivery union keeps its old members', () => {
    const base = { kind: 'create_card', projectId: crypto.randomUUID(), template: { title: 'T' } };
    const parsed = ScheduleActionSchema.parse(base);
    expect(parsed.kind === 'create_card' && parsed.deliverOutput).toBeUndefined();
    expect(
      ScheduleDeliverySchema.safeParse({ kind: 'webhook', url: 'u', body: '{}', event: 'e' }).success,
    ).toBe(true);
    expect(
      ScheduleDeliverySchema.safeParse({ kind: 'email', to: ['a'], subject: 's', text: 't' }).success,
    ).toBe(true);
    expect(
      ScheduleDeliverySchema.safeParse({
        kind: 'runner',
        channel: 'whatsapp',
        destination: 0,
        cardId: ws,
        workstationId: ws,
      }).success,
    ).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { type CardOutput, outputEmail, outputWebhookBody, sheetRow, whatsappText } from '../src/index.ts';

const base: CardOutput = {
  ref: 'WEB-1',
  title: 'Morning plan',
  text: 'Do WEB-2 first.',
  source: 'handoff',
  link: 'https://hq.test/cards/WEB-1',
};
const withLinks: CardOutput = {
  ...base,
  links: [{ label: 'WEB-2 Call Jo', url: 'https://hq.test/cards/WEB-2' }],
};
const email = { kind: 'email' as const, to: ['a@b.co'], subject: '' };
const ctx = { scheduleId: 's', scheduleName: 'Morning plan', at: '2026-10-31T07:00:00Z' };

describe('brief output links', () => {
  it('email, webhook, chat and sheet carry the links', () => {
    expect(outputEmail(withLinks, 'Morning plan', email).text).toContain(
      'Links:\n- WEB-2 Call Jo: https://hq.test/cards/WEB-2',
    );
    const body = outputWebhookBody('generic', withLinks, ctx) as { data: { links: unknown[] } };
    expect(body.data.links).toHaveLength(1);
    expect(JSON.stringify(outputWebhookBody('slack', withLinks, ctx))).toContain(
      'https://hq.test/cards/WEB-2',
    );
    expect(sheetRow(ctx.at, 'x', withLinks)[4]).toContain('https://hq.test/cards/WEB-2');
  });

  it('whatsapp ignores the links', () => {
    expect(whatsappText(withLinks)).toBe(whatsappText(base));
  });

  it('without links every output is as before', () => {
    expect(outputEmail(base, 'Morning plan', email).text).toBe(
      'Do WEB-2 first.\n\nhttps://hq.test/cards/WEB-1',
    );
    expect(JSON.stringify(outputWebhookBody('generic', base, ctx))).not.toContain('links');
    expect(sheetRow(ctx.at, 'x', base)[4]).toBe('Do WEB-2 first.\n\nhttps://hq.test/cards/WEB-1');
  });
});

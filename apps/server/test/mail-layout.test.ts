import { describe, expect, it } from 'vitest';
import { brandedMail, senderName } from '../src/mail/layout.ts';
import * as tpl from '../src/mail/templates.ts';

const origin = 'https://app.example.test';
const expiresAt = new Date('2026-12-01T10:00:00Z');
const link = `${origin}/invite/tok`;

describe('brandedMail', () => {
  const m = brandedMail({
    to: 'a@b.test',
    subject: 'Hi <there>',
    preheader: 'Preview',
    heading: 'Heading & more',
    origin: `${origin}/`,
    body: ['Para <b>one</b>', { quote: 'quoted' }, { facts: [['K', 'V']] }, { list: ['x'] }],
    cta: { label: 'Go', url: 'https://app.example.test/x?a=1&b=2' },
    note: 'A note',
  });
  it('produces themed, escaped, absolute-URL HTML and a text twin', () => {
    expect(m.html).toContain('#3446d9'); // brand token
    expect(m.html).toContain('prefers-color-scheme: dark');
    expect(m.html).toContain(`${origin}/brand/logo-mark-mail@2x.png`);
    expect(m.html).toContain('Heading &amp; more');
    expect(m.html).toContain('Para &lt;b&gt;one&lt;/b&gt;');
    expect(m.html).toContain('a=1&amp;b=2');
    expect(m.html).toContain('Many hands. One master.');
    expect(m.html).toContain(`${origin}/privacy`);
    expect(m.text).toContain('Heading & more');
    expect(m.text).toContain('Go:\nhttps://app.example.test/x?a=1&b=2');
    expect(m.text).toContain('K: V');
    expect(m.text).toContain('Many hands. One master.');
    expect(m.subject).toBe('Hi <there>');
  });
});

describe('senderName', () => {
  it('uses a real display name, else the organization, else the team; never a username or an email', () => {
    expect(senderName({ displayName: 'Ada Lovelace', email: 'ada@x.test' })).toBe('Ada Lovelace');
    expect(senderName({ displayName: 'pieter', email: 'pieter@x.test', orgName: 'Acme' })).toBe('Acme');
    expect(senderName({ displayName: 'pieter@x.test', orgName: null })).toBe('The Guildwise HQ team');
    expect(senderName({ displayName: '  ' })).toBe('The Guildwise HQ team');
  });
});

describe('templates', () => {
  const base = { to: 'a@b.test', origin };
  const all = [
    tpl.invitationMail({ ...base, link, invitedBy: 'Ada', expiresAt }),
    tpl.orgInvitationMail({ ...base, link, orgName: 'Acme', role: 'admin', invitedBy: 'Ada', expiresAt }),
    tpl.newOrgInvitationMail({
      ...base,
      link,
      orgName: 'Acme',
      terms: 'Founding plan',
      invitedBy: 'The Guildwise HQ team',
      expiresAt,
    }),
    tpl.passwordResetMail({ ...base, name: 'Ada', link: `${origin}/reset-password/t`, expiresAt }),
    tpl.scheduledReportMail({ ...base, subject: 'Report', text: 'Line 1\nLine 2' }),
    tpl.supportReceivedMail({ ...base, name: 'Ada', ref: 'SUP-1', subject: 'Help', link: null }),
    tpl.supportReplyMail({
      ...base,
      name: 'Ada',
      ref: 'SUP-1',
      subject: 'Help',
      body: 'Answer',
      closed: false,
      link: null,
    }),
    tpl.supportFollowUpMail({
      ...base,
      ref: 'SUP-1',
      subject: 'Help',
      name: 'Ada',
      email: 'ada@b.test',
      body: 'More',
      link,
    }),
  ];
  it('every template goes through the layout and never names an operating company', () => {
    for (const m of all) {
      expect(m.html).toContain('prefers-color-scheme');
      expect(m.html).toContain('Many hands. One master.');
      expect(m.text).toContain('Many hands. One master.');
      expect(`${m.html}${m.text}`.toLowerCase()).not.toContain('(pty) ltd');
    }
  });
  it('the acknowledgement carries the reference, what happens next and the response time', () => {
    const m = tpl.supportReceivedMail({
      ...base,
      name: 'Ada',
      ref: 'SUP-1001',
      subject: 'Help',
      link: `${origin}/help/requests/1`,
    });
    expect(m.text).toContain('SUP-1001');
    expect(m.text).toContain('What happens next');
    expect(m.text).toContain(tpl.SUPPORT_RESPONSE_TIME);
  });
  it('escapes names in HTML', () => {
    const m = tpl.orgInvitationMail({
      ...base,
      link,
      orgName: '<script>',
      role: 'member',
      invitedBy: 'A&B',
      expiresAt,
    });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('A&amp;B');
  });
});

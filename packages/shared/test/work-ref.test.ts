import { describe, expect, it } from 'vitest';
import {
  branchName,
  cardBranchName,
  cardTicketRef,
  isSafeGitRef,
  ticketBranchPart,
  workRefBranchPart,
  workReference,
} from '../src/index.ts';

describe('branchName (unchanged format)', () => {
  it('keeps the existing <prefix><ref-lowercase>-<slug> format', () => {
    expect(branchName('guildwise/', 'WEB-12', 'Add login page')).toBe('guildwise/web-12-add-login-page');
    expect(branchName('aom/', 'GWP-123', 'Fix: the login (again)!')).toBe('aom/gwp-123-fix-the-login-again');
    expect(branchName('', 'GWP-1', '')).toBe('gwp-1');
    expect(branchName('aom/', 'GWP-5', 'x'.repeat(60))).toBe(`aom/gwp-5-${'x'.repeat(40)}`);
  });
});

describe('cardTicketRef / workReference', () => {
  it('gives the canonical Jira key for every format variant of the same ticket', () => {
    for (const raw of [
      'ABC-1',
      'abc-1',
      ' Abc-1 ',
      'see abc-1 please',
      'https://acme.atlassian.net/browse/ABC-1',
    ]) {
      const wr = workReference({ ref: 'GWP-123', fields: { externalRef: raw } });
      expect(wr, raw).toMatchObject({ ref: 'ABC-1', isClientRef: true });
      expect(wr.ticket?.system).toBe('jira');
    }
  });

  it('gives owner/repo#n for GitHub references and URLs', () => {
    for (const raw of ['acme/web#12', 'https://github.com/acme/web/issues/12']) {
      expect(workReference({ ref: 'GWP-1', fields: { externalRef: raw } })).toMatchObject({
        ref: 'acme/web#12',
        isClientRef: true,
      });
    }
  });

  it('gives the internal ref for a card without a usable ticket', () => {
    for (const fields of [
      undefined,
      null,
      {},
      { externalRef: '' },
      { externalRef: '   ' },
      { externalRef: 42 },
      { externalRef: 'no ticket here' },
      { externalRef: '$(rm -rf /)' },
    ]) {
      expect(workReference({ ref: 'GWP-7', fields })).toEqual({
        ref: 'GWP-7',
        isClientRef: false,
        ticket: null,
      });
    }
    expect(cardTicketRef('ABC-1')).toBeNull();
  });
});

describe('ticketBranchPart / workRefBranchPart', () => {
  it('keeps a Jira key in upper case', () => {
    expect(ticketBranchPart({ system: 'jira', key: 'ABC-1' })).toBe('ABC-1');
    expect(ticketBranchPart({ system: 'jira', key: 'abc-1' })).toBe('ABC-1');
    expect(ticketBranchPart({ system: 'jira', key: 'not a key' })).toBeNull();
  });

  it('turns a GitHub issue into <repo-slug>-<n>', () => {
    expect(ticketBranchPart({ system: 'github', key: 'acme/Web.App#12' })).toBe('web-app-12');
    expect(ticketBranchPart({ system: 'github', key: 'acme/..evil.lock#3' })).toBe('evil-lock-3');
    expect(ticketBranchPart({ system: 'github', key: 'acme/...#4' })).toBe('gh-4');
    expect(ticketBranchPart({ system: 'github', key: 'garbage' })).toBeNull();
  });

  it('reads a work reference string', () => {
    expect(workRefBranchPart('ABC-1')).toBe('ABC-1');
    expect(workRefBranchPart('acme/web#12')).toBe('web-12');
    expect(workRefBranchPart('')).toBeNull();
  });
});

describe('cardBranchName', () => {
  it('names an intake card branch by its ticket, without the internal key', () => {
    const b = cardBranchName('aom/', {
      ref: 'GWP-123',
      title: 'Fix login',
      fields: { externalRef: 'abc-1' },
    });
    expect(b).toEqual({ name: 'aom/ABC-1-fix-login', fromTicket: true });
    expect(b.name).not.toMatch(/gwp-123/i);
    expect(
      cardBranchName('aom/', { ref: 'GWP-9', title: 'Dark mode', fields: { externalRef: 'acme/web#12' } })
        .name,
    ).toBe('aom/web-12-dark-mode');
    expect(cardBranchName('', { ref: 'GWP-9', title: '', fields: { externalRef: 'ABC-2' } }).name).toBe(
      'ABC-2',
    );
  });

  it('gives exactly branchName for a card without a ticket', () => {
    for (const fields of [undefined, {}, { externalRef: '' }, { externalRef: 'free text' }]) {
      expect(cardBranchName('guildwise/', { ref: 'WEB-12', title: 'Add login page', fields })).toEqual({
        name: branchName('guildwise/', 'WEB-12', 'Add login page'),
      });
    }
  });

  it('never produces an unsafe ref: hostile GitHub repos are slugged or fall back', () => {
    for (const externalRef of [
      'acme/..evil.lock#3',
      'acme/.x#1',
      'acme/a..b#2',
      'https://github.com/acme/-x/issues/5',
    ]) {
      const b = cardBranchName('aom/', { ref: 'GWP-3', title: 'T', fields: { externalRef } });
      expect(isSafeGitRef(b.name), `${externalRef} -> ${b.name}`).toBe(true);
    }
  });

  it('falls back to the internal ref with a reason when the ticket name is not a safe ref', () => {
    // The ticket name would exceed the 200 character ref limit; the internal-ref name still fits.
    const prefix = `${'a'.repeat(179)}/`;
    const key = 'ABCDEFGHIJ-1234567890123';
    const b = cardBranchName(prefix, { ref: 'GWP-3', title: '', fields: { externalRef: key } });
    expect(b.name).toBe(branchName(prefix, 'GWP-3', ''));
    expect(isSafeGitRef(b.name)).toBe(true);
    expect(b.fallbackReason).toContain(key);
    expect(b.fromTicket).toBeUndefined();
  });
});

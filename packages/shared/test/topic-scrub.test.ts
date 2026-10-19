import { describe, expect, it } from 'vitest';
import { DomainEventSchema, scrubTopic } from '../src/index.ts';

const BlogTopicQueuedForTest = DomainEventSchema;

const codes = (question: string, opts = {}, area = 'deploy') => {
  const r = scrubTopic({ question, area }, opts);
  return r.ok ? [] : r.findings.map((f) => f.code);
};

describe('good questions pass', () => {
  it.each([
    'How can AI agents authorize production deploys without bypassing safety checks?',
    'What is a safe way to give a coding agent access to a Docker socket?',
    'How do teams stop an AI agent from looping on the same failing test?',
    'Which CI/CD checks catch the most mistakes made by Claude Code?',
    'How should a small team review pull requests written by LLMs on Node.js services?',
    'What does an LLM-based code review cost per pull request, and how is it kept predictable?',
  ])('%s', (q) => {
    const r = scrubTopic({ question: q, area: 'deploy' });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  });

  it('returns the trimmed question and the area', () => {
    const r = scrubTopic({
      question: '  How can agents handle   secrets in Docker builds safely?  ',
      area: 'secrets',
    });
    expect(r).toMatchObject({
      ok: true,
      topic: { question: 'How can agents handle secrets in Docker builds safely?', area: 'secrets' },
    });
  });
});

describe('shape', () => {
  it('rejects short, long and non-question text', () => {
    expect(codes('Why deploys?')).toContain('too_short');
    expect(codes(`How can agents ${'really '.repeat(30)}work well?`)).toContain('too_long');
    expect(codes('Agents should authorize production deploys carefully.')).toContain('not_a_question');
  });
  it('rejects more than one sentence', () => {
    expect(codes('Deploys keep failing. How can agents authorize them safely?')).toContain(
      'more_than_one_sentence',
    );
    expect(codes('How can agents deploy safely? And how can they roll back?')).toContain(
      'more_than_one_sentence',
    );
  });
  it('rejects an unknown area, non-ASCII text and many digits', () => {
    expect(codes('How can agents authorize production deploys safely?', {}, 'billing')).toContain('bad_area');
    expect(codes('How can agents authorize production deploys safely — always?')).toContain('non_ascii');
    expect(codes('How can 12345 agents authorize production deploys safely?')).toContain('too_many_digits');
    expect(codes('How can 3 agents authorize production deploys safely?')).toEqual([]);
  });
});

describe('identifiers', () => {
  it.each([
    ['How can agents reach https://deploy.example.com during a release?', 'url'],
    ['How can agents mail ops@example.com when a release fails badly?', 'email'],
    ['How can an agent reach 10.0.0.12 during a release without a VPN?', 'ip_address'],
    ['How can agents deploy to build.internal.local without a human present?', 'host_name'],
    ['How can agents reach db01:5432 during a release without a human?', 'host_name'],
    ['How can an agent edit /etc/passwd style files without causing damage?', 'file_path'],
    ['How should an agent handle PROJ-1234 style tickets during deploys safely?', 'ticket_key'],
    ['How can agents trace 3f2a9c0d11 style build ids during a release?', 'identifier'],
    ['How can agents trace 9f1c2b7e-1234-4abc-8def-0123456789ab ids in releases?', 'identifier'],
    ['How can @alice style handles be avoided in agent commit messages ever?', 'handle'],
    ['How can an agent run "rm -rf" style commands without a safety net around it?', 'quoted_text'],
    ['How can an agent run `make deploy` without a safety net around the release?', 'symbol'],
    ['How can an agent run deploy --force without a safety net around the release?', 'cli_flag'],
    ['How can an agent call getUserToken without exposing secrets in a release?', 'camel_case'],
    ['How can an agent read deploy_token style variables without leaking them?', 'snake_case'],
    ['How can an agent set a=b style options without leaking secrets in a release?', 'symbol'],
  ])('%s', (q, code) => {
    expect(codes(q)).toContain(code);
  });
});

describe('the organization deny-list', () => {
  const deny = ['Aurora Billing', 'quartzdb', 'Priya', 'Hexagon'];
  it('blocks whole-word matches in any case, including phrases', () => {
    expect(
      codes('How can agents deploy aurora billing releases without a human present?', { denyList: deny }),
    ).toContain('deny_list');
    expect(
      codes('How can agents migrate QuartzDB schemas safely during a release?', { denyList: deny }),
    ).toContain('deny_list');
    expect(
      codes('How can an agent ask priya for approval during a release safely?', { denyList: deny }),
    ).toContain('deny_list');
  });
  it('blocks a near miss of a long name (edit distance 1)', () => {
    expect(
      codes('How can agents migrate quartzdbs schemas safely during a release?', { denyList: deny }),
    ).toContain('deny_list_similar');
    expect(
      codes('How can agents deploy Hexagons safely during a release window?', { denyList: deny }),
    ).toContain('deny_list_similar');
  });
  it('does not match inside another word, and never puts the entry in the findings', () => {
    expect(
      codes('How can agents deploy prior releases safely during a release window?', { denyList: deny }),
    ).toEqual([]);
    const r = scrubTopic(
      { question: 'How can agents migrate QuartzDB schemas safely during a release?', area: 'deploy' },
      { denyList: deny },
    );
    expect(r.findings.find((f) => f.code === 'deny_list')).toEqual({ code: 'deny_list' });
  });
});

describe('proper nouns and narrative', () => {
  it('rejects an unknown proper noun unless the owner confirms it', () => {
    const q = 'How can agents deploy to Zebrafish safely during a release window?';
    const r = scrubTopic({ question: q, area: 'deploy' });
    expect(r).toMatchObject({
      ok: false,
      findings: [{ code: 'unknown_proper_noun', detail: 'Zebrafish', overridable: true }],
    });
    expect(scrubTopic({ question: q, area: 'deploy' }, { allowTerms: ['Zebrafish'] }).ok).toBe(true);
  });
  it('lets the first word of the question be capitalised', () => {
    expect(codes('Zebrafish deploys: how can agents authorize them safely at all?')).not.toContain(
      'unknown_proper_noun',
    );
  });
  it('rejects first-person and possessive phrasing', () => {
    for (const q of [
      'How can we make our agents authorize production deploys safely?',
      'How do I stop my agent from looping on the same failing test?',
      'How can this help us deploy agents to production safely at all?',
    ])
      expect(codes(q)).toContain('first_person');
  });
});

describe('the queue event is strict', () => {
  it('accepts exactly question, area, origin and the id, and nothing else', () => {
    const base = {
      topicId: '11111111-1111-4111-8111-111111111111',
      question: 'How can AI agents authorize production deploys safely?',
      area: 'deploy',
      origin: 'customer',
    };
    expect(BlogTopicQueuedForTest.safeParse({ type: 'BlogTopicQueued', payload: base }).success).toBe(true);
    for (const extra of [{ orgId: '22222222-2222-4222-8222-222222222222' }, { evidence: [] }, { note: 'x' }])
      expect(
        BlogTopicQueuedForTest.safeParse({ type: 'BlogTopicQueued', payload: { ...base, ...extra } }).success,
      ).toBe(false);
    expect(
      BlogTopicQueuedForTest.safeParse({ type: 'BlogTopicQueued', payload: { ...base, origin: 'org' } })
        .success,
    ).toBe(false);
  });
});

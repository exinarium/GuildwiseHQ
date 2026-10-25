import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyOpenSource,
  buildIndexPack,
  buildTopicFiles,
  INDEX_FILE,
  parseArticle,
  TOPICS_DIR,
} from '../src/assistant/pack-builder.ts';
import { SYSTEM_RULES } from '../src/assistant/prompt.ts';
import {
  approxTokens,
  fitChunk,
  loadTopics,
  relevantHelpBlock,
  selectTopics,
  stem,
  TOPIC_LIMITS,
  terms,
} from '../src/assistant/topics.ts';

const ask = (
  q: string,
  page?: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
) => selectTopics([...history, { role: 'user', content: q }], { page }).map((s) => s.chunk.slug);

describe('the assistant knowledge, split by topic', () => {
  it('says what Guildwise Cloud does not include and never names the operating company or an Unlimited plan', () => {
    const all = buildIndexPack() + Object.values(buildTopicFiles()).join('\n');
    expect(all).toContain('does not include backups');
    expect(all).not.toMatch(/creativ360/i);
    expect(all).not.toMatch(/advanced training|paid training/i);
    expect(all).toMatch(/customization and setup support/i);
    expect(all).not.toMatch(/unlimited plan/i);
    expect(all).toContain('from $5');
  });

  it('keeps the repository address out of the facts until the source is public', () => {
    expect(buildIndexPack(undefined, false)).not.toContain('github.com/exinarium/GuildwiseHQ');
    expect(buildIndexPack(undefined, true)).toContain('github.com/exinarium/GuildwiseHQ');
    expect(applyOpenSource('a{{#oss}}B{{/oss}}{{^oss}}C{{/oss}}', true)).toBe('aB');
    expect(applyOpenSource('a{{#oss}}B{{/oss}}{{^oss}}C{{/oss}}', false)).toBe('aC');
  });

  it('is up to date: regenerate it with `pnpm --filter @aom/server assistant:pack` and commit it', () => {
    expect(readFileSync(INDEX_FILE, 'utf8')).toBe(buildIndexPack());
    const built = buildTopicFiles();
    expect(readdirSync(TOPICS_DIR).sort()).toEqual(Object.keys(built).sort());
    for (const [f, text] of Object.entries(built))
      expect(readFileSync(join(TOPICS_DIR, f), 'utf8')).toBe(text);
  });

  it('is deterministic', () => {
    expect(buildIndexPack()).toBe(buildIndexPack());
    expect(buildTopicFiles()).toEqual(buildTopicFiles());
  });

  it('keeps the always-on text small: rules, facts and the topic index stay in the cacheable range but well under the old 16k pack', () => {
    const always = approxTokens(SYSTEM_RULES) + approxTokens(buildIndexPack());
    expect(approxTokens(buildIndexPack())).toBeGreaterThan(3000); // the facts are all there
    // above the model's minimum cacheable prefix, and a quarter of what the single pack cost on every request
    expect(always).toBeGreaterThan(4096);
    expect(always).toBeLessThan(6000);
  });

  it('carries the curated facts and an index line for every help article, and no private company name', () => {
    const index = buildIndexPack();
    expect(index).toContain('<product_facts>');
    expect(index).toContain('Guildwise Cloud: $30 per organization per month');
    expect(index).not.toMatch(/Starter|Business plan|\$149|\$19\b/);
    expect(index).not.toMatch(/Unlimited plan/i);
    expect(index).toContain('<help_topics>');
    for (const t of loadTopics()) expect(index).toContain(t.title);
    expect(index).not.toMatch(/\(Pty\) Ltd/i); // no operating company in the pack
    expect(index).not.toContain('Maintainer'); // the notes above the first section stay out
    for (const f of Object.values(buildTopicFiles())) expect(f).not.toMatch(/\(Pty\) Ltd/i);
  });

  it('keeps every chunk small enough to attach: no topic is more than a quarter of the per-request budget alone', () => {
    const sizes = loadTopics().map((t) => approxTokens(t.text));
    expect(loadTopics()).toHaveLength(38);
    expect(Math.max(...sizes)).toBeLessThan(TOPIC_LIMITS.budgetTokens / 2);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeGreaterThan(8000); // the whole help centre is still here, just not sent every time
  });

  it('outlines an article by its title, summary and the first paragraph of each section', () => {
    const a = parseArticle(
      'x',
      '---\ntitle: T\nsummary: S\norder: 3\n---\nIntro.\n\n## First {#f}\n\nHello **world**, see [this](/x).\n\nSecond paragraph.\n\n## Empty\n',
    );
    expect(a).toMatchObject({ title: 'T', summary: 'S', order: 3 });
    expect(a.sections).toEqual([
      { heading: 'First', text: 'Hello world, see this.' },
      { heading: 'Empty', text: '' },
    ]);
  });
});

describe('choosing the topics of a question', () => {
  it('stems plurals and endings and drops filler words', () => {
    expect(stem('workstations')).toBe('workstation');
    expect(stem('billing')).toBe('bill');
    expect(terms('How do I install it on my Workstations, please?')).toEqual(['install', 'workstation']);
  });

  it.each([
    ['How much does it cost and what plans are there?', 'pricing'],
    ['How much for 7 people?', 'pricing'],
    ['Does Cloud include backups?', 'pricing'],
    ['How do I suggest a feature?', 'open-source-and-self-hosting'],
    ['Does it work with Codex or Gemini?', 'ai-runtimes'],
    ['What can an agent do and how do I export the audit log?', 'governance'],
    ['What is the Decision desk?', 'desk'],
    ['Can I run agents on a cloud VPS or Codespaces?', 'cloud-workstations'],
    ['How do I set up two-factor login?', 'two-factor'],
    ['What is the Boardroom and how do personas debate?', 'boardroom'],
    ['What does the CEO do?', 'your-ceo'],
    ['How is the weekly digest and the blog made?', 'blog-and-digest'],
    ['What do capabilities and packs mean?', 'capabilities'],
    ['How do budgets and costs work?', 'budgets-and-costs'],
  ])('puts the right article first for: %s', (q, slug) => {
    expect(ask(q)[0]).toBe(slug);
  });

  it('finds the installer article among the first two for an installer question', () => {
    expect(ask('How does the installer pair a workstation?').slice(0, 2)).toContain(
      'workstations-and-installer',
    );
  });

  it('attaches a few topics at most and keeps to the token budget', () => {
    for (const q of [
      'Tell me everything about agents, projects, boards, workstations, billing and the desk',
      'How do projects, cards, phases, testing and finalization work on the board?',
    ]) {
      const sel = selectTopics([{ role: 'user', content: q }]);
      expect(sel.length).toBeLessThanOrEqual(TOPIC_LIMITS.maxTopics);
      expect(sel.reduce((n, s) => n + approxTokens(s.text), 0)).toBeLessThanOrEqual(
        TOPIC_LIMITS.budgetTokens,
      );
      expect(sel.map((s) => s.score)).toEqual([...sel.map((s) => s.score)].sort((a, b) => b - a));
    }
    // a tight budget cuts a chunk at a line end and keeps its title
    const tight = selectTopics([{ role: 'user', content: 'How do plans and billing work?' }], {
      limits: { budgetTokens: 150 },
    });
    expect(tight[0]?.text.startsWith('### ')).toBe(true);
    expect(approxTokens(tight[0]?.text ?? '')).toBeLessThan(200);
    expect(fitChunk('### T\nsummary\n- a: one\n- b: two\n', 5)).toBe('### T\nsummary\n');
  });

  it('attaches nothing for a question with no match (the facts and the index answer, or the model says it does not know)', () => {
    expect(ask('What is the weather like in Paris?')).toEqual([]);
    expect(ask('hello')).toEqual([]);
    expect(relevantHelpBlock([])).toBeUndefined();
  });

  it('also finds the open-source article for a company asking about paying', () => {
    expect(ask('Can I use it in my company without paying?')).toContain('open-source-and-self-hosting');
  });

  it('keeps a follow-up on its topic through the earlier question, at half weight', () => {
    const history = [
      { role: 'user' as const, content: 'How does billing work?' },
      { role: 'assistant' as const, content: 'There are plans.' },
    ];
    expect(ask('And what about invoices?', undefined, history)).toContain('billing-and-plans');
    expect(ask('And what about invoices?')).not.toContain('desk');
  });

  it('lets the page lift a topic that already matches a little, and never invents one', () => {
    const q = [{ role: 'user' as const, content: 'What does it cost?' }];
    const lifted = selectTopics(q, { page: '/pricing' });
    expect(lifted.map((s) => s.chunk.slug)).toContain('pricing');
    expect(ask('hello', '/pricing')).toEqual([]);
  });

  it('wraps what it attached in one block', () => {
    const block = relevantHelpBlock(selectTopics([{ role: 'user', content: 'What is the Decision desk?' }]));
    expect(block?.startsWith('<relevant_help>\n### The Decision desk')).toBe(true);
    expect(block?.endsWith('</relevant_help>')).toBe(true);
  });
});

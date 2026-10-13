import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPublicPack, PACK_FILE, parseArticle } from '../src/assistant/pack-builder.ts';

describe('the assistant knowledge pack', () => {
  it('is up to date: regenerate it with `pnpm --filter @aom/server assistant:pack` and commit it', () => {
    expect(readFileSync(PACK_FILE, 'utf8')).toBe(buildPublicPack());
  });

  it('is deterministic, large enough to be cached and small enough to be cheap', () => {
    expect(buildPublicPack()).toBe(buildPublicPack());
    const tokens = buildPublicPack().length / 4;
    expect(tokens).toBeGreaterThan(4096); // the model's minimum cacheable prefix
    // The budget grows with the help centre (the architect article took it past 12k, per-agent MCP tools past 13k); still a few cents per cached read.
    expect(tokens).toBeLessThan(13_500);
  });

  it('carries the curated facts and an outline of the help articles, and no private company name', () => {
    const pack = buildPublicPack();
    expect(pack).toContain('<product_facts>');
    expect(pack).toContain('Starter: $19');
    expect(pack).toContain('### The Decision desk');
    expect(pack).not.toMatch(/ExampleCo/i);
    expect(pack).not.toContain('Maintainer'); // the notes above the first section stay out
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

import { describe, expect, it } from 'vitest';
import { CHAT_PREVIEW_MAX, chatPreviewText } from '../src/index.ts';

describe('chatPreviewText', () => {
  it('strips markdown without leaving gaps', () => {
    expect(chatPreviewText('**Toy app**: 3 cards')).toBe('Toy app: 3 cards');
    expect(chatPreviewText('# Title\n\n- one\n- two\n\n> quote')).toBe('Title one two quote');
    expect(chatPreviewText('see [the docs](https://x.io) and `code` now')).toBe('see the docs and code now');
    expect(chatPreviewText('_italic_ and snake_case_name')).toBe('italic and snake_case_name');
    expect(chatPreviewText('before\n```ts\nconst a = 1;\n```\nafter')).toBe('before code after');
  });
  it('cuts long text with an ellipsis', () => {
    const out = chatPreviewText('word '.repeat(100));
    expect(out.length).toBeLessThanOrEqual(CHAT_PREVIEW_MAX);
    expect(out.endsWith('…')).toBe(true);
  });
});

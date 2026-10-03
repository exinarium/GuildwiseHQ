import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FEED_LIST_HEADER,
  renderFeedEntries,
  renderTasteEntry,
  TASTE_HEADER,
  type VaultWriteCommand,
  VaultWriteCommandSchema,
} from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { syncVault } from '../src/vaults/sync.ts';
import { writeVaultFile } from '../src/vaults/write.ts';
import { cleanupTmp, sh } from './helpers.ts';
import { IDENTITY, makeVault } from './vault-fixtures.ts';

cleanupTmp();

const item = (n: number) => ({
  kind: 'article',
  url: `https://news.example.test/story-${n}`,
  title: `Headline ${n}`,
  source: 'News Example',
  publishedAt: '2026-10-02T00:00:00.000Z',
  summary: `Summary ${n}`,
});

const append = (path: string, content: string, header: string): VaultWriteCommand =>
  VaultWriteCommandSchema.parse({
    vaultId: 'v1',
    path,
    mode: 'append',
    content,
    header,
    commitMessage: `aom: ${path}`,
  });

async function clone() {
  const v = makeVault();
  await syncVault({ dir: v.mine, remoteUrl: v.origin, identity: IDENTITY, workstationName: 'Desk' });
  return v;
}

describe('the running list feed.md is append-only (oldest to newest)', () => {
  it('writes the header once, then only adds lines at the end; earlier entries are never rewritten', async () => {
    const v = await clone();
    const file = join(v.mine, 'projects/news/feed.md');
    const day1 = renderFeedEntries([item(1), item(2)], new Date('2026-10-03T07:00:00Z'));
    const day2 = renderFeedEntries([item(3)], new Date('2026-10-04T07:00:00Z'));

    expect(
      await writeVaultFile(v.mine, append('projects/news/feed.md', day1, FEED_LIST_HEADER), IDENTITY),
    ).toEqual({
      written: true,
      committed: true,
    });
    const afterDay1 = readFileSync(file, 'utf8');
    expect(afterDay1).toBe(`${FEED_LIST_HEADER}${day1}`);

    await writeVaultFile(v.mine, append('projects/news/feed.md', day2, FEED_LIST_HEADER), IDENTITY);
    const afterDay2 = readFileSync(file, 'utf8');
    expect(afterDay2.startsWith(afterDay1)).toBe(true);
    expect(afterDay2).toBe(`${FEED_LIST_HEADER}${day1}${day2}`);
    expect(afterDay2.match(/^# Feed/gm)).toHaveLength(1);
    const lines = afterDay2.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.map((l) => /story-(\d)/.exec(l)?.[1])).toEqual(['1', '2', '3']);
    expect(sh(v.mine, 'git', ['log', '--format=%s', '--', 'projects/news/feed.md']).split('\n')).toHaveLength(
      2,
    );
  });

  it('re-delivering a command (retry after a lost ack) is a no-op', async () => {
    const v = await clone();
    const day1 = renderFeedEntries([item(1)], new Date('2026-10-03T07:00:00Z'));
    const cmd = append('projects/news/feed.md', day1, FEED_LIST_HEADER);
    await writeVaultFile(v.mine, cmd, IDENTITY);
    const head = sh(v.mine, 'git', ['rev-parse', 'HEAD']);
    expect(await writeVaultFile(v.mine, cmd, IDENTITY)).toEqual({ written: false, committed: false });
    expect(sh(v.mine, 'git', ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('taste.md gets a header once and explicit rules appended below it', async () => {
    const v = await clone();
    const a = renderTasteEntry({
      verdict: 'useful',
      kind: 'article',
      title: 'Headline 1',
      source: 'News Example',
      url: item(1).url,
    });
    const b = renderTasteEntry({
      verdict: 'irrelevant',
      kind: 'video',
      title: 'Headline 2',
      source: 'Tube',
      url: item(2).url,
      reason: 'Off topic',
    });
    await writeVaultFile(v.mine, append('projects/news/taste.md', a, TASTE_HEADER), IDENTITY);
    await writeVaultFile(v.mine, append('projects/news/taste.md', b, TASTE_HEADER), IDENTITY);
    expect(readFileSync(join(v.mine, 'projects/news/taste.md'), 'utf8')).toBe(`${TASTE_HEADER}${a}${b}`);
  });
});

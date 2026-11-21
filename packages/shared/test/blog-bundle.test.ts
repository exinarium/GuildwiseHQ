import { describe, expect, it } from 'vitest';
import {
  BundleManifestSchema,
  BundleShareSchema,
  BundleVideoSchema,
  DomainEventSchema,
} from '../src/index.ts';

const id = '0b6f2a52-5d3c-4a34-9a51-2d7f1f0e9a11';
const iso = '2026-11-03T06:00:45.123Z';
const sha = 'a'.repeat(64);
const meta = {
  title: 'A video',
  description: 'About agents.',
  tags: ['AI'],
  hashtags: ['#Shorts', '#AIAgents', '#GuildwiseHQ'],
};

describe('blog bundle schemas', () => {
  it('accepts a share with the allow-listed YouTube detail and refuses any other key', () => {
    const share = {
      postId: id,
      source: 'video',
      network: 'youtube',
      externalId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      createdAt: iso,
      updatedAt: iso,
      detail: { videoId: 'dQw4w9WgXcQ', privacy: 'public', publishAt: iso, verifiedAt: iso },
    };
    expect(BundleShareSchema.safeParse(share).success).toBe(true);
    expect(
      BundleShareSchema.safeParse({ ...share, detail: { ...share.detail, sessionUri: 'x' } }).success,
    ).toBe(false);
    expect(BundleShareSchema.safeParse({ ...share, token: 'x' }).success).toBe(false);
    expect(BundleShareSchema.safeParse({ ...share, detail: { videoId: 'bad id<>' } }).success).toBe(false);
  });

  it('needs at least one destination for a video and refuses a script', () => {
    const v = {
      id,
      kind: 'article',
      format: 'long',
      ref: 'a-post',
      parentId: null,
      meta,
      destinations: ['youtube'],
      createdAt: iso,
      approvedAt: iso,
    };
    expect(BundleVideoSchema.safeParse(v).success).toBe(true);
    expect(BundleVideoSchema.safeParse({ ...v, destinations: [] }).success).toBe(false);
    expect(BundleVideoSchema.safeParse({ ...v, script: {} }).success).toBe(false);
  });

  it('pins the manifest format and version', () => {
    const m = {
      format: 'guildwise-blog-bundle',
      version: 1,
      createdAt: iso,
      source: { file: 'a.sql.gz', sha256: sha, pgVersion: null },
      compared: null,
      counts: { posts: 0, releases: 0, videos: 0, shares: 0 },
      files: [{ path: 'posts.json', bytes: 3, sha256: sha }],
    };
    expect(BundleManifestSchema.safeParse(m).success).toBe(true);
    expect(BundleManifestSchema.safeParse({ ...m, version: 2 }).success).toBe(false);
    expect(
      BundleManifestSchema.safeParse({ ...m, files: [{ path: '../x', bytes: 1, sha256: sha }] }).success,
    ).toBe(false);
  });
});

describe('the Imported events', () => {
  it('parse with their dates and refuse a video without destinations', () => {
    const v = {
      type: 'VideoPostImported',
      payload: {
        postId: id,
        kind: 'article',
        format: 'long',
        ref: 'a-post',
        meta,
        destinations: ['youtube'],
        origin: { userId: id },
        createdAt: iso,
        approvedAt: iso,
        bundle: sha,
      },
    };
    expect(DomainEventSchema.safeParse(v).success).toBe(true);
    expect(DomainEventSchema.safeParse({ ...v, payload: { ...v.payload, destinations: [] } }).success).toBe(
      false,
    );
    const r = {
      type: 'SocialPostImported',
      payload: {
        postId: id,
        kind: 'release',
        ref: '1.2.0',
        content: {
          version: '1.2.0',
          releasedOn: '2026-10-20',
          title: 'Guildwise HQ 1.2.0 is out',
          summary: 'What changed in this release, in one short paragraph for the card.',
          coverKey: 'release',
          captions: {},
        },
        origin: { userId: id },
        createdAt: iso,
        approvedAt: iso,
        bundle: sha,
      },
    };
    expect(DomainEventSchema.safeParse(r).success).toBe(true);
    expect(
      DomainEventSchema.safeParse({ ...r, payload: { ...r.payload, approvedAt: 'yesterday' } }).success,
    ).toBe(false);
  });
});

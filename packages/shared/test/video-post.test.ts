import { describe, expect, it } from 'vitest';
import {
  AnySocialPostContentSchema,
  ConnectSocialChannelRequestSchema,
  DEFAULT_VIDEO_SETTINGS,
  PatchVideoSettingsRequestSchema,
  SOCIAL_CHANNEL_NETWORKS,
  SOCIAL_NETWORKS,
  VIDEO_POST_LIMITS,
  VideoSettingsSchema,
} from '../src/index.ts';

describe('YouTube is a channel, not a share network', () => {
  it('SOCIAL_NETWORKS (what the blog and release sweep shares to) never lists youtube', () => {
    expect(SOCIAL_NETWORKS as readonly string[]).not.toContain('youtube');
    expect(SOCIAL_CHANNEL_NETWORKS).toContain('youtube');
    // the video-only channels (YouTube, Instagram, TikTok) are not share networks of the blog
    for (const n of ['youtube', 'instagram', 'tiktok']) {
      expect(SOCIAL_CHANNEL_NETWORKS).toContain(n);
      expect(SOCIAL_NETWORKS as readonly string[]).not.toContain(n);
    }
    expect(SOCIAL_CHANNEL_NETWORKS.filter((n) => !['youtube', 'instagram', 'tiktok'].includes(n))).toEqual([
      ...SOCIAL_NETWORKS,
    ]);
  });

  it('a pasted refresh token is a YouTube connect; a LinkedIn token with a refresh token is not', () => {
    expect(ConnectSocialChannelRequestSchema.parse({ refreshToken: '1//0g-long-enough-token' })).toEqual({
      refreshToken: '1//0g-long-enough-token',
    });
    const li = ConnectSocialChannelRequestSchema.parse({
      accountId: '5515715',
      accessToken: 'AQX-access-token-long',
      refreshToken: 'AQX-refresh',
    });
    expect(li).toHaveProperty('accountId', '5515715');
  });
});

describe('videoPosts setting', () => {
  it('defaults: off, 3 videos and 3 Shorts a week, public, category 28', () => {
    expect(VideoSettingsSchema.parse(DEFAULT_VIDEO_SETTINGS)).toMatchObject({
      enabled: false,
      perWeek: 3,
      shortsPerWeek: 3,
      privacy: 'public',
      categoryId: '28',
    });
    expect(VIDEO_POST_LIMITS.maxRenders).toBe(3);
  });
  it('a patch is partial and validates', () => {
    expect(PatchVideoSettingsRequestSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(PatchVideoSettingsRequestSchema.safeParse({ privacy: 'everyone' }).success).toBe(false);
    expect(PatchVideoSettingsRequestSchema.safeParse({ perWeek: 99 }).success).toBe(false);
  });
});

describe('the cross-post of a tutorial video', () => {
  it('has its own content shape next to the release content', () => {
    const c = AnySocialPostContentSchema.parse({
      videoPostId: '11111111-1111-4111-8111-111111111111',
      title: 'A new tutorial video is live',
      summary: 'Watch how to hire an agent and put it to work in Guildwise HQ in two minutes.',
      coverKey: 'how-to',
      captions: {},
    });
    expect(c).toHaveProperty('videoPostId');
  });
});

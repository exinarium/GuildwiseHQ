import {
  type EditVideoPostRequest,
  type PatchVideoSettingsRequest,
  type ScheduleVideoPostRequest,
  type SubmitVideoPostRequest,
  type VideoDestination,
  VideoLibraryListSchema,
  type VideoPost,
  VideoPostListSchema,
  VideoPostSchema,
  type VideoSettings,
  VideoSettingsSchema,
  VideoSlotListSchema,
  VideoTopicListSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, get, patch, post, qs } from '../client.ts';

/** Platform > Blog > Videos: the YouTube push (docs/BLOG-API.md "YouTube"). */

export function useVideoList(status?: string) {
  return useQuery({
    queryKey: ['platform', 'video', 'list', status ?? ''],
    queryFn: () => get(`/platform/video${qs({ status })}`, VideoPostListSchema),
    // renders take minutes: keep the list fresh while the page is open
    refetchInterval: 10_000,
  });
}

export function useVideoPost(id: string | undefined) {
  return useQuery({
    queryKey: ['platform', 'video', 'post', id],
    enabled: !!id,
    queryFn: () => get(`/platform/video/posts/${id}`, VideoPostSchema),
    refetchInterval: 10_000,
  });
}

function useVideoMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform', 'video'] });
      void qc.invalidateQueries({ queryKey: ['platform', 'blog'] });
    },
  });
}

/** The video settings (the Social sharing TikTok row reads `tiktokAudited`). */
export function useVideoSettings() {
  return useQuery({
    queryKey: ['platform', 'video', 'settings'],
    queryFn: () => get('/platform/video/settings', VideoSettingsSchema),
    staleTime: 30_000,
  });
}

export const usePatchVideoSettings = () =>
  useVideoMutation((v: PatchVideoSettingsRequest) =>
    patch<VideoSettings>('/platform/video/settings', v, VideoSettingsSchema),
  );

export const useSubmitVideo = () =>
  useVideoMutation((v: SubmitVideoPostRequest) =>
    post<VideoPost>('/platform/video/posts', v, VideoPostSchema),
  );

export const useEditVideo = (id: string) =>
  useVideoMutation((v: EditVideoPostRequest) =>
    patch<VideoPost>(`/platform/video/posts/${id}`, v, VideoPostSchema),
  );

export type VideoAction =
  | 'approve'
  | 'preview'
  | 'unschedule'
  | 'reject'
  | 'retry-render'
  | 'retry-upload'
  | 'resolve-locked'
  | 'crosspost';
export const useVideoAction = (id: string) =>
  useVideoMutation((v: { action: VideoAction; reason?: string }) =>
    post<VideoPost>(
      `/platform/video/posts/${id}/${v.action}`,
      v.action === 'reject' ? { reason: v.reason } : undefined,
      VideoPostSchema,
    ),
  );

// ---- the library (existing help videos)

export function useVideoLibrary(enabled = true) {
  return useQuery({
    queryKey: ['platform', 'video', 'library'],
    enabled,
    queryFn: () => get('/platform/video/library', VideoLibraryListSchema),
  });
}
export const useImportLibrary = () =>
  useVideoMutation((v: { slugs?: string[] }) =>
    post<{ created: number; skipped: string[] }>(
      '/platform/video/library/import',
      v,
      z.object({ created: z.number(), skipped: z.array(z.string()) }).loose(),
    ),
  );

// ---- Video topics

export function useVideoTopics() {
  return useQuery({
    queryKey: ['platform', 'video', 'topics'],
    queryFn: () => get('/platform/video/topics', VideoTopicListSchema),
    refetchInterval: 30_000,
  });
}
export const useAddVideoTopic = () =>
  useVideoMutation((v: { title: string; brief?: string }) =>
    post<{ duplicate: boolean }>('/platform/video/topics', v, z.object({ duplicate: z.boolean() }).loose()),
  );
export const useRejectVideoTopic = () =>
  useVideoMutation((v: { id: string; reason: string }) =>
    post(`/platform/video/topics/${v.id}/reject`, { reason: v.reason }, VideoTopicListSchema),
  );
export const useMoveVideoTopic = () =>
  useVideoMutation((id: string) =>
    post(`/platform/video/topics/${id}/move`, undefined, VideoTopicListSchema),
  );

/** URL of a preview file of a render (served with Range, never cached). */
export const videoFileUrl = (postId: string, name: string, revision?: number) =>
  `/api/platform/video/posts/${postId}/files/${name}${revision ? `?revision=${revision}` : ''}`;

const NeedingSchema = z.object({
  articles: z.array(z.object({ slug: z.string(), title: z.string(), publishedAt: z.string() })),
  releases: z.array(z.object({ version: z.string(), date: z.string() })),
});
/** Articles and releases of the last week without a video (only fetched when a drafter extension is installed). */
export function useVideosNeeded(enabled: boolean) {
  return useQuery({
    queryKey: ['platform', 'video', 'needing'],
    enabled,
    queryFn: () => get('/platform/video/needing', NeedingSchema),
    refetchInterval: 60_000,
  });
}

// ---- the schedule

/** Schedule = approve + slot. No `slotAt`: the next free one. */
export const useScheduleVideo = (id: string) =>
  useVideoMutation((v: ScheduleVideoPostRequest) =>
    post<VideoPost>(`/platform/video/posts/${id}/schedule`, v, VideoPostSchema),
  );

/** The next slots of a format and who holds them (free ones are the choices of the Schedule menu). */
export function useVideoSlots(format: 'long' | 'short', enabled = true, count = 14) {
  return useQuery({
    queryKey: ['platform', 'video', 'slots', format, count],
    enabled,
    queryFn: () => get(`/platform/video/slots${qs({ format, count })}`, VideoSlotListSchema),
    refetchInterval: 30_000,
  });
}

export const useMoveVideo = () =>
  useVideoMutation((v: { id: string; slotAt: string }) =>
    post<VideoPost>(`/platform/video/posts/${v.id}/move`, { slotAt: v.slotAt }, VideoPostSchema),
  );
export const useSwapVideo = () =>
  useVideoMutation((v: { id: string; withId: string }) =>
    post(`/platform/video/posts/${v.id}/swap`, { withId: v.withId }),
  );
export const useUnscheduleVideo = () =>
  useVideoMutation((id: string) =>
    post<VideoPost>(`/platform/video/posts/${id}/unschedule`, {}, VideoPostSchema),
  );
/** Tries one destination of a scheduled video again (YouTube included). */
export const useRetryShare = () =>
  useVideoMutation((v: { id: string; network: VideoDestination }) =>
    post<VideoPost>(`/platform/video/posts/${v.id}/shares/${v.network}/retry`, undefined, VideoPostSchema),
  );
export const useRetryVideo = () =>
  useVideoMutation((v: { id: string; what: 'retry-render' | 'retry-upload' }) =>
    post<VideoPost>(`/platform/video/posts/${v.id}/${v.what}`, undefined, VideoPostSchema),
  );
/** Re-flow: every approved post that has not started takes the slots of the current schedule, in order. */
export const useReflowVideos = () =>
  useVideoMutation(() =>
    post<{ moved: number }>('/platform/video/reflow', {}, z.object({ moved: z.number() })),
  );

const ChannelsSchema = z.object({
  channels: z.array(z.object({ network: z.string(), connected: z.boolean(), status: z.string() }).loose()),
});
/** Which networks have a connected channel (the Social sharing rows). */
export function useVideoChannels() {
  return useQuery({
    queryKey: ['platform', 'social', 'channels'],
    queryFn: () => get('/platform/social/channels', ChannelsSchema),
    staleTime: 30_000,
  });
}

// ---- TikTok creator info (the server route is Core 5's; 404/400 = TikTok is not connected)

export interface TikTokCreator {
  nickname: string;
  username: string;
  avatarUrl: string | null;
  /** TikTok's `privacy_level_options`, as the creator may choose them right now. */
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  /** The longest video the creator may post (seconds); null: not reported. */
  maxDurationSeconds: number | null;
  /** The creator cannot post now (TikTok says so): the post stops. */
  canPost: boolean;
  /** False until the app passed TikTok's audit: only private posts are allowed. */
  audited: boolean;
}
type Raw = Record<string, unknown>;
const pick = (r: Raw, ...keys: string[]) => keys.map((k) => r[k]).find((v) => v !== undefined);
/** Accepts the route's answer in camelCase or in TikTok's own snake_case. */
export function normalizeCreator(raw: unknown): TikTokCreator {
  const outer = (raw ?? {}) as Raw;
  const r = ((outer.data as Raw | undefined) ?? outer) as Raw;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const bool = (v: unknown) => v === true;
  const options = pick(r, 'privacyOptions', 'privacyLevelOptions', 'privacy_level_options');
  const max = pick(r, 'maxDurationSeconds', 'maxVideoPostDurationSec', 'max_video_post_duration_sec');
  return {
    nickname: str(pick(r, 'nickname', 'creatorNickname', 'creator_nickname')),
    username: str(pick(r, 'username', 'creatorUsername', 'creator_username')),
    avatarUrl: str(pick(r, 'avatarUrl', 'creatorAvatarUrl', 'creator_avatar_url')) || null,
    privacyOptions: Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string') : [],
    commentDisabled: bool(pick(r, 'commentDisabled', 'comment_disabled')),
    duetDisabled: bool(pick(r, 'duetDisabled', 'duet_disabled')),
    stitchDisabled: bool(pick(r, 'stitchDisabled', 'stitch_disabled')),
    maxDurationSeconds: typeof max === 'number' ? max : null,
    canPost: pick(r, 'canPost', 'can_post') !== false,
    audited: pick(r, 'audited', 'tiktokAudited') === true,
  };
}
export type TikTokCreatorResult = { state: 'connected'; creator: TikTokCreator } | { state: 'not_connected' };
/** Fetched when the Schedule step shows TikTok (TikTok wants fresh creator info for every post). */
export function useTikTokCreator(enabled: boolean) {
  return useQuery({
    queryKey: ['platform', 'video', 'tiktok-creator'],
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async (): Promise<TikTokCreatorResult> => {
      try {
        const raw = await get<unknown>('/platform/social/tiktok/creator-info');
        return { state: 'connected', creator: normalizeCreator(raw) };
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 400))
          return { state: 'not_connected' };
        throw e;
      }
    },
  });
}

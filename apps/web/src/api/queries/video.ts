import {
  type EditVideoPostRequest,
  type PatchVideoSettingsRequest,
  type SubmitVideoPostRequest,
  VideoLibraryListSchema,
  type VideoPost,
  VideoPostListSchema,
  VideoPostSchema,
  type VideoSettings,
  VideoSettingsSchema,
  VideoTopicListSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { get, patch, post, qs } from '../client.ts';

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

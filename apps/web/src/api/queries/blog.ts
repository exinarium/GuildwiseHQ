import {
  type ApiKey,
  ApiKeyAuditRowSchema,
  ApiKeySchema,
  type BlogPost,
  BlogPostSchema,
  type BlogSettings,
  BlogSettingsSchema,
  type BlogTopicList,
  BlogTopicListSchema,
  type BlogWriter,
  BlogWriterRunResultSchema,
  BlogWriterSchema,
  type CreateApiKeyRequestSchema,
  type CreateBlogTopicRequest,
  CreatedApiKeySchema,
  DigestPreferenceSchema,
  type PatchBlogSettingsRequestSchema,
  type PatchBlogWriterRequest,
  PlatformBlogListSchema,
  PublicBlogListSchema,
  PublicBlogPostFullSchema,
  ReleaseListSchema,
  SocialChannelSchema,
  SocialPostSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { del, get, patch, post, put, qs } from '../client.ts';

// ---- Help > Blog (any signed-in person)

export function usePublishedPosts(q?: string) {
  return useQuery({
    queryKey: ['blog', 'posts', q ?? ''],
    queryFn: () => get(`/blog/posts${qs({ q: q || undefined, limit: 50 })}`, PublicBlogListSchema),
  });
}

export function usePublishedPost(slug: string | undefined) {
  return useQuery({
    queryKey: ['blog', 'post', slug],
    enabled: !!slug,
    queryFn: () => get(`/blog/posts/${slug}`, PublicBlogPostFullSchema),
  });
}

// ---- the digest preference (Settings)

export function useDigestPreference() {
  return useQuery({
    queryKey: ['me', 'blog-digest'],
    queryFn: () => get('/me/blog-digest', DigestPreferenceSchema),
  });
}

export function useSetDigestPreference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (optedIn: boolean) => put('/me/blog-digest', { optedIn }, DigestPreferenceSchema),
    onSuccess: (data) => qc.setQueryData(['me', 'blog-digest'], data),
  });
}

// ---- platform: posts, settings, keys, social

const SocialSchema = z.object({
  channels: z.array(SocialChannelSchema),
  failedShares: z.number().int(),
  channelsNeedingReconnect: z.array(z.string()),
});
const PlatformBlogSchema = PlatformBlogListSchema.extend({ social: SocialSchema });
export type PlatformBlog = z.infer<typeof PlatformBlogSchema>;

export function usePlatformBlog(status?: string) {
  return useQuery({
    queryKey: ['platform', 'blog', 'list', status ?? ''],
    queryFn: () => get(`/platform/blog${qs({ status })}`, PlatformBlogSchema),
    refetchInterval: 30_000,
  });
}

const SummarySchema = z.object({
  pending: z.number().int(),
  /** Release posts waiting for approval. */
  pendingReleases: z.number().int().default(0),
  /** Videos waiting for approval. */
  pendingVideos: z.number().int().default(0),
  enabled: z.boolean(),
});
export function useBlogSummary() {
  return useQuery({
    queryKey: ['platform', 'blog', 'summary'],
    queryFn: () => get('/platform/blog/summary', SummarySchema),
    refetchInterval: 60_000,
  });
}

export function usePlatformPost(id: string | undefined) {
  return useQuery({
    queryKey: ['platform', 'blog', 'post', id],
    enabled: !!id,
    queryFn: () => get(`/platform/blog/posts/${id}`, BlogPostSchema),
  });
}

function useBlogMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'blog'] }),
  });
}

export const useEditPost = (id: string) =>
  useBlogMutation((v: Partial<Omit<BlogPost, 'id'>>) =>
    patch(`/platform/blog/posts/${id}`, v, BlogPostSchema),
  );
export const usePublishPost = (id: string) =>
  useBlogMutation(() => post(`/platform/blog/posts/${id}/publish`, undefined, BlogPostSchema));
export const useRejectPost = (id: string) =>
  useBlogMutation((reason: string) => post(`/platform/blog/posts/${id}/reject`, { reason }, BlogPostSchema));
export const useUnpublishPost = (id: string) =>
  useBlogMutation(() => post(`/platform/blog/posts/${id}/unpublish`, undefined, BlogPostSchema));
export const useSharePost = (id: string) =>
  useBlogMutation(() => post(`/platform/blog/posts/${id}/share`, undefined, BlogPostSchema));

export function usePatchBlogSettings() {
  return useBlogMutation((v: z.infer<typeof PatchBlogSettingsRequestSchema>) =>
    patch<BlogSettings>('/platform/blog/settings', v, BlogSettingsSchema),
  );
}

const DigestsSchema = z.object({
  digests: z.array(
    z.object({
      digestId: z.string(),
      state: z.string(),
      recipients: z.number(),
      posts: z.number(),
      createdAt: z.string(),
      note: z.string().nullable(),
    }),
  ),
});
export function useDigests() {
  return useQuery({
    queryKey: ['platform', 'blog', 'digests'],
    queryFn: () => get('/platform/blog/digests', DigestsSchema),
  });
}
export const useSendDigestTest = () =>
  useBlogMutation(() => post<{ sentTo: string; posts: number }>('/platform/blog/digests/test'));

export function useApiKeys() {
  return useQuery({
    queryKey: ['platform', 'blog', 'keys'],
    queryFn: async () => (await get('/platform/api-keys', z.object({ keys: z.array(ApiKeySchema) }))).keys,
  });
}
export function useApiKeyAudit() {
  return useQuery({
    queryKey: ['platform', 'blog', 'keys', 'audit'],
    queryFn: async () =>
      (await get('/platform/api-keys/audit', z.object({ requests: z.array(ApiKeyAuditRowSchema) }))).requests,
  });
}
export const useCreateApiKey = () =>
  useBlogMutation((v: z.input<typeof CreateApiKeyRequestSchema>) =>
    post('/platform/api-keys', v, CreatedApiKeySchema),
  );
export const useRevokeApiKey = () =>
  useBlogMutation((id: string) => post<{ keys: ApiKey[] }>(`/platform/api-keys/${id}/revoke`));

export const useConnectChannel = () =>
  useBlogMutation(
    (
      v: { network: string } & (
        | {
            accountId: string;
            accountName: string;
            accessToken: string;
            refreshToken?: string;
            expiresAt?: string | null;
          }
        | {
            apiKey: string;
            apiSecret: string;
            accessToken: string;
            accessSecret: string;
            accountName?: string;
          }
        | { handle: string; appPassword: string }
        | { refreshToken: string }
      ),
    ) => {
      const { network, ...body } = v;
      return put(`/platform/social/channels/${network}`, body);
    },
  );
export const useDisconnectChannel = () =>
  useBlogMutation((network: string) => del(`/platform/social/channels/${network}`));

// ---- release announcements (Platform > Blog > Releases)

export function useReleases() {
  return useQuery({
    queryKey: ['platform', 'blog', 'releases'],
    queryFn: () => get('/platform/social/releases', ReleaseListSchema),
    refetchInterval: 30_000,
  });
}
/** "Write by hand": starts a draft for a release with captions prefilled from the changelog. */
export const useCreateReleasePost = () =>
  useBlogMutation((version: string) =>
    post('/platform/social/posts', { kind: 'release', ref: version }, SocialPostSchema),
  );
export const useEditSocialPost = (id: string) =>
  useBlogMutation((v: { title?: string; summary?: string; captions?: unknown }) =>
    patch(`/platform/social/posts/${id}`, v, SocialPostSchema),
  );
export const useSocialPostAction = (id: string) =>
  useBlogMutation((v: { action: 'submit' | 'approve' | 'reject'; reason?: string }) =>
    post(
      `/platform/social/posts/${id}/${v.action}`,
      v.action === 'reject' ? { reason: v.reason } : undefined,
      SocialPostSchema,
    ),
  );

// ---- the server-side blog writer (platform job)

export function useBlogWriter() {
  return useQuery({
    queryKey: ['platform', 'blog', 'writer'],
    queryFn: () => get('/platform/blog/writer', BlogWriterSchema),
    refetchInterval: 20_000,
  });
}
export const usePatchBlogWriter = () =>
  useBlogMutation((v: PatchBlogWriterRequest) =>
    patch<BlogWriter>('/platform/blog/writer', v, BlogWriterSchema),
  );
/** Waits for the run (a minute or two) and answers with the run and the queued post. */
export const useWriteNow = () =>
  useBlogMutation(() => post('/platform/blog/writer/run', undefined, BlogWriterRunResultSchema));

// ---- the research-topic queue (Platform > Blog > Topics)

export function useBlogTopics() {
  return useQuery({
    queryKey: ['platform', 'blog', 'topics'],
    queryFn: () => get('/platform/blog/topics', BlogTopicListSchema),
    refetchInterval: 30_000,
  });
}
export const useAddBlogTopic = () =>
  useBlogMutation((v: CreateBlogTopicRequest) =>
    post<BlogTopicList & { status: 'queued' | 'duplicate'; topicId: string }>('/platform/blog/topics', v),
  );
export const useRejectBlogTopic = () =>
  useBlogMutation((v: { id: string; reason: string }) =>
    post<BlogTopicList>(`/platform/blog/topics/${v.id}/reject`, { reason: v.reason }, BlogTopicListSchema),
  );
export const useMoveBlogTopic = () =>
  useBlogMutation((id: string) =>
    post<BlogTopicList>(`/platform/blog/topics/${id}/move`, undefined, BlogTopicListSchema),
  );

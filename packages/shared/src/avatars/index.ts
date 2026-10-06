import { z } from 'zod';

/**
 * Generated cartoon faces (DiceBear, rendered in the browser from a seed: nothing is fetched). Only illustrated styles
 * whose artwork is CC0 are offered, so they can ship in a commercial product without attribution.
 */
export const AVATAR_STYLES = ['notionists', 'lorelei', 'open-peeps'] as const;
export const AvatarStyleSchema = z.enum(AVATAR_STYLES);
export type AvatarStyle = z.infer<typeof AvatarStyleSchema>;
export const DEFAULT_AVATAR_STYLE: AvatarStyle = 'notionists';
export const AVATAR_STYLE_LABEL: Record<AvatarStyle, string> = {
  notionists: 'Sketch',
  lorelei: 'Portrait',
  'open-peeps': 'Peeps',
};

export const AvatarSeedSchema = z.string().min(1).max(64);

/** A fresh random seed (eight base-36 characters). `random` is injectable for tests. */
export function randomAvatarSeed(random: () => number = Math.random): string {
  let s = '';
  while (s.length < 8) s += Math.floor(random() * 36 ** 4).toString(36);
  return s.slice(0, 8);
}

/** A user's picture: a generated face (seed and style) or an uploaded or photographed image (`version` busts the cache). */
export const UserAvatarSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cartoon'), seed: AvatarSeedSchema, style: AvatarStyleSchema }),
  z.object({ kind: z.literal('image'), version: z.string().min(1) }),
]);
export type UserAvatar = z.infer<typeof UserAvatarSchema>;

/** The largest accepted image: the browser sends a 256 px square PNG (a few tens of KB), the server refuses more. */
export const AVATAR_IMAGE_MAX_BYTES = 300 * 1024;
export const AVATAR_IMAGE_MAX_SIDE = 512;

/** `PUT /api/me/avatar`. `image` carries a PNG as base64; `none` goes back to the initials. */
export const SetMyAvatarRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cartoon'), seed: AvatarSeedSchema, style: AvatarStyleSchema }),
  z.object({
    kind: z.literal('image'),
    pngBase64: z
      .string()
      .min(1)
      .max(Math.ceil(AVATAR_IMAGE_MAX_BYTES * 1.4)),
  }),
  z.object({ kind: z.literal('none') }),
]);
export type SetMyAvatarRequest = z.infer<typeof SetMyAvatarRequestSchema>;

/** `POST /api/agents/:id/avatar/reroll`: a new random face (the style stays unless one is given). */
export const RerollAgentAvatarRequestSchema = z.object({ style: AvatarStyleSchema.optional() });
export type RerollAgentAvatarRequest = z.infer<typeof RerollAgentAvatarRequestSchema>;

/** The URL of an uploaded picture; `version` changes with each upload. */
export const userAvatarImageUrl = (userId: string, version: string): string =>
  `/api/users/${userId}/avatar?v=${encodeURIComponent(version)}`;

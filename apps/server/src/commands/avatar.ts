import { randomUUID } from 'node:crypto';
import {
  AVATAR_IMAGE_MAX_BYTES,
  AVATAR_IMAGE_MAX_SIDE,
  isOrgManager,
  type RerollAgentAvatarRequest,
  randomAvatarSeed,
  type SetMyAvatarRequest,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, forbidden, notFound, unprocessable } from '../errors.ts';
import { orgScope, projectScope, userActor, userScope } from './common.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height of a PNG from its header, or null when the bytes are not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * The picture of the signed-in user (their own only): a generated face, an uploaded or photographed image, or none.
 * The browser has already cropped it to a circle and shrunk it to 256 px; the server only accepts a small square PNG
 * (a real PNG, at most 512 px a side, at most 300 KB) and keeps it in `avatar_images`.
 */
export async function setMyAvatar(
  ctx: Ctx,
  user: AuthSession['user'],
  req: SetMyAvatarRequest,
): Promise<void> {
  let imageId: string | undefined;
  if (req.kind === 'image') {
    const data = Buffer.from(req.pngBase64, 'base64');
    if (data.length > AVATAR_IMAGE_MAX_BYTES)
      throw unprocessable('image_too_large', 'the picture is too large (300 KB at most)');
    const size = pngSize(data);
    if (!size) throw badRequest('not_a_png', 'the picture must be a PNG');
    if (size.width !== size.height || size.width < 32 || size.width > AVATAR_IMAGE_MAX_SIDE)
      throw unprocessable('bad_image_size', `the picture must be square, 32 to ${AVATAR_IMAGE_MAX_SIDE} px`);
    imageId = randomUUID();
    await exec(
      ctx.pool,
      'INSERT INTO avatar_images (id, user_id, mime, data, created_at) VALUES ($1,$2,$3,$4,$5)',
      [imageId, user.id, 'image/png', data, ctx.clock.now()],
    );
  }
  await withAppendTx(ctx.pool, async (tx) => {
    await ctx.store.append(
      [
        {
          streamId: streamId.user(user.id),
          event: {
            type: 'UserAvatarSet',
            payload: {
              userId: user.id,
              kind: req.kind,
              ...(req.kind === 'cartoon' ? { seed: req.seed, style: req.style } : {}),
              ...(imageId ? { imageId } : {}),
            },
          },
          actor: userActor(user.id),
          scope: userScope(user.id),
        },
      ],
      { tx },
    );
  });
  // Older uploads of this user are no longer referenced.
  await exec(ctx.pool, `DELETE FROM avatar_images WHERE user_id=$1 AND id IS DISTINCT FROM $2`, [
    user.id,
    imageId ?? null,
  ]).catch(() => undefined);
}

/** The image bytes the viewer may see: their own, or a user they share a project or an organization with. */
export async function avatarImageFor(
  ctx: Ctx,
  viewer: AuthSession['user'],
  userId: string,
): Promise<{ id: string; mime: string; data: Buffer } | undefined> {
  const row = await one<{ id: string; mime: string; data: Buffer }>(
    ctx.pool,
    `SELECT i.id, i.mime, i.data FROM users u JOIN avatar_images i ON i.id = u.avatar_image_id
      WHERE u.id = $1 AND u.avatar_kind = 'image'
        AND ($1 = $2 OR EXISTS (
          SELECT 1 FROM project_members a JOIN project_members b ON b.project_id = a.project_id
           WHERE a.user_id = $1 AND b.user_id = $2 AND a.status = 'active' AND b.status = 'active')
          OR EXISTS (
          SELECT 1 FROM org_members a JOIN org_members b ON b.org_id = a.org_id
           WHERE a.user_id = $1 AND b.user_id = $2 AND a.status = 'active' AND b.status = 'active'))`,
    [userId, viewer.id],
  );
  return row;
}

/** "Re-roll face": a new random seed for an agent the user manages (the org owner, or the manager who hired it). */
export async function rerollAgentAvatar(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
  req: RerollAgentAvatarRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await one(tx, 'SELECT * FROM agents WHERE id=$1 FOR UPDATE', [agentId]);
    if (!a) throw notFound('agent not found');
    if (user.id !== a.manager_user_id && !isOrgManager({ orgRole: await orgRoleOf(tx, user.id, a.org_id) }))
      throw forbidden(
        'only the organization Owner and Admins or the manager who hired this agent can change its face',
      );
    if (a.status === 'retired') throw unprocessable('agent_retired', 'a retired agent keeps its face');
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: {
            type: 'AgentAvatarRerolled',
            payload: {
              agentId,
              avatarSeed: randomAvatarSeed(),
              avatarStyle: req.style ?? a.avatar_style ?? 'notionists',
              by: user.id,
            },
          },
          actor: userActor(user.id),
          scope: a.project_id ? projectScope(a.org_id, a.project_id) : orgScope(a.org_id),
        },
      ],
      { tx },
    );
  });
}

import type { InvitationDto, UserAvatar, UserDto } from '@aom/shared';
import type { Row } from './db/sql.ts';
import { iso } from './db/sql.ts';

/** The picture stored on a `users` row (columns `avatar_*`), or null for the initials. */
export const userAvatarOf = (r: Row): UserAvatar | null =>
  r.avatar_kind === 'cartoon' && r.avatar_seed
    ? { kind: 'cartoon', seed: r.avatar_seed, style: r.avatar_style ?? 'notionists' }
    : r.avatar_kind === 'image' && r.avatar_image_id
      ? { kind: 'image', version: r.avatar_image_id }
      : null;

/** `role` (the retired app-wide administrator role) is still returned for the legacy /api/admin routes until step 8. */
export const toUserDto = (r: Row): UserDto =>
  ({
    role: r.legacy_role ?? undefined,
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    kind: r.kind ?? 'user',
    status: r.status,
    createdAt: iso(r.created_at) as string,
    lastLoginAt: iso(r.last_login_at),
    timezone: r.timezone ?? null,
    avatar: userAvatarOf(r),
    twoFactorEnabled: Boolean(r.two_factor_enabled),
  }) as UserDto;

export const toInvitationDto = (r: Row): InvitationDto => ({
  id: r.id,
  email: r.email,
  role: r.role,
  status: r.status,
  invitedBy: r.invited_by,
  expiresAt: iso(r.expires_at) as string,
  createdAt: iso(r.created_at) as string,
  acceptedAt: iso(r.accepted_at),
});

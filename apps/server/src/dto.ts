import type { InvitationDto, UserDto } from '@aom/shared';
import type { Row } from './db/sql.ts';
import { iso } from './db/sql.ts';

export const toUserDto = (r: Row): UserDto => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  role: r.role,
  status: r.status,
  createdAt: iso(r.created_at) as string,
  lastLoginAt: iso(r.last_login_at),
  timezone: r.timezone ?? null,
});

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

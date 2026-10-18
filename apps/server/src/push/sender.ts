import { randomUUID } from 'node:crypto';
import type { PushPayload } from '@aom/shared';
import webpush from 'web-push';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { DESK_VISIBLE } from '../queries/desk.ts';

/** A subscription answered with an error this many times in a row is dropped (the push service never said "gone"). */
export const MAX_CONSECUTIVE_FAILURES = 15;

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** "iPhone Safari", "Android Chrome", ... from a user agent (a label for the device list, nothing more). */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /CriOS|Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'browser';
  return `${os} ${browser}`;
}

export async function addSubscription(
  ctx: Ctx,
  userId: string,
  sub: { endpoint: string; p256dh: string; auth: string; label: string },
): Promise<string> {
  const id = randomUUID();
  // The same browser subscribing again (or another account signed in on it) takes the endpoint over.
  const r = await one<{ id: string }>(
    ctx.pool,
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, label, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth,
       label=EXCLUDED.label, failure_count=0
     RETURNING id`,
    [id, userId, sub.endpoint, sub.p256dh, sub.auth, sub.label, ctx.clock.now()],
  );
  return r?.id ?? id;
}

export async function subscriptionsOf(ctx: Ctx, userId: string): Promise<SubRow[]> {
  return rows<SubRow>(
    ctx.pool,
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1 ORDER BY created_at',
    [userId],
  );
}

/** Open desk items the person sees: the number on the app icon. */
export async function badgeCountFor(ctx: Ctx, userId: string): Promise<number> {
  const r = await one<{ n: string }>(
    ctx.pool,
    `SELECT count(*) AS n FROM desk_items d WHERE d.status='open' AND ${DESK_VISIBLE}`,
    [userId],
  );
  return Number(r?.n ?? 0);
}

/**
 * Sends one payload to every device of `userId`. 404/410 from the push service delete the subscription; other failures
 * are counted. Never throws (a failed push must not fail whatever raised it).
 */
export async function sendToUser(
  ctx: Ctx,
  userId: string,
  payload: PushPayload,
  opts: { urgency?: 'normal' | 'high'; ttlSeconds?: number } = {},
): Promise<{ sent: number; failed: number }> {
  const { publicKey, privateKey, subject } = ctx.config.push;
  if (!ctx.config.push.enabled || !publicKey || !privateKey || !subject) return { sent: 0, failed: 0 };
  const subs = await subscriptionsOf(ctx, userId);
  let sent = 0;
  let failed = 0;
  const body = JSON.stringify(payload);
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        {
          vapidDetails: { subject, publicKey, privateKey },
          TTL: opts.ttlSeconds ?? 24 * 3600,
          urgency: opts.urgency === 'high' ? 'high' : 'normal',
        },
      );
      sent++;
      await exec(ctx.pool, 'UPDATE push_subscriptions SET last_success_at=$2, failure_count=0 WHERE id=$1', [
        s.id,
        ctx.clock.now(),
      ]);
    } catch (err) {
      failed++;
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await exec(ctx.pool, 'DELETE FROM push_subscriptions WHERE id=$1', [s.id]).catch(() => 0);
        continue;
      }
      ctx.log.warn({ status, subscriptionId: s.id }, 'web push failed');
      await exec(
        ctx.pool,
        `UPDATE push_subscriptions SET last_failure_at=$2, failure_count=failure_count+1 WHERE id=$1`,
        [s.id, ctx.clock.now()],
      ).catch(() => 0);
      await exec(ctx.pool, 'DELETE FROM push_subscriptions WHERE id=$1 AND failure_count >= $2', [
        s.id,
        MAX_CONSECUTIVE_FAILURES,
      ]).catch(() => 0);
    }
  }
  return { sent, failed };
}

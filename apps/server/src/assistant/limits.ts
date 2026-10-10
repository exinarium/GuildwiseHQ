import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';

/** Messages one visitor address may send: per hour and per day (UTC). */
export const LIMITS = { perHour: 20, perDay: 40 } as const;
/** From this many messages in an hour, or in one conversation, a proof of work comes with each message. */
export const POW_AFTER = 5;
/** Leading zero bits the proof of work needs: about 65,000 hashes, under a second in a browser. */
export const POW_BITS = 16;
const POW_TTL_MS = 5 * 60_000;

const PROCESS_KEY = randomBytes(32);
const secret = (ctx: Ctx): Buffer => (ctx.config.secretKey ? Buffer.from(ctx.config.secretKey) : PROCESS_KEY);

/** The visitor's address, salted and hashed: the only trace of a visitor, and only inside a counter key. */
export const ipHash = (ctx: Ctx, ip: string): string =>
  createHmac('sha256', secret(ctx)).update(`assistant-ip|${ip}`).digest('hex').slice(0, 24);

const hourBucket = (d: Date) => `h:${d.toISOString().slice(0, 13)}`;
const dayBucket = (d: Date) => `d:${d.toISOString().slice(0, 10)}`;

async function readCount(ctx: Ctx, key: string, bucket: string): Promise<number> {
  const r = await one<{ n: string }>(
    ctx.pool,
    'SELECT n FROM assistant_counters WHERE key=$1 AND bucket=$2',
    [key, bucket],
  );
  return r ? Number(r.n) : 0;
}

async function bump(ctx: Ctx, key: string, bucket: string, by: number): Promise<void> {
  await exec(
    ctx.pool,
    `INSERT INTO assistant_counters (key, bucket, n, updated_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (key, bucket) DO UPDATE SET n = assistant_counters.n + EXCLUDED.n, updated_at = EXCLUDED.updated_at`,
    [key, bucket, by, ctx.clock.now()],
  );
}

export interface VisitorCounts {
  hour: number;
  day: number;
}

/** What this visitor has sent so far (before the message being handled). */
export async function visitorCounts(ctx: Ctx, hash: string): Promise<VisitorCounts> {
  const now = ctx.clock.now();
  return {
    hour: await readCount(ctx, `ip:${hash}`, hourBucket(now)),
    day: await readCount(ctx, `ip:${hash}`, dayBucket(now)),
  };
}

/** Counts one message for the visitor and for the day, and drops counters older than two days. */
export async function countMessage(ctx: Ctx, hash: string): Promise<void> {
  const now = ctx.clock.now();
  await bump(ctx, `ip:${hash}`, hourBucket(now), 1);
  await bump(ctx, `ip:${hash}`, dayBucket(now), 1);
  await bump(ctx, 'all', dayBucket(now), 1);
  await exec(ctx.pool, `DELETE FROM assistant_counters WHERE updated_at < $1`, [
    new Date(now.getTime() - 2 * 86_400_000),
  ]);
}

// ------------------------------------------------------------------------------------------------ spend

/** Micro-US-dollars per token at Haiku 4.5 prices: $1 per million input, $5 per million output; cache write 1.25x, read 0.1x. */
export function costMicros(u: {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}): number {
  return Math.ceil(u.input * 1 + u.cacheWrite * 1.25 + u.cacheRead * 0.1 + u.output * 5);
}

export async function spentTodayMicros(ctx: Ctx): Promise<number> {
  return readCount(ctx, 'spend', dayBucket(ctx.clock.now()));
}
export async function messagesToday(ctx: Ctx): Promise<number> {
  return readCount(ctx, 'all', dayBucket(ctx.clock.now()));
}
export async function addSpend(ctx: Ctx, micros: number): Promise<void> {
  if (micros > 0) await bump(ctx, 'spend', dayBucket(ctx.clock.now()), micros);
}

const CAP_KEY = 'assistant_daily_cap_usd';

/** The daily spend cap in US dollars: the super admin's setting if there is one, else the server's initial default ($2). */
export async function dailyCapUsd(ctx: Ctx): Promise<{ usd: number; overridden: boolean }> {
  const r = await one<{ value: unknown }>(ctx.pool, 'SELECT value FROM platform_settings WHERE key=$1', [
    CAP_KEY,
  ]);
  if (typeof r?.value === 'number' && r.value >= 0) return { usd: r.value, overridden: true };
  return { usd: ctx.config.assistantPublicDailyUsd, overridden: false };
}

/** Sets the daily cap (super admin); null goes back to the server default. */
export async function setDailyCapUsd(ctx: Ctx, by: string, usd: number | null): Promise<void> {
  if (usd === null) {
    await exec(ctx.pool, 'DELETE FROM platform_settings WHERE key=$1', [CAP_KEY]);
    return;
  }
  await exec(
    ctx.pool,
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [CAP_KEY, JSON.stringify(usd), by, ctx.clock.now()],
  );
}

export const capReached = async (ctx: Ctx): Promise<boolean> =>
  (await spentTodayMicros(ctx)) >= (await dailyCapUsd(ctx)).usd * 1_000_000;

// ------------------------------------------------------------------------------------------ proof of work

const used = new Map<string, number>();

const sign = (ctx: Ctx, body: string): string =>
  createHmac('sha256', secret(ctx)).update(`assistant-pow|${body}`).digest('hex').slice(0, 32);

/** A fresh challenge: `<expiry ms>.<random>.<signature>`. Stateless; replays are refused in memory. */
export function newChallenge(ctx: Ctx): { challenge: string; bits: number } {
  const body = `${ctx.clock.now().getTime() + POW_TTL_MS}.${randomBytes(9).toString('hex')}`;
  return { challenge: `${body}.${sign(ctx, body)}`, bits: POW_BITS };
}

const leadingZeroBits = (buf: Buffer): number => {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) n += 8;
    else {
      n += Math.clz32(byte) - 24;
      break;
    }
  }
  return n;
};

/** Does `sha256(challenge + ':' + nonce)` have enough leading zero bits, for a challenge we signed and not seen? */
export function checkPow(ctx: Ctx, pow: { challenge: string; nonce: string } | undefined): boolean {
  if (!pow) return false;
  const parts = pow.challenge.split('.');
  if (parts.length !== 3) return false;
  const [exp, rnd, sig] = parts as [string, string, string];
  const want = sign(ctx, `${exp}.${rnd}`);
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  const now = ctx.clock.now().getTime();
  if (!(Number(exp) > now)) return false;
  for (const [k, e] of used) if (e < now) used.delete(k);
  if (used.has(pow.challenge)) return false;
  const digest = createHash('sha256').update(`${pow.challenge}:${pow.nonce}`).digest();
  if (leadingZeroBits(digest) < POW_BITS) return false;
  used.set(pow.challenge, Number(exp));
  return true;
}

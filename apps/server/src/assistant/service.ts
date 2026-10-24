import {
  ASSISTANT_LIMITS,
  type AssistantChatRequest,
  type AssistantEvent,
  type PlatformAssistant,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import { HttpError } from '../errors.ts';
import {
  addSpend,
  capReached,
  checkPow,
  costMicros,
  countMessage,
  dailyCapUsd,
  ipHash,
  LIMITS,
  messagesToday,
  POW_AFTER,
  setDailyCapUsd,
  spentTodayMicros,
  visitorCounts,
} from './limits.ts';
import { publicSystemText } from './prompt.ts';
import { relevantHelpBlock, selectTopics } from './topics.ts';

/**
 * The part of the Anthropic SDK the assistant uses: `messages.stream(params)` returns something async-iterable of the
 * raw stream events. The real `Anthropic` client fits; tests pass a fake. Nothing else of the SDK is touched.
 */
export interface LlmStream extends AsyncIterable<{ type: string; [k: string]: any }> {
  abort?(): void;
}
export interface AnthropicLike {
  messages: { stream(params: Record<string, unknown>): LlmStream };
}

const SETTING_KEY = 'assistant_public_enabled';
export const MAX_TOKENS = 600;

/** The super admin's switch (default on). */
export async function adminEnabled(ctx: Ctx): Promise<boolean> {
  const r = await one<{ value: unknown }>(ctx.pool, 'SELECT value FROM platform_settings WHERE key=$1', [
    SETTING_KEY,
  ]);
  return r?.value !== false;
}

export async function setAdminEnabled(ctx: Ctx, by: string, enabled: boolean): Promise<void> {
  await exec(
    ctx.pool,
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [SETTING_KEY, JSON.stringify(enabled), by, ctx.clock.now()],
  );
}

export { setDailyCapUsd };

export type Availability = { available: true } | { available: false; reason: 'off' | 'busy' };

/** The kill switch (environment), the super admin's switch, and the day's spend cap, in that order. */
export async function availability(ctx: Ctx, client: AnthropicLike | null): Promise<Availability> {
  if (ctx.config.assistantMode !== 'public' || !client) return { available: false, reason: 'off' };
  if (!(await adminEnabled(ctx))) return { available: false, reason: 'off' };
  if (await capReached(ctx)) return { available: false, reason: 'busy' };
  return { available: true };
}

export async function platformAssistant(ctx: Ctx, client: AnthropicLike | null): Promise<PlatformAssistant> {
  const a = await availability(ctx, client);
  const cap = await dailyCapUsd(ctx);
  return {
    enabled: await adminEnabled(ctx),
    mode: ctx.config.assistantMode,
    keyConfigured: !!ctx.config.anthropicApiKey,
    model: ctx.config.assistantModelPublic,
    dailyCapUsd: cap.usd,
    defaultCapUsd: ctx.config.assistantPublicDailyUsd,
    capOverridden: cap.overridden,
    spentTodayUsd: (await spentTodayMicros(ctx)) / 1_000_000,
    messagesToday: await messagesToday(ctx),
    live: a.available,
  };
}

/** The conversation must alternate, start and end with the visitor, and respect the length caps. */
function validate(messages: AssistantChatRequest['messages']): void {
  const bad = (msg: string) => new HttpError(400, 'bad_conversation', msg);
  messages.forEach((m, i) => {
    if ((i % 2 === 0) !== (m.role === 'user'))
      throw bad('messages must alternate, starting with the visitor');
    if (m.role === 'user' && m.content.length > ASSISTANT_LIMITS.userChars)
      throw bad(`a message may be at most ${ASSISTANT_LIMITS.userChars} characters`);
  });
  if (messages.at(-1)?.role !== 'user') throw bad('the last message must come from the visitor');
}

/**
 * Checks everything that can refuse a message before the model is called (switches, spend cap, conversation shape,
 * the visitor's hourly and daily limits, the proof of work) and counts the message. Returns the hash to bill to.
 */
export async function admit(
  ctx: Ctx,
  client: AnthropicLike | null,
  ip: string,
  body: AssistantChatRequest,
): Promise<void> {
  const a = await availability(ctx, client);
  if (!a.available)
    throw new HttpError(
      503,
      a.reason === 'busy' ? 'busy' : 'unavailable',
      a.reason === 'busy'
        ? 'The assistant has reached its limit for today. Please use Contact us.'
        : 'The assistant is not available.',
    );
  validate(body.messages);
  const hash = ipHash(ctx, ip);
  const seen = await visitorCounts(ctx, hash);
  if (seen.hour >= LIMITS.perHour || seen.day >= LIMITS.perDay)
    throw new HttpError(
      429,
      'rate_limited',
      seen.day >= LIMITS.perDay
        ? 'You have reached the limit for today. Please use Contact us.'
        : 'You have sent a lot of messages. Please try again in a while, or use Contact us.',
    );
  const userTurns = body.messages.filter((m) => m.role === 'user').length;
  if ((seen.hour >= POW_AFTER || userTurns > POW_AFTER) && !checkPow(ctx, body.pow))
    throw new HttpError(403, 'pow_required', 'A small proof of work is needed before the next message.');
  await countMessage(ctx, hash);
}

/** Streams the model's answer as events; records only the spend. Never throws: failures become an `error` event. */
export async function* answer(
  ctx: Ctx,
  client: AnthropicLike,
  body: AssistantChatRequest,
  signal?: { aborted: boolean; onAbort?: (fn: () => void) => void },
): AsyncGenerator<AssistantEvent> {
  const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const last = body.messages.length - 1;
  const help = relevantHelpBlock(selectTopics(body.messages, { page: body.page }));
  // The system text and the conversation so far are the cached prefix; the breakpoint on the newest turn lets the
  // next turn read the history from cache.
  const params = {
    model: ctx.config.assistantModelPublic,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: publicSystemText(), cache_control: { type: 'ephemeral' } }],
    messages: body.messages.map((m, i) => ({
      role: m.role,
      content: [
        // the help articles that match the question travel with the newest visitor message (the system text stays the same)
        ...(i === last && help ? [{ type: 'text', text: help }] : []),
        { type: 'text', text: m.content, ...(i === last ? { cache_control: { type: 'ephemeral' } } : {}) },
      ],
    })),
  };
  let stream: LlmStream | undefined;
  try {
    stream = client.messages.stream(params);
    signal?.onAbort?.(() => stream?.abort?.());
    for await (const ev of stream) {
      if (ev.type === 'message_start') {
        const u = ev.message?.usage ?? {};
        usage.input = u.input_tokens ?? 0;
        usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
        usage.cacheRead = u.cache_read_input_tokens ?? 0;
        usage.output = u.output_tokens ?? 0;
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        yield { type: 'delta', text: String(ev.delta.text ?? '') };
      } else if (ev.type === 'message_delta') {
        const u = ev.usage ?? {};
        if (typeof u.output_tokens === 'number') usage.output = u.output_tokens;
        if (typeof u.input_tokens === 'number') usage.input = u.input_tokens;
        if (typeof u.cache_read_input_tokens === 'number') usage.cacheRead = u.cache_read_input_tokens;
        if (typeof u.cache_creation_input_tokens === 'number')
          usage.cacheWrite = u.cache_creation_input_tokens;
      }
      if (signal?.aborted) break;
    }
    yield { type: 'done' };
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, 'assistant model call failed');
    yield { type: 'error', code: 'model_error' };
  } finally {
    // Whatever was generated is paid for, even when the visitor left half way.
    await addSpend(ctx, costMicros(usage)).catch((e) =>
      ctx.log.warn({ err: String(e) }, 'assistant spend not recorded'),
    );
  }
}

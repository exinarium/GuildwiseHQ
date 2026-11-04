import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import type { DeliverySendResult, JourneyWebhookCallPayload } from '@aom/shared';
import { z } from 'zod';
import { SealedFile } from '../secrets/sealed-file.ts';

/** `secrets/webhooks.json` (encrypted): the firm's webhook credentials by name (a header value, or a signing secret). */
export const WebhookSecretsSchema = z.object({
  credentials: z.record(z.string(), z.object({ value: z.string() })).default({}),
});
export type WebhookSecrets = z.infer<typeof WebhookSecretsSchema>;

export const webhookStore = (secretsDir: string, keyOf: (name: string) => Buffer) =>
  new SealedFile<WebhookSecrets>(join(secretsDir, 'webhooks.json'), keyOf, WebhookSecretsSchema, (v) =>
    Object.values(v.credentials).map((c) => c.value),
  );

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const TIMEOUT_MS = 10_000;
const retryable = (s: number): boolean => s === 408 || s === 425 || s === 429 || s >= 500;

/**
 * Runs a `journey.webhook.call`: the firm's URL is called from this workstation, with the credential headers and the
 * optional signature taken from the sealed store. Never throws. The response body is read and discarded; the log line is the
 * call id, the status and the duration only (no URL, header value or body).
 */
export class JourneyWebhookCaller {
  constructor(
    private readonly deps: {
      secretsDir: string;
      keyOf: (name: string) => Buffer;
      fetch?: Fetch;
      now?: () => number;
      log?: (line: string) => void;
    },
  ) {}

  async run(p: JourneyWebhookCallPayload): Promise<DeliverySendResult> {
    const started = Date.now();
    const result = await this.send(p).catch(
      (): DeliverySendResult => ({ ok: false, error: 'the workstation could not send', retryable: true }),
    );
    this.deps.log?.(
      `journey.webhook.call call=${p.callId} attempt=${p.attempt} ${result.httpStatus ?? 'no-status'} ${result.ok ? 'ok' : 'failed'} ${Date.now() - started}ms`,
    );
    return result;
  }

  private async send(p: JourneyWebhookCallPayload): Promise<DeliverySendResult> {
    const store = webhookStore(this.deps.secretsDir, this.deps.keyOf).load();
    const headers: Record<string, string> = {};
    for (const h of p.headers) headers[h.name.toLowerCase()] = h.value;
    for (const c of p.credentialHeaders) {
      const cred = store?.credentials[c.credential];
      if (!cred)
        return {
          ok: false,
          error: `the credential "${c.credential}" is not stored on this workstation`,
          retryable: false,
        };
      headers[c.name.toLowerCase()] = cred.value;
    }
    const ts = String(Math.floor((this.deps.now?.() ?? Date.now()) / 1000));
    headers['user-agent'] = 'GuildwiseHQ-Journey/1';
    headers['x-guildwise-delivery'] = p.callId;
    headers['x-guildwise-timestamp'] = ts;
    const hasBody = p.method !== 'GET' && p.method !== 'DELETE';
    if (hasBody) headers['content-type'] = p.contentType;
    if (p.signWith) {
      const key = store?.credentials[p.signWith];
      if (!key)
        return {
          ok: false,
          error: `the signing secret "${p.signWith}" is not stored on this workstation`,
          retryable: false,
        };
      headers['x-guildwise-signature'] = `sha256=${createHmac('sha256', key.value)
        .update(`${ts}.${hasBody ? p.body : ''}`)
        .digest('hex')}`;
    }
    const f = this.deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
    const t0 = Date.now();
    try {
      const res = await f(p.url, {
        method: p.method,
        headers,
        ...(hasBody ? { body: p.body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.ok) return { ok: true, httpStatus: res.status, retryable: false };
      return {
        ok: false,
        httpStatus: res.status,
        error:
          res.status >= 300 && res.status < 400
            ? `the address answered with a redirect (${res.status}), which is not followed`
            : `the address answered ${res.status}`,
        retryable: retryable(res.status),
      };
    } catch (err) {
      const timedOut = (err as Error).name === 'TimeoutError' || Date.now() - t0 >= TIMEOUT_MS;
      return {
        ok: false,
        error: timedOut ? 'the address did not answer in time' : 'the address could not be reached',
        retryable: true,
      };
    }
  }
}

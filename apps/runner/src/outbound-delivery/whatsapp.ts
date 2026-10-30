import type { DeliverySendResult } from '@aom/shared';
import { redactSecrets } from '../secrets/redact.ts';

/** One place for the Graph API version. */
export const GRAPH_VERSION = 'v21.0';
const TIMEOUT_MS = 10_000;

export interface WhatsappSend {
  to: string[];
  template?: { name: string; language: string } | undefined;
  text: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface GraphError {
  error?: { message?: string; code?: number; error_data?: { details?: string } };
}

const retryable = (status: number): boolean => status >= 500 || status === 429 || status === 408;

/** The request body for one recipient: a template message (outside the 24-hour window) or a plain text. */
export function whatsappBody(to: string, m: WhatsappSend): Record<string, unknown> {
  const number = to.replace(/^\+/, '');
  if (m.template)
    return {
      messaging_product: 'whatsapp',
      to: number,
      type: 'template',
      template: {
        name: m.template.name,
        language: { code: m.template.language },
        components: [{ type: 'body', parameters: [{ type: 'text', text: m.text }] }],
      },
    };
  return {
    messaging_product: 'whatsapp',
    to: number,
    type: 'text',
    text: { preview_url: true, body: m.text },
  };
}

/** The reason shown on the schedule: the provider's code and a short message. Never the message text or the token. */
function reasonOf(status: number, body: GraphError, hasTemplate: boolean): { error: string; final: boolean } {
  const code = body.error?.code;
  if (status === 401 || code === 190)
    return { error: 'WhatsApp refused the access token: reconnect on the Integrations page', final: true };
  if (code === 131047 || code === 131026)
    return {
      error: hasTemplate
        ? `WhatsApp could not deliver the template message (code ${code})`
        : 'outside the 24-hour window: set an approved template on this destination',
      final: true,
    };
  const msg = (body.error?.message ?? '').slice(0, 200);
  return {
    error: redactSecrets(
      `WhatsApp answered ${status}${code ? ` (code ${code})` : ''}${msg ? `: ${msg}` : ''}`,
    ).slice(0, 300),
    final: !retryable(status),
  };
}

export async function sendWhatsapp(
  creds: { phoneNumberId: string; accessToken: string },
  m: WhatsappSend,
  fetchImpl: Fetch = fetch,
): Promise<DeliverySendResult> {
  let sent = 0;
  const failed: Array<{ to: string; error: string; final: boolean; status?: number }> = [];
  for (const to of m.to) {
    try {
      const res = await fetchImpl(
        `https://graph.facebook.com/${GRAPH_VERSION}/${creds.phoneNumberId}/messages`,
        {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${creds.accessToken}` },
          body: JSON.stringify(whatsappBody(to, m)),
        },
      );
      if (res.status >= 200 && res.status < 300) {
        sent++;
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as GraphError;
      const r = reasonOf(res.status, body, Boolean(m.template));
      failed.push({ to, error: r.error, final: r.final, status: res.status });
    } catch (err) {
      failed.push({
        to,
        error: redactSecrets(
          `could not reach WhatsApp: ${err instanceof Error ? err.message : String(err)}`,
        ).slice(0, 200),
        final: false,
      });
    }
  }
  if (failed.length === 0) return { ok: true, retryable: false };
  const first = failed[0] as (typeof failed)[number];
  // A retry would send again to the numbers that already got it: retry only when nobody did.
  const canRetry = sent === 0 && failed.every((f) => !f.final);
  const who = failed.length > 1 || sent > 0 ? ` (${failed.length} of ${m.to.length} numbers failed)` : '';
  return {
    ok: false,
    ...(first.status ? { httpStatus: first.status } : {}),
    error: `${first.error}${who}`.slice(0, 500),
    retryable: canRetry,
  };
}

/** Checks a phone number ID and token without sending anything. Returns the display number, or the reason. */
export async function checkWhatsapp(
  creds: { phoneNumberId: string; accessToken: string },
  fetchImpl: Fetch = fetch,
): Promise<{ ok: true; account: string } | { ok: false; error: string; refused: boolean }> {
  try {
    const res = await fetchImpl(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(creds.phoneNumberId)}?fields=display_phone_number,verified_name`,
      {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { authorization: `Bearer ${creds.accessToken}` },
      },
    );
    const body = (await res.json().catch(() => ({}))) as GraphError & {
      display_phone_number?: string;
      verified_name?: string;
    };
    if (res.status >= 200 && res.status < 300)
      return { ok: true, account: body.display_phone_number ?? body.verified_name ?? creds.phoneNumberId };
    return {
      ok: false,
      refused: res.status === 401 || res.status === 400 || res.status === 403,
      error: reasonOf(res.status, body, true).error,
    };
  } catch (err) {
    return {
      ok: false,
      refused: false,
      error: redactSecrets(
        `could not reach WhatsApp: ${err instanceof Error ? err.message : String(err)}`,
      ).slice(0, 200),
    };
  }
}

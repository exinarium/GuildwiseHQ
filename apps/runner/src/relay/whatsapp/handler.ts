import { createHash } from 'node:crypto';
import type { RelayEvent, RelayHandler } from '../dispatch.ts';
import { relayEventFile, type RelaySink } from '../generic.ts';
import type { WhatsAppSecretStore } from './store.ts';
import { verifyHandshake, verifySignature } from './verify.ts';

export interface InboundEvent {
  requestId: string;
  integrationId: string;
  kind: 'whatsapp_cloud';
  receivedAt: string;
  file: string;
  bodySha256: string;
  summary: { phoneNumberIds: string[]; fields: string[]; messages: number; statuses: number };
}
export interface RelayIntake {
  accept(e: InboundEvent): Promise<void>;
}
export const noopIntake: RelayIntake = { accept: async () => {} };

const headerValues = (e: RelayEvent, name: string): string[] =>
  e.headers.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v);

/** Counts only; read after the signature was verified. Never kept or logged beyond these numbers and ids. */
function summarize(body: Buffer): InboundEvent['summary'] {
  const out = { phoneNumberIds: [] as string[], fields: [] as string[], messages: 0, statuses: 0 };
  try {
    const j = JSON.parse(body.toString('utf8')) as {
      entry?: Array<{ changes?: Array<{ field?: unknown; value?: Record<string, unknown> }> }>;
    };
    for (const en of j.entry ?? [])
      for (const ch of en.changes ?? []) {
        if (typeof ch.field === 'string' && !out.fields.includes(ch.field)) out.fields.push(ch.field);
        const v = ch.value ?? {};
        const pid = (v.metadata as { phone_number_id?: unknown } | undefined)?.phone_number_id;
        if (typeof pid === 'string' && !out.phoneNumberIds.includes(pid)) out.phoneNumberIds.push(pid);
        if (Array.isArray(v.messages)) out.messages += v.messages.length;
        if (Array.isArray(v.statuses)) out.statuses += v.statuses.length;
      }
  } catch {
    // not JSON: still a signed event, delivered as it is
  }
  return out;
}

/** The `whatsapp_cloud` relay handler: handshake and signature on this workstation, then the raw event to the local inbox. */
export function whatsAppHandler(deps: {
  store: Pick<WhatsAppSecretStore, 'get'>;
  sink: RelaySink;
  sinkDir: string;
  intake: RelayIntake;
}): RelayHandler {
  return async (e, ctx) => {
    const t0 = Date.now();
    const note = (outcome: string, status: number, extra = '') =>
      ctx.log.info(
        `relay whatsapp_cloud ${e.integrationId} ${e.method} ${status} ${outcome} bytes=${e.body.length} ms=${Date.now() - t0}${extra}`,
      );
    const s = deps.store.get(e.integrationId);
    if (!s) {
      note('no_binding', 503);
      return { status: 503 };
    }
    if (e.method === 'GET') {
      const r = verifyHandshake(e.query, s.verifyToken);
      if (r.status === 200) {
        note('handshake_ok', 200);
        return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: r.body };
      }
      note('handshake_refused', r.status);
      return { status: r.status };
    }
    if (e.method !== 'POST') return { status: 405 };
    const sigs = headerValues(e, 'x-hub-signature-256');
    const verdict =
      sigs.length > 1 ? 'malformed' : verifySignature(e.body, sigs[0], s.appSecret);
    if (verdict !== 'ok') {
      const status = verdict === 'missing' ? 401 : 403;
      note(verdict === 'missing' ? 'sig_missing' : 'sig_invalid', status);
      return { status };
    }
    const summary = summarize(e.body);
    if (s.phoneNumberId && summary.phoneNumberIds.length > 0 && !summary.phoneNumberIds.includes(s.phoneNumberId)) {
      note('ignored:other_number', 200);
      return { status: 200 };
    }
    await deps.sink.put(e);
    const event: InboundEvent = {
      requestId: e.requestId,
      integrationId: e.integrationId,
      kind: 'whatsapp_cloud',
      receivedAt: e.receivedAt.toISOString(),
      file: relayEventFile(deps.sinkDir, e),
      bodySha256: createHash('sha256').update(e.body).digest('hex'),
      summary,
    };
    note('delivered', 200, ` messages=${summary.messages} statuses=${summary.statuses}`);
    setImmediate(() => {
      void deps.intake.accept(event).catch(() => ctx.log.warn(`relay whatsapp_cloud ${e.integrationId} intake failed`));
    });
    return { status: 200 };
  };
}

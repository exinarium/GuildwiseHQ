import { q } from './db.ts';
import type { FakeRunner } from './fake-runner.ts';
import { ok, type World } from './world.ts';

/** Switches the world's organization to Business mode (straight in the table: the blockers are not under test). */
export async function makeBusiness(w: World): Promise<void> {
  await q(`UPDATE organizations SET mode='business' WHERE id=$1`, [w.owner.id]);
}

export interface Made {
  integration: { id: string; kind: string; status: string };
  url: string;
  /** The path of the public URL, `/relay/in/<token>`. */
  path: string;
}

export async function createIntegration(w: World, kind = 'generic', label = 'Shop'): Promise<Made> {
  const r = await ok<any>(
    w.t.req('POST', '/api/relay/integrations', { cookie: w.owner.cookie, body: { kind, label } }),
    201,
  );
  return { ...r, path: new URL(r.url).pathname };
}

/** Announces the integrations the fake runner serves and waits for the server's answer. */
export async function serve(
  r: FakeRunner,
  items: { integrationId: string; kind: string }[],
): Promise<{ accepted: string[]; refused: { integrationId: string; reason: string }[] }> {
  const from = r.received.length;
  r.send('relay.serve', { integrations: items });
  return r.waitFor('relay.serve.result', () => true, 5000, from);
}

/** Answers every relay.request the runner receives with `reply`, and returns the requests it saw. */
export function autoReply(
  r: FakeRunner,
  reply: (f: any) => { status: number; headers?: Record<string, string>; body?: Buffer | string } | null,
): any[] {
  const seen: any[] = [];
  r.ws.on('message', (data) => {
    const f = JSON.parse(data.toString());
    if (f.type !== 'relay.request') return;
    seen.push(f);
    const a = reply(f);
    if (!a) return;
    r.send('relay.response', {
      requestId: f.requestId,
      status: a.status,
      ...(a.headers ? { headers: a.headers } : {}),
      ...(a.body !== undefined ? { body: Buffer.from(a.body).toString('base64') } : {}),
    });
  });
  return seen;
}

export const relayRows = () =>
  q(
    'SELECT at, org_id, integration_id, kind, method, size_bytes, status, latency_ms, outcome FROM relay_requests ORDER BY id',
  );

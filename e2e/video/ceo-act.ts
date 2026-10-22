// Run with the server's tsx (`pnpm --filter @aom/server exec tsx <this file> <json>`), recording only: lets the demo
// organization's CEO take a few real decisions through the server's own action engine, so the CEO video has an
// activity log with something to undo. The mock CEO of a recording only acts on back-offs and blocking questions; the
// actions here (pause an agent, set a priority, move a card, raise a card's model) are the same calls a real CEO makes
// with `aom ceo act`, checked against the policy and written as events. Argument: a JSON array of
// `{ action, params, reason, confidence }`; prints one result line per action.

import { createApp } from '../../apps/server/src/app.ts';
import { makeEnv, ownerPrincipal, runAction } from '../../apps/server/src/ceo/engine.ts';
import { loadCeo } from '../../apps/server/src/ceo/state.ts';
import { loadConfig } from '../../apps/server/src/config.ts';
import { one } from '../../apps/server/src/db/sql.ts';

interface Act {
  action: string;
  params: Record<string, unknown>;
  reason: string;
  confidence: number;
}

const acts = JSON.parse(process.argv[2] ?? '[]') as Act[];
const config = loadConfig();
const app = await createApp(config, { background: false });
const ctx = app.ctx;
try {
  const org = await one<{ org_id: string; agent_id: string }>(
    ctx.pool,
    'SELECT org_id, agent_id FROM ceo_settings WHERE agent_id IS NOT NULL ORDER BY org_id LIMIT 1',
    [],
  );
  if (!org) throw new Error('no CEO');
  for (const a of acts) {
    const ceo = await loadCeo(ctx.pool, org.org_id);
    if (!ceo) throw new Error('no CEO state');
    const agent = await one<{ id: string; name: string }>(
      ctx.pool,
      'SELECT id, name FROM agents WHERE id=$1',
      [org.agent_id],
    );
    const owner = await ownerPrincipal(ctx, org.org_id);
    const origin = { kind: 'wake' as const, scopeId: `video:${a.action}`, untrusted: false };
    const env = makeEnv(ctx, ceo, agent as { id: string; name: string }, owner, origin);
    const r = await runAction(
      env,
      {
        op: 'act',
        action: a.action as never,
        params: a.params,
        reason: a.reason,
        confidence: a.confidence,
        evidence: [],
        dryRun: false,
      },
      origin,
    );
    console.log(JSON.stringify({ action: a.action, status: r.status, mode: r.mode, message: r.message }));
  }
} finally {
  await app.close();
}

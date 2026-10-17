import type { PlatformBugDto } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { iso, type Row, rows } from '../db/sql.ts';

const bugDto = (r: Row): PlatformBugDto => ({
  signature: r.signature,
  source: r.source,
  title: r.title,
  severity: r.severity,
  status: r.status,
  fixSize: r.fix_size,
  occurrences: Number(r.occurrences),
  cardId: r.card_id,
  cardRef: r.card_ref ?? null,
  cardStatus: r.card_status ?? null,
  clientOrgId: r.client_org_id,
  firstSeenAt: iso(r.first_seen_at) as string,
  lastSeenAt: iso(r.last_seen_at) as string,
  diagnostics: r.diagnostics,
});

/** The platform bugs, open first then most recent. Diagnostics are the sanitised ones; the extended detail never. */
export async function listBugs(
  ctx: Ctx,
  opts: { limit?: number; openOnly?: boolean } = {},
): Promise<PlatformBugDto[]> {
  const list = await rows(
    ctx.pool,
    `SELECT b.*, c.ref AS card_ref, c.status AS card_status FROM platform_bugs b LEFT JOIN cards c ON c.id = b.card_id
      WHERE ($1::boolean IS NOT TRUE OR b.status = 'open')
      ORDER BY (b.status = 'open') DESC, b.last_seen_at DESC LIMIT $2`,
    [opts.openOnly ?? null, Math.min(opts.limit ?? 100, 500)],
  );
  return list.map(bugDto);
}

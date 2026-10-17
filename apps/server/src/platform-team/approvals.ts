import { PLATFORM_DESK_SUBKIND } from '@aom/shared';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { resolveDeployApprovalIn } from './deploy.ts';
import { resolveGrantIn } from './grants.ts';

/** Routes a resolved platform approval item to its owner (called from the desk's `closeItem`, inside its transaction). */
export async function resolvePlatformApprovalIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  item: Row,
  resolution: 'approved' | 'rejected' | 'acknowledged' | 'dismissed',
  note?: string,
): Promise<void> {
  switch (item.subkind) {
    case PLATFORM_DESK_SUBKIND.deployApproval:
    case PLATFORM_DESK_SUBKIND.downtimeApproval:
      return resolveDeployApprovalIn(ctx, tx, user, item, resolution, note);
    case PLATFORM_DESK_SUBKIND.grantRequest:
      return resolveGrantIn(ctx, tx, user, item, resolution);
  }
}

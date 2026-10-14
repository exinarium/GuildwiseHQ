// The commands the undo paths run, apart from `commands.ts` so that file stays free of these imports.
import type { AuthSession } from '../auth/sessions.ts';
import { dismissDeskItem } from '../commands/desk.ts';
import type { Ctx } from '../context.ts';

export { cancelCard, patchCard, reopenCard } from '../commands/cards.ts';

export const dismissInto = (ctx: Ctx, user: AuthSession['user'], itemId: string): Promise<void> =>
  dismissDeskItem(ctx, user, itemId, 'withdrawn by the owner (undo)');

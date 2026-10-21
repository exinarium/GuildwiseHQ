import type { CeoActionName } from '@aom/shared';
import { ACTIONS as RUN1 } from './actions.ts';
import { ACTIONS2 } from './actions2.ts';
import { ACTIONS3 } from './actions3.ts';
import { ACTIONS4 } from './actions4.ts';
import { ACTIONS5 } from './actions5.ts';
import type { ActionDef } from './types.ts';

/** Every management action the CEO has, by its CLI name. */
export const ACTIONS: Partial<Record<CeoActionName, ActionDef>> = {
  ...RUN1,
  ...ACTIONS2,
  ...ACTIONS3,
  ...ACTIONS4,
  ...ACTIONS5,
};

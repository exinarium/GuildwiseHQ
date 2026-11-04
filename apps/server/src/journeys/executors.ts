import type { JourneyDefinition } from '@aom/shared';
import type { Tx } from '../db/tx.ts';
import type { Row } from '../db/sql.ts';
import type { Ctx } from '../context.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enterGateStep } from './gates.ts';
import { enterWaitStep } from './waits.ts';
import { enterWebhookCallStep } from './webhook-calls.ts';

export type Executor = (ctx: Ctx, tx: Tx, inst: Row, def: JourneyDefinition, run: Row) => Promise<AppendInput[]>;

/**
 * What runs when a journey enters a step that is not a workflow. A later wait kind (GWP-68: runner offline) adds itself
 * to the wait step's executor without other changes here.
 */
export const EXECUTORS: Record<'wait' | 'gate' | 'webhook_call', Executor> = {
  wait: enterWaitStep,
  gate: enterGateStep,
  webhook_call: enterWebhookCallStep,
};

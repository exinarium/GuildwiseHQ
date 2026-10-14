import type { ActionClass, CeoInverse, OwnerReservedKey } from '@aom/shared';
import type { z } from 'zod';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import type { CeoState } from './state.ts';

/** Everything an action adapter needs. `owner` is the principal whose rights the CEO borrows (the org Owner). */
export interface ActionEnv {
  ctx: Ctx;
  orgId: string;
  ceo: CeoState;
  agentId: string;
  agentName: string;
  owner: AuthSession['user'];
  actionId: string;
  now: Date;
  /** The wake batch or chat thread the action belongs to. */
  batchId?: string | undefined;
  chatThreadId?: string | undefined;
}

/** What `prepare` found out about the subject: it feeds the policy gate and the audit row. */
export interface Prepared {
  subjectKind: string;
  subjectId: string;
  subjectLabel: string;
  /** The desk mode the policy gives the item (answers and triage). */
  deskMode?: 'decide' | 'recommend' | 'never' | undefined;
  reservedKey?: OwnerReservedKey | null | undefined;
  /** The decision needs a cited ledger entry or owner rule. */
  needsEvidence?: boolean | undefined;
  /** A hard condition of this action failed: the call is refused with this message (no policy involved). */
  refuse?: string | undefined;
  /** Rate limits specific to the action (text), checked after the generic ones. */
  limitReached?: string | undefined;
  /** What to remember for `execute` (looked-up rows). */
  data?: Record<string, any> | undefined;
  /** The agent the action is about, for per-agent counters. */
  targetAgentId?: string | undefined;
}

export interface Executed {
  message: string;
  result: Record<string, unknown>;
  inverse?: CeoInverse | undefined;
}

export interface ActionDef<P = any> {
  cls: ActionClass;
  /** Human sentence for a recommendation: "Pause Ada (3 failed shifts)". */
  describe(p: P, prepared: Prepared): string;
  schema: z.ZodType<P>;
  /** Reads only (through `env.ctx.pool`): the gateway decides before anything is written. */
  prepare(env: ActionEnv, p: P): Promise<Prepared>;
  /** Writes through the existing command functions, each in its own transaction (they take the append lock themselves). */
  execute(env: ActionEnv, p: P, prepared: Prepared): Promise<Executed>;
}

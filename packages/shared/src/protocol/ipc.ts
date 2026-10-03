import { z } from 'zod';
import { ReviewData, TestEvidence } from '../cards/types.ts';

/**
 * `aom` CLI <-> runner IPC (docs/ARCHITECTURE.md section 13.4). HTTP on 127.0.0.1:<ephemeral>,
 * `Authorization: Bearer <AOM_SHIFT_TOKEN>`; POST `${AOM_IPC_URL}/v1/report` and `/v1/rpc`.
 */

export const IPC_REPORT_PATH = '/v1/report';
export const IPC_RPC_PATH = '/v1/rpc';

/** Sugar verbs all map to `outcome`. `data` is validated against the outcome's `data` kind (see `outcomeDataSchema`). */
export const OutcomeReportSchema = z.object({
  kind: z.literal('outcome'),
  outcomeId: z.string().min(1),
  note: z.string().min(1).max(20000),
  data: z.record(z.string(), z.unknown()).default({}),
});

export const QuestionReportSchema = z.object({
  kind: z.literal('question'),
  text: z.string().min(1).max(20000),
  options: z.array(z.string().min(1)).default([]),
  /** Zero-based index into `options`. */
  recommend: z.number().int().nonnegative().optional(),
  doing: z.string().default(''),
  blocking: z.boolean().default(true),
});

/** Non-terminal thread message. */
export const CommentReportSchema = z.object({
  kind: z.literal('comment'),
  note: z.string().min(1).max(20000),
});

export const ShiftReportSchema = z.discriminatedUnion('kind', [
  OutcomeReportSchema,
  QuestionReportSchema,
  CommentReportSchema,
]);
export type ShiftReport = z.infer<typeof ShiftReportSchema>;

/** Terminal reports end the shift (exactly one per shift; a second gets 409 already reported). */
export const isTerminalReport = (r: ShiftReport): boolean =>
  r.kind === 'outcome' || (r.kind === 'question' && r.blocking);

/** Data attached to an outcome report, by the outcome's `data` kind. `diffStats` is attached by the runner, not the agent. */
export function outcomeDataSchema(kind: string): z.ZodType {
  switch (kind) {
    case 'review':
      return ReviewData;
    case 'testEvidence':
      return TestEvidence;
    default:
      return z.record(z.string(), z.unknown());
  }
}

export const IpcReportRequestSchema = z.object({ report: ShiftReportSchema });
export type IpcReportRequest = z.infer<typeof IpcReportRequestSchema>;

export const IpcReportResponseSchema = z.object({
  accepted: z.boolean(),
  /** Printed by the CLI. On acceptance: "Recorded. Finish now; do not make further changes." */
  message: z.string(),
  error: z.string().optional(),
  /** Set on a rejected report so the CLI can show the guard violation and the agent can retry in the same shift. */
  guardViolations: z.array(z.object({ rule: z.string(), detail: z.string() })).optional(),
});
export type IpcReportResponse = z.infer<typeof IpcReportResponseSchema>;

export const RpcMethodSchema = z.enum([
  'card.get',
  'ledger.search',
  'thread.post',
  'thread.read',
  'devops.request',
]);
export type RpcMethod = z.infer<typeof RpcMethodSchema>;

export const IpcRpcRequestSchema = z.object({
  method: RpcMethodSchema,
  params: z.record(z.string(), z.unknown()).default({}),
});
export type IpcRpcRequest = z.infer<typeof IpcRpcRequestSchema>;

export const IpcRpcResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type IpcRpcResponse = z.infer<typeof IpcRpcResponseSchema>;

export const IpcErrorResponseSchema = z.object({ error: z.string() });

import { z } from 'zod';
import { ShiftEndOutcome, ShiftKind } from '../events/shift.ts';
import { McpCallSchema } from '../mcp/index.ts';
import { IsoTime } from './common.ts';

export const ShiftDtoSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  agentName: z.string().optional(),
  workstationId: z.uuid(),
  cardId: z.uuid().nullable(),
  cardRef: z.string().nullable(),
  kind: ShiftKind,
  stage: z.string().nullable(),
  status: z.enum(['starting', 'running', 'ended']),
  outcome: ShiftEndOutcome.nullable(),
  reportOutcome: z.string().nullable(),
  runtime: z.string(),
  model: z.string(),
  overflow: z.boolean(),
  startedAt: IsoTime,
  endedAt: IsoTime.nullable(),
  durationMs: z.number().int().nullable(),
  tokensInput: z.number().nullable(),
  tokensOutput: z.number().nullable(),
  tokensCacheRead: z.number().nullable(),
  tokensCacheWrite: z.number().nullable(),
  /** Last 50 progress items (operational). */
  progressTail: z.array(
    z.object({ at: IsoTime, kind: z.enum(['text', 'tool', 'status']), text: z.string() }),
  ),
  /** MCP tools the shift's agent called (server and tool names, with counts). */
  mcpCalls: z.array(McpCallSchema).optional(),
});
export type ShiftDto = z.infer<typeof ShiftDtoSchema>;
export const ShiftsQuerySchema = z.object({ agentId: z.uuid().optional(), cardId: z.uuid().optional() });
export const ShiftsResponseSchema = z.object({ shifts: z.array(ShiftDtoSchema) });
export const StopShiftRequestSchema = z.object({ reason: z.string().optional() });

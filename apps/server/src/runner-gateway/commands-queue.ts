import type { RunnerCommandName } from '@aom/shared';
import { exec, one, type Queryable, rows } from '../db/sql.ts';

export const MAX_COMMAND_ATTEMPTS = 10;

/** Durable server -> runner commands for offline delivery (docs/ARCHITECTURE.md section 11.3). */
export async function enqueueRunnerCommand(
  db: Queryable,
  workstationId: string,
  type: RunnerCommandName,
  payload: Record<string, unknown>,
): Promise<string> {
  const r = await one<{ id: string }>(
    db,
    `INSERT INTO runner_commands (workstation_id, type, payload) VALUES ($1,$2,$3) RETURNING id`,
    [workstationId, type, JSON.stringify(payload)],
  );
  return (r as { id: string }).id;
}

export interface PendingCommand {
  id: string;
  type: RunnerCommandName;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function pendingCommands(db: Queryable, workstationId: string): Promise<PendingCommand[]> {
  return (
    await rows(
      db,
      `SELECT id, type, payload, attempts FROM runner_commands
        WHERE workstation_id=$1 AND status IN ('pending','sent') ORDER BY created_at, id`,
      [workstationId],
    )
  ).map((r) => ({ id: r.id, type: r.type, payload: r.payload, attempts: r.attempts }));
}

export const markCommandSent = (db: Queryable, id: string, now: Date) =>
  exec(db, `UPDATE runner_commands SET status='sent', attempts = attempts + 1, sent_at=$2 WHERE id=$1`, [
    id,
    now,
  ]);

export async function completeCommand(
  db: Queryable,
  id: string,
  ok: boolean,
  error: string | undefined,
  now: Date,
): Promise<void> {
  if (ok) {
    await exec(db, `UPDATE runner_commands SET status='done', done_at=$2, last_error=NULL WHERE id=$1`, [
      id,
      now,
    ]);
    return;
  }
  // Failed: back to pending for a retry on the next delivery, until the attempt limit.
  await exec(
    db,
    `UPDATE runner_commands SET last_error=$2,
            status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END WHERE id=$1`,
    [id, error ?? 'failed', MAX_COMMAND_ATTEMPTS],
  );
}

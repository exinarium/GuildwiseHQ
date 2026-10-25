import type { RunnerCommandName } from '@aom/shared';
import { exec, one, type Queryable, rows } from '../db/sql.ts';

export const MAX_COMMAND_ATTEMPTS = 10;

/** Durable server -> runner commands for offline delivery (docs/ARCHITECTURE.md section 11.3). */
export async function enqueueRunnerCommand(
  db: Queryable,
  workstationId: string,
  type: RunnerCommandName,
  payload: Record<string, unknown>,
  /** Commands that carry a sealed envelope expire: after this they are never delivered (a sweep empties them). */
  expiresAt?: Date,
): Promise<string> {
  const r = await one<{ id: string }>(
    db,
    `INSERT INTO runner_commands (workstation_id, type, payload, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
    [workstationId, type, JSON.stringify(payload), expiresAt ?? null],
  );
  return (r as { id: string }).id;
}

export interface PendingCommand {
  id: string;
  type: RunnerCommandName;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Takes the commands to deliver on a live connection: only 'pending' ones, each claimed atomically (marked 'sent' in
 * the same statement) so concurrent deliveries (a report, a desk action, a repo change... all call `deliverPending`)
 * can never send the same command twice. A 'sent' command is not sent again on the same connection: its result is on
 * its way. `requeueSentCommands` hands it out again when the connection is lost.
 */
export async function claimPendingCommands(
  db: Queryable,
  workstationId: string,
  now: Date,
): Promise<PendingCommand[]> {
  return (
    await rows(
      db,
      `UPDATE runner_commands SET status='sent', attempts = attempts + 1, sent_at=$2
        WHERE id IN (SELECT id FROM runner_commands WHERE workstation_id=$1 AND status='pending'
                        AND (expires_at IS NULL OR expires_at > $2)
                      ORDER BY created_at, id FOR UPDATE SKIP LOCKED)
        RETURNING id, type, payload, attempts, created_at`,
      [workstationId, now],
    )
  )
    .sort((a, b) => +a.created_at - +b.created_at || (a.id < b.id ? -1 : 1))
    .map((r) => ({ id: r.id, type: r.type, payload: r.payload, attempts: r.attempts }));
}

/** A (re)connect: commands sent on the lost connection may not have arrived, so they are due again. */
export async function requeueSentCommands(db: Queryable, workstationId: string): Promise<void> {
  await exec(
    db,
    `UPDATE runner_commands SET status='pending'
      WHERE workstation_id=$1 AND status='sent' AND type <> ALL($2::text[])`,
    [workstationId, AT_MOST_ONCE_COMMANDS],
  );
  // A command that must not run twice (it swaps two things) is not handed out again when its answer was lost: the owner sees that
  // it failed, checks the accounts and decides.
  await exec(
    db,
    `UPDATE runner_commands SET status='failed',
            last_error='the connection dropped before the answer arrived: check the accounts, then try again'
      WHERE workstation_id=$1 AND status='sent' AND type = ANY($2::text[])`,
    [workstationId, AT_MOST_ONCE_COMMANDS],
  );
}

/** Commands that are delivered at most once: "Make main" swaps two accounts, so a second run would undo the first. */
export const AT_MOST_ONCE_COMMANDS: string[] = ['provider.account.promote'];

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
    `UPDATE runner_commands SET last_error=$2, answering_at=NULL,
            status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END WHERE id=$1`,
    [id, error ?? 'failed', MAX_COMMAND_ATTEMPTS],
  );
}

/** A command the runner answered with a refusal that retrying cannot change: it ends as failed at once (no retry). */
export async function failCommandFinal(db: Queryable, id: string, error: string, now: Date): Promise<void> {
  await exec(db, `UPDATE runner_commands SET status='failed', last_error=$2, done_at=$3 WHERE id=$1`, [
    id,
    error.slice(0, 300),
    now,
  ]);
}

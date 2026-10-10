import type { Pool } from '../db/pool.ts';
import type { Mailer, MailMessage } from './mailer.ts';

export const SIMULATION_PREFIX = '[Simulation] ';

/**
 * Mails to people of a simulation organization are sent as normal, with "[Simulation] " in front of the subject so
 * nobody mistakes a test for the real thing. A recipient counts as simulation when all their active organizations are
 * simulation organizations, or when a pending invitation of theirs is for one. Someone who also belongs to a real
 * organization gets plain subjects (their mail cannot be told apart by address). `msg.simulation` forces it.
 */
export function withSimulationPrefix(inner: Mailer, pool: Pool): Mailer {
  return {
    async send(msg: MailMessage) {
      let sim = msg.simulation === true;
      if (!sim) {
        try {
          const r = await pool.query<{ sim: boolean }>(
            `SELECT (
               EXISTS (SELECT 1 FROM org_members m JOIN users u ON u.id = m.user_id
                         JOIN organizations o ON o.id = m.org_id
                        WHERE lower(u.email) = lower($1) AND m.status = 'active' AND o.simulation)
               AND NOT EXISTS (SELECT 1 FROM org_members m JOIN users u ON u.id = m.user_id
                         JOIN organizations o ON o.id = m.org_id
                        WHERE lower(u.email) = lower($1) AND m.status = 'active' AND NOT o.simulation)
             ) OR EXISTS (SELECT 1 FROM invitations i LEFT JOIN organizations o ON o.id = i.org_id
                           WHERE lower(i.email) = lower($1) AND i.status = 'pending'
                             AND (i.org_terms->>'simulation' = 'true' OR COALESCE(o.simulation, false))) AS sim`,
            [msg.to],
          );
          sim = r.rows[0]?.sim === true;
        } catch {
          sim = false; // never block a mail on the lookup
        }
      }
      const { simulation: _drop, ...rest } = msg;
      await inner.send(
        sim && !rest.subject.startsWith(SIMULATION_PREFIX)
          ? { ...rest, subject: SIMULATION_PREFIX + rest.subject }
          : rest,
      );
    },
    close: () => inner.close(),
  };
}

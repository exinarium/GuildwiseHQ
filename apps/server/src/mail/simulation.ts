import type { Pool } from '../db/pool.ts';
import type { Mailer, MailMessage } from './mailer.ts';

export const SIMULATION_PREFIX = '[Simulation] ';

/**
 * Mails about a simulation organization get "[Simulation] " in front of the subject so nobody mistakes a test for the
 * real thing. The organization the mail is about decides (`msg.orgId`, or `msg.simulation` for an organization that
 * does not exist yet), never the recipient: a person in both a real and a simulation organization gets the prefix only
 * on mails about the simulation one. Mails that name no organization are never prefixed.
 */
export function withSimulationPrefix(inner: Mailer, pool: Pool): Mailer {
  return {
    async send(msg: MailMessage) {
      let sim = msg.simulation === true;
      if (!sim && msg.orgId) {
        try {
          const r = await pool.query<{ simulation: boolean }>(
            'SELECT simulation FROM organizations WHERE id=$1',
            [msg.orgId],
          );
          sim = r.rows[0]?.simulation === true;
        } catch {
          sim = false; // never block a mail on the lookup
        }
      }
      const { simulation: _s, orgId: _o, ...rest } = msg;
      await inner.send(
        sim && !rest.subject.startsWith(SIMULATION_PREFIX)
          ? { ...rest, subject: SIMULATION_PREFIX + rest.subject }
          : rest,
      );
    },
    close: () => inner.close(),
  };
}

import type { HeldItem } from '@aom/shared';
import type { RunnerConn, RunnerRegistry } from './registry.ts';

/**
 * The items a runner holds until a local approval (R18-S), as it last reported them with `approvals.held`. Memory only and
 * tied to the live connection: the runner sends the full list on every change, and a new connection starts empty until
 * its first report. Nothing here is an approval; the server only shows the list and relays passkey assertions (R22).
 */
interface HeldReport {
  items: HeldItem[];
  reportedAt: Date;
}

const reports = new WeakMap<RunnerConn, HeldReport>();

/** `approvals.held`: replaces the connection's list. */
export function recordHeldItems(conn: RunnerConn, items: HeldItem[], now: Date): void {
  reports.set(conn, { items, reportedAt: now });
}

/** The live connection's last report (empty while offline or before the first report). */
export function heldItemsOf(
  runners: RunnerRegistry,
  workstationId: string,
): { online: boolean; reportedAt: Date | null; items: HeldItem[] } {
  const conn = runners.get(workstationId);
  const online = runners.isOnline(workstationId);
  const r = conn && online ? reports.get(conn) : undefined;
  return { online, reportedAt: r?.reportedAt ?? null, items: r?.items ?? [] };
}

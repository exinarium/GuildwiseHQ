import { makeEnvelope, type RepoReport, type ServerToRunner } from '@aom/shared';
import type { WebSocket } from 'ws';

export interface RunnerConn {
  socket: WebSocket;
  workstationId: string;
  userId: string;
  connectedAt: Date;
  helloAt: Date | null;
  /** True once the post-reconnect reconciliation ran (docs/ARCHITECTURE.md section 11.2). */
  reconciled: boolean;
  helloShiftIds: string[];
  /** Chats (CEO owner and order turns) the runner reported as running in `hello`. */
  helloChatIds?: string[];
  lastRepos: RepoReport[];
  /** shiftId -> consecutive heartbeats that did not report it. */
  missing: Map<string, number>;
  stopSentAt: Map<string, number>;
  /**
   * Shifts this workstation takes at once (backlog #76): the owner's setting, else the runner's `maxConcurrentShifts`,
   * capped by the platform. `UNLIMITED_SHIFTS` is no limit at all.
   */
  maxShifts: number;
  /** The runner's own configured `maxConcurrentShifts` from `hello` (the fallback when the owner set none). */
  reportedMaxShifts?: number;
  /**
   * The runner can prepare toolchains, check rights and keep a sudo password (it announced a `sudoKey` in `hello`).
   * An older runner answers those commands with an error, and holding its cards back for that would be wrong.
   */
  setupCapable?: boolean;
}

/** Live runner sockets by workstation. A second connection supersedes the first. */
export class RunnerRegistry {
  private conns = new Map<string, RunnerConn>();

  get(workstationId: string): RunnerConn | undefined {
    return this.conns.get(workstationId);
  }

  set(conn: RunnerConn): RunnerConn | undefined {
    const old = this.conns.get(conn.workstationId);
    this.conns.set(conn.workstationId, conn);
    return old;
  }

  /** Removes `conn` only if it is still the registered one. */
  remove(conn: RunnerConn): boolean {
    if (this.conns.get(conn.workstationId) !== conn) return false;
    this.conns.delete(conn.workstationId);
    return true;
  }

  all(): RunnerConn[] {
    return [...this.conns.values()];
  }

  isOnline(workstationId: string): boolean {
    const c = this.conns.get(workstationId);
    return !!c && c.socket.readyState === 1;
  }

  /** Sends one envelope; false if there is no open socket. */
  send<T extends ServerToRunner['type']>(
    workstationId: string,
    type: T,
    payload: Omit<Extract<ServerToRunner, { type: T }>, 'v' | 'id' | 'type' | 'ts'>,
    now: Date = new Date(),
  ): boolean {
    const c = this.conns.get(workstationId);
    if (!c || c.socket.readyState !== 1) return false;
    c.socket.send(JSON.stringify(makeEnvelope(type, payload as Record<string, unknown>, now)));
    return true;
  }

  close(workstationId: string, code: number, reason: string): void {
    const c = this.conns.get(workstationId);
    if (!c) return;
    this.conns.delete(workstationId);
    try {
      c.socket.close(code, reason);
    } catch {
      // already closed
    }
  }
}

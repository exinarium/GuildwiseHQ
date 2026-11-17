import { DEPLOY_COMMIT_PROBE_CAPABILITY, type RunnerToServerOf, uuidv7 } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import type { RunnerConn } from '../runner-gateway/registry.ts';

/**
 * Reading a commit of a deploy repository. The server holds no clones and no forge tokens, so the commit a deploy would
 * build is read on the workstation that deploys: one live frame `repo.commit.probe`, one answer, in memory only. Nothing
 * is queued and nothing is stored, so a preview (which may not enqueue anything) can use it. Modelled on the webhook relay's
 * `forward` / `onResponse`.
 */

export const COMMIT_PROBE_TIMEOUT_MS = 25_000;

export type ProbeFailure = 'no_clone' | 'no_branch' | 'fetch_failed' | 'not_found' | 'ambiguous' | 'timeout';

export type ProbeAnswer =
  | {
      kind: 'commit';
      sha: string;
      shortSha: string;
      subject: string | null;
      author: string | null;
      committedAt: string | null;
    }
  | { kind: 'failed'; error: ProbeFailure; message: string }
  | { kind: 'offline' }
  | { kind: 'outdated' }
  | { kind: 'timeout' };

export interface ProbeRequest {
  remoteUrlNormalized: string;
  branch: string | null;
  /** Absent: the tip of origin/<branch>. */
  sha?: string | undefined;
}

interface Pending {
  conn: RunnerConn;
  timer: NodeJS.Timeout;
  waiters: Array<(a: ProbeAnswer) => void>;
  key: string;
}

export class CommitProbeHub {
  private pending = new Map<string, Pending>();
  private byKey = new Map<string, string>();

  constructor(private readonly ctx: Ctx) {}

  /** Asks the workstation. Equal requests in flight share one frame. Never throws. */
  async probe(
    workstationId: string,
    req: ProbeRequest,
    timeoutMs: number = COMMIT_PROBE_TIMEOUT_MS,
  ): Promise<ProbeAnswer> {
    const { ctx } = this;
    const caps = await one<{ capabilities: string[] }>(
      ctx.pool,
      'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1',
      [workstationId],
    );
    if (caps && !caps.capabilities.includes(DEPLOY_COMMIT_PROBE_CAPABILITY)) return { kind: 'outdated' };
    const conn = ctx.services.runners.get(workstationId);
    if (!conn) return { kind: 'offline' };
    const key = [workstationId, req.remoteUrlNormalized, req.branch ?? '', req.sha ?? ''].join('\u0000');
    const sharedId = this.byKey.get(key);
    const shared = sharedId ? this.pending.get(sharedId) : undefined;
    if (shared)
      return new Promise<ProbeAnswer>((resolve) => {
        shared.waiters.push(resolve);
      });
    return new Promise<ProbeAnswer>((resolve) => {
      const requestId = uuidv7();
      const settle = (a: ProbeAnswer) => {
        const p = this.pending.get(requestId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(requestId);
        if (this.byKey.get(p.key) === requestId) this.byKey.delete(p.key);
        for (const w of p.waiters) w(a);
      };
      const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);
      this.pending.set(requestId, { conn, timer, waiters: [resolve], key });
      this.byKey.set(key, requestId);
      const sent = ctx.services.runners.send(
        workstationId,
        'repo.commit.probe',
        {
          requestId,
          remoteUrlNormalized: req.remoteUrlNormalized,
          branch: req.branch,
          ...(req.sha ? { sha: req.sha } : {}),
          deadlineMs: Math.max(1, timeoutMs - 1000),
        },
        ctx.clock.now(),
      );
      if (!sent) settle({ kind: 'offline' });
    });
  }

  /** The runner's answer. Late, unknown or from another runner than the one asked: ignored. */
  onResult(conn: RunnerConn, msg: RunnerToServerOf<'repo.commit.probe.result'>): void {
    const p = this.pending.get(msg.requestId);
    if (!p || p.conn !== conn) {
      this.ctx.log.debug({ requestId: msg.requestId }, 'commit probe answer ignored');
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(msg.requestId);
    if (this.byKey.get(p.key) === msg.requestId) this.byKey.delete(p.key);
    const answer: ProbeAnswer =
      msg.ok && msg.sha
        ? {
            kind: 'commit',
            sha: msg.sha,
            shortSha: msg.shortSha ?? msg.sha.slice(0, 7),
            subject: msg.subject ?? null,
            author: msg.author ?? null,
            committedAt: msg.committedAt ?? null,
          }
        : {
            kind: 'failed',
            error: msg.error ?? 'fetch_failed',
            message: msg.message ?? 'the workstation could not read the commit',
          };
    for (const w of p.waiters) w(answer);
  }

  /** A runner went away: what waited on it is offline now, not after the timeout. */
  onDisconnect(workstationId: string): void {
    for (const [id, p] of [...this.pending]) {
      if (p.conn.workstationId !== workstationId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      if (this.byKey.get(p.key) === id) this.byKey.delete(p.key);
      for (const w of p.waiters) w({ kind: 'offline' });
    }
  }
}

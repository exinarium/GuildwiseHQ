import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ApprovedDraft,
  checkOutboundLeaks,
  leakMessage,
  type OutboundPostPayload,
  type OutboundPostResult,
  type PostResult,
} from '@aom/shared';
import { PostError } from './github.ts';
import type { ExternalAdapters } from './index.ts';

interface PostRecord {
  state: 'attempting' | 'posted';
  externalRef?: string;
  at: string;
}

/**
 * Posts approved drafts on this workstation (the `outbound.post` command; docs/ARCHITECTURE.md section 16.5). The
 * server sends it only to the card owner's own workstation, so the credentials used are the owner's.
 *
 * - Scrub: the text is checked against the organization's agent names and internal terms once more; a draft that
 *   leaks is refused here even if it was approved (defence in depth).
 * - Idempotent: a record per draft (`outbound/<draftId>.json`). A draft already posted answers with its recorded
 *   result and sends nothing. A record still 'attempting' (a crash or timeout after sending) asks the system whether
 *   the exact text is already there before posting again. A refusal by the system (`PostError`) leaves no record.
 * - Never throws: the answer is `{ok, externalRef | error}`; failures go back to the manager's desk.
 */
export class OutboundExecutor {
  private readonly inFlight = new Map<string, Promise<OutboundPostResult>>();

  constructor(private readonly deps: { dir: string; adapters: ExternalAdapters; now?: () => Date }) {}

  private file(draftId: string): string {
    return join(this.deps.dir, `${draftId}.json`);
  }

  private read(draftId: string): PostRecord | null {
    try {
      return JSON.parse(readFileSync(this.file(draftId), 'utf8')) as PostRecord;
    } catch {
      return null;
    }
  }

  private write(draftId: string, rec: Omit<PostRecord, 'at'>): void {
    mkdirSync(this.deps.dir, { recursive: true });
    writeFileSync(
      this.file(draftId),
      `${JSON.stringify({ ...rec, at: (this.deps.now?.() ?? new Date()).toISOString() })}\n`,
    );
  }

  run(payload: OutboundPostPayload): Promise<OutboundPostResult> {
    const running = this.inFlight.get(payload.draftId);
    if (running) return running;
    const p = this.post(payload).finally(() => this.inFlight.delete(payload.draftId));
    this.inFlight.set(payload.draftId, p);
    return p;
  }

  private async post(payload: OutboundPostPayload): Promise<OutboundPostResult> {
    const done = this.read(payload.draftId);
    if (done?.state === 'posted')
      return { ok: true, duplicate: true, ...(done.externalRef ? { externalRef: done.externalRef } : {}) };
    const leak = checkOutboundLeaks(payload.body, payload.agentNames);
    if (!leak.ok) return { ok: false, error: `refused before posting: ${leakMessage(leak.matches)}` };
    const adapter = this.deps.adapters.get(payload.ref.system);
    if (!adapter) return { ok: false, error: `this workstation has no adapter for ${payload.ref.system}` };
    const draft: ApprovedDraft = {
      draftId: payload.draftId,
      ref: payload.ref,
      kind: payload.kind,
      body: payload.body,
    };
    try {
      if (done?.state === 'attempting' && adapter.findPosted) {
        const found: PostResult | null = await adapter.findPosted(draft).catch(() => null);
        if (found) {
          this.write(payload.draftId, {
            state: 'posted',
            ...(found.externalRef ? { externalRef: found.externalRef } : {}),
          });
          return {
            ok: true,
            duplicate: true,
            ...(found.externalRef ? { externalRef: found.externalRef } : {}),
          };
        }
      }
      this.write(payload.draftId, { state: 'attempting' });
      const r = await adapter.postApproved(draft);
      this.write(payload.draftId, {
        state: 'posted',
        ...(r.externalRef ? { externalRef: r.externalRef } : {}),
      });
      return { ok: true, ...(r.externalRef ? { externalRef: r.externalRef } : {}) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The system said no: nothing was posted, so there is nothing to look for on a retry.
      if (err instanceof PostError) rmSync(this.file(payload.draftId), { force: true });
      return { ok: false, error: message };
    }
  }
}

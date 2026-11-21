import type { ApprovalPasskeyPayload, HeldItem, PasskeyOfferPayload } from '@aom/shared';
import type { Logger } from '../log.ts';
import { type GateDecision, SETUP_PENDING_NOTE, setupPending } from './gate.ts';
import { capDetail, HELD_TTL_MS, type HeldRecord, type HeldStore, newHeldId } from './held.ts';
import { checkPasskeyAssertion, newPasskeyChallenge } from './passkey.ts';
import { passkeyMayApprove } from './passkey-kinds.ts';
import type { PasskeyStore } from './passkey-store.ts';
import type { Policy } from './schema.ts';

/**
 * The runner side of local approvals (R18-S, R18-D, R22): holds what the gate says to hold, tells the server what is held
 * (`approvals.held`, the full list each time), and acts on the decisions the CLI writes (`guildwise-runner approve|deny`)
 * or on a passkey assertion the server relays for one of the two routine kinds. The server is told what is held so the
 * web can show "confirm on the workstation"; it can never approve.
 */

export interface ApprovalsDeps {
  /** The local policy (re-read on each use). */
  policy: { get(): Policy };
  held: HeldStore;
  passkeys: PasskeyStore;
  /** This pairing's data directory: the key that ties a held item to the runner that holds it. */
  pairing: string;
  serverOrigin: string;
  send: (type: 'approvals.held', payload: { items: HeldItem[] }) => void;
  /** Runs an approved item (replays the command or shift start it holds). */
  execute: (r: HeldRecord) => Promise<void>;
  /** Tells the server an item will not run (denied, expired, refused). */
  refuse: (r: HeldRecord, reason: string) => void;
  log: Logger;
  now?: () => number;
  pollMs?: number;
}

export interface HoldInput {
  decision: Extract<GateDecision, { action: 'hold' }>;
  commandId?: string;
  replay: HeldRecord['replay'];
}

export class Approvals {
  private timer?: NodeJS.Timeout;
  private lastSent = '';
  private running = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: ApprovalsDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    const t = setInterval(() => void this.tick(), this.deps.pollMs ?? 2000);
    t.unref?.();
    this.timer = t;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): HeldRecord[] {
    return this.deps.held.list(this.deps.pairing);
  }

  /** Holds an item (a repeat of a command already held is not added twice). Returns the record. */
  hold(input: HoldInput): HeldRecord {
    const d = input.decision;
    if (input.commandId) {
      const dup = this.list().find((r) => r.commandId === input.commandId);
      if (dup) return dup;
    }
    const at = this.now();
    const r: HeldRecord = {
      id: newHeldId(),
      kind: d.kind,
      pairing: this.deps.pairing,
      ...(input.commandId ? { commandId: input.commandId } : {}),
      summary: d.summary.slice(0, 500),
      detail: capDetail(d.detail),
      commandHash: d.commandHash,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + HELD_TTL_MS).toISOString(),
      replay: input.replay,
      ...(d.pin ? { pin: d.pin } : {}),
      ...(d.note ? { note: d.note } : {}),
      state: 'held',
    };
    this.deps.held.put(r);
    this.deps.log.info(
      `held ${r.kind} ${r.id} for a local approval: ${r.summary} (guildwise-runner approve ${r.id})`,
    );
    this.publish(true);
    return r;
  }

  /** Adds text to a held item's detail (what `approve` prints), while it is still held. */
  annotate(id: string, extra: string): void {
    const r = this.deps.held.get(id);
    if (!r || r.state !== 'held') return;
    this.deps.held.put({ ...r, detail: capDetail(`${r.detail}\n\n${extra}`) });
  }

  /** Drops held items the server withdrew (a stopped shift, a cancelled command). */
  withdraw(match: (r: HeldRecord) => boolean, why: string): void {
    for (const r of this.list())
      if (r.state === 'held' && match(r)) {
        this.deps.held.remove(r.id);
        this.deps.log.info(`held ${r.kind} ${r.id} withdrawn: ${why}`);
      }
    this.publish();
  }

  /** The server relays a passkey assertion for a held item (R22). Anything that does not check out stays held. */
  async onPasskeyAssertion(a: ApprovalPasskeyPayload): Promise<{ ok: boolean; reason?: string }> {
    const r = this.deps.held.get(a.itemId);
    if (!r || r.pairing !== this.deps.pairing || r.state !== 'held')
      return { ok: false, reason: 'no such held item' };
    // like `guildwise-runner approve`: nothing is approved before a local `setup` (round-1 should-fix 3)
    if (setupPending(this.deps.policy.get())) {
      this.deps.log.warn(`passkey approval of ${r.kind} ${r.id} refused: ${SETUP_PENDING_NOTE}`);
      return { ok: false, reason: SETUP_PENDING_NOTE };
    }
    const check = checkPasskeyAssertion({
      assertion: a,
      item: r,
      trusted: this.deps.policy.get().passkeys,
      signCounts: this.deps.passkeys.signCounts(),
      now: this.now(),
    });
    if (!check.ok) {
      this.deps.log.warn(`passkey approval of ${r.kind} ${r.id} refused: ${check.reason}`);
      return { ok: false, reason: check.reason };
    }
    this.deps.passkeys.noteSignCount(check.credentialId, check.signCount);
    this.deps.held.put({
      ...r,
      ...(r.passkey ? { passkey: { ...r.passkey, usedNonce: true } } : {}),
      state: 'approved',
      decidedAt: new Date(this.now()).toISOString(),
      decidedBy: 'passkey',
    });
    this.deps.log.info(`held ${r.kind} ${r.id} approved with passkey ${check.credentialId.slice(0, 12)}...`);
    await this.tick();
    return { ok: true };
  }

  onPasskeyOffer(o: PasskeyOfferPayload): void {
    this.deps.passkeys.addOffer(o, this.deps.pairing, this.deps.serverOrigin, new Date(this.now()));
    this.deps.log.info(
      `passkey "${o.name}" offered by the server: it is NOT trusted until \`guildwise-runner passkey trust\` on this machine`,
    );
  }

  onPasskeyWithdraw(credentialId: string): void {
    this.deps.passkeys.removeOffer(credentialId);
  }

  /** One pass: run what was approved, refuse what was denied or expired, publish the list when it changed. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const r of this.list()) {
      if (this.running.has(r.id)) continue;
      if (r.state === 'denied') {
        this.deps.held.remove(r.id);
        this.deps.refuse(r, 'denied on the workstation');
        this.deps.log.info(`held ${r.kind} ${r.id} denied on the workstation`);
      } else if (r.state === 'held' && Date.parse(r.expiresAt) <= now) {
        this.deps.held.remove(r.id);
        this.deps.refuse(r, 'not approved on the workstation within 24 hours');
        this.deps.log.info(`held ${r.kind} ${r.id} expired`);
      } else if (r.state === 'approved') {
        this.running.add(r.id);
        this.deps.held.remove(r.id);
        this.deps.log.info(
          `running ${r.kind} ${r.id}, approved ${r.decidedBy === 'passkey' ? 'with a passkey' : 'on the workstation'}`,
        );
        try {
          await this.deps.execute(r);
        } catch (err) {
          this.deps.log.error(`approved ${r.kind} ${r.id} failed: ${String(err)}`);
        } finally {
          this.running.delete(r.id);
        }
      }
    }
    this.publish();
  }

  /** Sends `approvals.held` when the list (or a passkey challenge) changed; `force` sends it anyway (after welcome). */
  publish(force = false): void {
    const policy = this.deps.policy.get();
    const credentialIds = policy.passkeys.map((p) => p.credentialId);
    const now = this.now();
    const items: HeldItem[] = [];
    for (const r of this.list()) {
      if (r.state !== 'held') continue;
      let rec = r;
      if (passkeyMayApprove(r.kind) && credentialIds.length > 0) {
        // a fresh challenge (new nonce) when there is none or it has less than a minute left
        if (!r.passkey || r.passkey.usedNonce || Date.parse(r.passkey.expiresAt) - now < 60_000) {
          rec = { ...r, passkey: { ...newPasskeyChallenge(r.commandHash, now), usedNonce: false } };
          this.deps.held.put(rec);
        }
      }
      items.push({
        id: rec.id,
        kind: rec.kind,
        ...(rec.commandId ? { commandId: rec.commandId } : {}),
        summary: rec.note ? `${rec.summary} (${rec.note})`.slice(0, 500) : rec.summary,
        commandHash: rec.commandHash,
        createdAt: rec.createdAt,
        expiresAt: rec.expiresAt,
        ...(rec.passkey && passkeyMayApprove(rec.kind) && credentialIds.length > 0
          ? {
              passkey: {
                challenge: rec.passkey.challenge,
                nonce: rec.passkey.nonce,
                expiresAt: rec.passkey.expiresAt,
                credentialIds,
              },
            }
          : {}),
      });
    }
    const text = JSON.stringify(items);
    if (!force && text === this.lastSent) return;
    this.lastSent = text;
    try {
      this.deps.send('approvals.held', { items: items.slice(0, 200) });
    } catch (err) {
      this.deps.log.warn(`could not report held items: ${String(err)}`);
    }
  }
}

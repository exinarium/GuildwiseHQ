import {
  type ApprovalPasskeyPayload,
  type HeldItem,
  type LocalStep,
  type LocalStepKind,
  localCommandOk,
  type PasskeyOfferPayload,
} from '@aom/shared';
import type { Logger } from '../log.ts';
import {
  type GateDecision,
  gateCommand,
  heldTarget,
  plainDetail,
  plainText,
  SETUP_PENDING_NOTE,
  setupPending,
} from './gate.ts';
import { capDetail, HELD_TTL_MS, type HeldRecord, type HeldStore, newHeldId } from './held.ts';
import { localCommand } from './local-command.ts';
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
  send: (type: 'approvals.held', payload: { items: HeldItem[]; steps?: LocalStep[] }) => void;
  /** Runs an approved item (replays the command or shift start it holds). */
  execute: (r: HeldRecord) => Promise<void>;
  /** Tells the server an item will not run (denied, expired, refused). */
  refuse: (r: HeldRecord, reason: string) => void;
  log: Logger;
  now?: () => number;
  pollMs?: number;
  /**
   * easy-runner-setup: the CLI part of this runner's copy-paste commands (`localCli()`); absent: commands are not sent
   * (an older layout). The approvals page port, when it runs, is named in the log line.
   */
  cli?: string;
  windowPort?: () => number | undefined;
  /** Called on each poll (the runner sends its local install choice when it changed). */
  onTick?: () => void;
}

/** A local step that is not a held item (a DevOps grant, install scripts, setup, ...), kept in memory with a TTL. */
export interface LocalStepRecord {
  key: string;
  kind: LocalStepKind;
  summary: string;
  command: string;
  args: string[];
  shiftId?: string;
  at: number;
}

/** A step is satisfied (and dropped) once the policy holds what its command would grant. */
function satisfied(s: LocalStepRecord, p: Policy, pendingSetup: boolean): boolean {
  switch (s.kind) {
    case 'devops.grant':
      return !!s.args[0] && p.devops.agents[s.args[0]] === s.args[2];
    case 'setup':
      return !pendingSetup;
    case 'passkey.trust':
      return p.passkeys.some((k) => k.credentialId.startsWith(s.args[0] ?? '\u0000'));
    case 'formatter.pin':
      return p.formatterPins.includes(s.args[0] ?? '');
    default:
      return false;
  }
}

/** Steps are dropped when satisfied, or after 24 hours. */
export const LOCAL_STEP_TTL_MS = 24 * 3600_000;
const MAX_STEPS = 100;

export interface HoldInput {
  decision: Extract<GateDecision, { action: 'hold' }>;
  commandId?: string;
  replay: HeldRecord['replay'];
  /**
   * UAT 1.10.0 finding 3: one held item per DevOps request (`devops:<requestId>`). A new shift of a request already held
   * updates that item's replay (same id, no new log line or Desk item) instead of holding a second one.
   */
  requestKey?: string;
}

/** The DevOps request a held shift start belongs to. */
const requestKeyOf = (r: HeldRecord): string | undefined => {
  if (r.replay?.type !== 'shift.start') return undefined;
  const id = (r.replay.body as { devops?: { requestId?: unknown } } | null)?.devops?.requestId;
  return typeof id === 'string' ? `devops:${id}` : undefined;
};

export class Approvals {
  private timer?: NodeJS.Timeout;
  private lastSent = '';
  private running = new Set<string>();
  private readonly now: () => number;
  private steps = new Map<string, LocalStepRecord>();

  constructor(private readonly deps: ApprovalsDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.refreshSummaries();
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

  /**
   * UAT 1.10.0 finding 1: a held item keeps the one-line summary it was written with, and held items survive a reinstall
   * (`<policy dir>/held/`). An item held by an older runner ("vault.configure for " with an empty target) was shown that
   * way on the log, the approvals page and the Desk forever, and a repeat of its command returned it unchanged. At start
   * every command item is summarised again by this runner's gate, so every item names its target.
   */
  refreshSummaries(): void {
    let changed = false;
    for (const r of this.list()) {
      if (r.state !== 'held' || r.replay?.type !== 'command') continue;
      const raw = this.summaryOf(r);
      const summary = raw === null ? null : plainText(raw);
      if (summary && summary !== r.summary) {
        this.deps.held.put({ ...r, summary: summary.slice(0, 500) });
        this.deps.log.info(`held ${r.kind} ${r.id} now reads: ${summary}`);
        changed = true;
      }
    }
    if (changed) this.publish(true);
  }

  /** The summary this runner's gate gives a held command item (null when it cannot say). */
  private summaryOf(r: HeldRecord): string | null {
    const b = r.replay.body as { command?: unknown; payload?: unknown } | null;
    if (!b || typeof b.command !== 'string' || !b.payload || typeof b.payload !== 'object') return null;
    const payload = b.payload as Record<string, unknown>;
    try {
      const d = gateCommand(this.deps.policy.get(), b.command, payload);
      if (d.action === 'hold') return d.summary;
    } catch {
      // a payload this runner cannot read keeps its summary unless that one names nothing
    }
    return /\bfor\s*$|\bfor {2}/.test(r.summary)
      ? `${b.command} for ${heldTarget(b.command, payload)}`
      : null;
  }

  /** Holds an item (a repeat of a command already held is not added twice). Returns the record. */
  hold(input: HoldInput): HeldRecord {
    const d = input.decision;
    if (input.commandId) {
      const dup = this.list().find((r) => r.commandId === input.commandId);
      if (dup) {
        if (dup.state !== 'held' || dup.summary === plainText(d.summary).slice(0, 500)) return dup;
        // the same command again: the item reads as this runner says it (never the text of an older runner)
        const fresh = {
          ...dup,
          summary: plainText(d.summary).slice(0, 500),
          detail: capDetail(plainDetail(d.detail)),
        };
        this.deps.held.put(fresh);
        this.deps.log.info(this.holdLine(fresh));
        this.publish(true);
        return fresh;
      }
    }
    if (input.requestKey) {
      const same = this.list().find((r) => r.state === 'held' && requestKeyOf(r) === input.requestKey);
      if (same) {
        // REVIEW S2: the item reads as the shift it will now run (its request text and access), not as the older one
        const next = {
          ...same,
          replay: input.replay,
          commandHash: d.commandHash,
          summary: plainText(d.summary).slice(0, 500),
          detail: capDetail(plainDetail(d.detail)),
        };
        this.deps.held.put(next);
        this.deps.log.info(
          `held ${same.kind} ${same.id} still waits for your yes (the same request, a new shift)`,
        );
        this.publish(true);
        return next;
      }
    }
    // vault.configure is the full set (replace semantics): a newer one makes every older held one obsolete
    if (d.kind === 'vault.configure')
      for (const r of this.list())
        if (r.state === 'held' && r.kind === 'vault.configure') {
          this.deps.held.remove(r.id);
          this.deps.log.info(`held ${r.kind} ${r.id} replaced by a newer vault set-up from the server`);
        }
    const at = this.now();
    const r: HeldRecord = {
      id: newHeldId(),
      kind: d.kind,
      pairing: this.deps.pairing,
      ...(input.commandId ? { commandId: input.commandId } : {}),
      summary: plainText(d.summary).slice(0, 500),
      detail: capDetail(plainDetail(d.detail)),
      commandHash: d.commandHash,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + HELD_TTL_MS).toISOString(),
      replay: input.replay,
      ...(d.pin ? { pin: d.pin } : {}),
      ...(d.note ? { note: d.note } : {}),
      state: 'held',
    };
    this.deps.held.put(r);
    this.deps.log.info(this.holdLine(r));
    this.publish(true);
    return r;
  }

  /** The copy-paste command that approves a held item (null without a CLI part or outside the grammar). */
  commandFor(id: string): string | null {
    return this.deps.cli ? localCommand(this.deps.cli, 'approve', [id]) : null;
  }

  /** `held <kind> <id>: <summary>. To approve, run on this computer: <command> (or open Approvals ...)`. */
  holdLine(r: Pick<HeldRecord, 'kind' | 'id' | 'summary'>): string {
    const cmd = this.commandFor(r.id) ?? `guildwise-runner approve ${r.id}`;
    const port = this.deps.windowPort?.();
    return `held ${r.kind} ${r.id}: ${r.summary}. To approve, run on this computer: ${cmd}${port ? ` (or open Approvals on this computer: http://127.0.0.1:${port}/)` : ''}`;
  }

  /**
   * A local step the person must take on this machine (a DevOps grant, install scripts, setup, a passkey, ...). Kept in
   * memory, replaced by key, sent with `approvals.held`, and logged once with its command. Returns the command or null.
   */
  needStep(step: {
    key: string;
    kind: LocalStepKind;
    summary: string;
    verb: string;
    args?: string[];
    shiftId?: string;
  }): string | null {
    if (!this.deps.cli) return null;
    const command = localCommand(this.deps.cli, step.verb, step.args ?? []);
    if (!command) return null;
    const prev = this.steps.get(step.key);
    this.steps.set(step.key, {
      key: step.key,
      kind: step.kind,
      summary: step.summary.slice(0, 300),
      command,
      args: [...(step.args ?? [])],
      ...(step.shiftId ? { shiftId: step.shiftId } : {}),
      at: this.now(),
    });
    while (this.steps.size > MAX_STEPS) this.steps.delete(this.steps.keys().next().value as string);
    if (!prev || prev.command !== command)
      this.deps.log.info(`waiting on this computer: ${step.summary}. Run on this computer: ${command}`);
    this.publish();
    return command;
  }

  /** Drops a step once it is satisfied (the grant was given, setup ran, ...). */
  clearStep(match: string | ((s: LocalStepRecord) => boolean)): void {
    let changed = false;
    for (const s of [...this.steps.values()])
      if (typeof match === 'string' ? s.key === match : match(s))
        changed = this.steps.delete(s.key) || changed;
    if (changed) this.publish();
  }

  /** The open steps (expired ones are dropped). */
  listSteps(): LocalStepRecord[] {
    const now = this.now();
    const policy = this.deps.policy.get();
    const pending = setupPending(policy);
    for (const s of [...this.steps.values()])
      if (now - s.at > LOCAL_STEP_TTL_MS || satisfied(s, policy, pending)) this.steps.delete(s.key);
    return [...this.steps.values()];
  }

  /** Adds text to a held item's detail (what `approve` prints), while it is still held. */
  annotate(id: string, extra: string): void {
    const r = this.deps.held.get(id);
    if (!r || r.state !== 'held') return;
    this.deps.held.put({ ...r, detail: capDetail(plainDetail(`${r.detail}\n\n${extra}`)) });
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
    try {
      this.deps.onTick?.();
    } catch {
      // advisory
    }
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
      const command = this.commandFor(rec.id);
      const shiftId =
        rec.replay?.type === 'shift.start' ? (rec.replay.body as { shiftId?: string }).shiftId : undefined;
      items.push({
        id: rec.id,
        kind: rec.kind,
        ...(rec.commandId ? { commandId: rec.commandId } : {}),
        ...(command ? { command } : {}),
        ...(shiftId ? { shiftId } : {}),
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
    const steps: LocalStep[] = this.listSteps()
      .filter((st) => localCommandOk(st.command))
      .map((st) => ({
        key: st.key,
        kind: st.kind,
        summary: st.summary,
        command: st.command,
        ...(st.shiftId ? { shiftId: st.shiftId } : {}),
      }));
    const text = JSON.stringify([items, steps]);
    if (!force && text === this.lastSent) return;
    this.lastSent = text;
    try {
      this.deps.send('approvals.held', { items: items.slice(0, 200), ...(this.deps.cli ? { steps } : {}) });
    } catch (err) {
      this.deps.log.warn(`could not report held items: ${String(err)}`);
    }
  }
}

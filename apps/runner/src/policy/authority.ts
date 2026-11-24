import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertNotAgentSession, checkSeal, sealIfKeyed } from './integrity.ts';
import type { Policy } from './schema.ts';
import { PolicyStore, type PolicyStoreOptions, policyDir, writeFileAtomic } from './store.ts';

/**
 * What the runner asks the local authority (R18-S). Production reads policy.json (`FileAuthority`); tests inject their
 * own. Nothing here is ever taken from the server.
 */
export interface LocalAuthority {
  policy(): Policy;
  /** The agent holds a local DevOps grant for the organization (`guildwise-runner devops grant`). */
  devopsGranted(orgId: string, agentId: string): boolean;
  /**
   * A CEO owner turn may run with full power: the opt-in (`policy.json` `ceo.fullPower`) AND a local action that opened
   * one turn (`guildwise-runner ceo turn`, or the tray). Consumes that turn.
   */
  takeOwnerTurn(): boolean;
  /**
   * Test doubles only: approve a held kind at once, as if the owner had typed yes. The file authority never implements it,
   * so on a workstation every held item waits for `guildwise-runner approve`.
   */
  autoApprove?(kind: string): boolean;
}

/** `ceo-turn.json` beside the policy: one owner turn opened on this machine, valid until `until`. */
export const CEO_TURN_FILE = 'ceo-turn.json';

export function openOwnerTurn(dir: string, minutes: number, now = Date.now()): string {
  assertNotAgentSession();
  const until = new Date(now + minutes * 60_000).toISOString();
  // T2: sealed, so a turn file written outside the runner's CLI never opens a full-power turn
  writeFileAtomic(join(dir, CEO_TURN_FILE), `${JSON.stringify(sealIfKeyed(dir, { until }))}\n`, 0o600);
  return until;
}

export class FileAuthority implements LocalAuthority {
  constructor(
    readonly store: PolicyStore = new PolicyStore(),
    private readonly now: () => number = Date.now,
  ) {}

  policy(): Policy {
    return this.store.get();
  }

  devopsGranted(orgId: string, agentId: string): boolean {
    // a DevOps shift without an organization cannot be checked against a grant: refused
    return !!orgId && !!agentId && this.policy().devops.agents[orgId] === agentId;
  }

  takeOwnerTurn(): boolean {
    if (!this.policy().ceo.fullPower) return false;
    const file = join(this.store.dir, CEO_TURN_FILE);
    let until = 0;
    let sealed = false;
    try {
      const { check, body } = checkSeal(this.store.dir, JSON.parse(readFileSync(file, 'utf8')));
      sealed = check === 'ok';
      until = Date.parse(String((body as { until?: string } | null)?.until ?? ''));
    } catch {
      return false;
    }
    rmSync(file, { force: true }); // one turn per local action
    return sealed && Number.isFinite(until) && until > this.now();
  }
}

export const defaultAuthority = (dir: string = policyDir(), opts: PolicyStoreOptions = {}): FileAuthority =>
  new FileAuthority(new PolicyStore(dir, opts));

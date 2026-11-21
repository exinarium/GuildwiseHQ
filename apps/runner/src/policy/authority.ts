import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Policy } from './schema.ts';
import { PolicyStore, policyDir, writeFileAtomic } from './store.ts';

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
  const until = new Date(now + minutes * 60_000).toISOString();
  writeFileAtomic(join(dir, CEO_TURN_FILE), `${JSON.stringify({ until })}\n`, 0o600);
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
    try {
      until = Date.parse((JSON.parse(readFileSync(file, 'utf8')) as { until?: string }).until ?? '');
    } catch {
      return false;
    }
    rmSync(file, { force: true }); // one turn per local action
    return Number.isFinite(until) && until > this.now();
  }
}

export const defaultAuthority = (dir: string = policyDir()): FileAuthority =>
  new FileAuthority(new PolicyStore(dir));

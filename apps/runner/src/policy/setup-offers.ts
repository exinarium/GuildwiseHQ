import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from './store.ts';

/**
 * `<pairing dir>/setup-offers.json` (W9 `setup/offers.ts` `SetupOffersSchema`): what the server offered for the DevOps step
 * of `guildwise-runner setup`. No protocol message carries the organizations and their DevOps agents, so the runner
 * records what it learns from the DevOps shifts the server sends for agents that hold no local grant. Setup shows each
 * offer as a suggestion that defaults to no; nothing here grants anything.
 */
export const SETUP_OFFERS_FILE = 'setup-offers.json';

const OfferSchema = z.object({
  orgId: z.uuid(),
  orgName: z.string().min(1).max(200),
  role: z.string().min(1).max(40),
  devopsAgentId: z.uuid().optional(),
});
const OffersSchema = z.object({ orgs: z.array(OfferSchema).max(500).default([]) });
export type SetupOffer = z.infer<typeof OfferSchema>;

export function readSetupOffers(pairingDir: string): SetupOffer[] {
  try {
    const r = OffersSchema.safeParse(JSON.parse(readFileSync(join(pairingDir, SETUP_OFFERS_FILE), 'utf8')));
    return r.success ? r.data.orgs : [];
  } catch {
    return [];
  }
}

/** Adds or replaces the offer for one organization (mode 600). Returns false when nothing changed. */
export function recordSetupOffer(pairingDir: string, offer: SetupOffer): boolean {
  const parsed = OfferSchema.safeParse(offer);
  if (!parsed.success) return false;
  const cur = readSetupOffers(pairingDir);
  const same = cur.find((o) => o.orgId === offer.orgId);
  if (same && JSON.stringify(same) === JSON.stringify(parsed.data)) return false;
  const next = [...cur.filter((o) => o.orgId !== offer.orgId), parsed.data].slice(-500);
  mkdirSync(pairingDir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(pairingDir, SETUP_OFFERS_FILE), `${JSON.stringify({ orgs: next }, null, 2)}\n`, 0o600);
  return true;
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * What the server *offers* for the DevOps step of `setup` [rv6-6, Q13]: the organizations of the pairing, the role the
 * server says the user has there, and the DevOps engineer the server reports for this workstation. Kept per pairing in
 * `<pairing dir>/setup-offers.json` by the runner from what the server tells it. Nothing in here is ever adopted
 * without a local yes per item; every item defaults to no.
 */
export const SETUP_OFFERS_FILE = 'setup-offers.json';

export const SetupOfferSchema = z.object({
  orgId: z.uuid(),
  orgName: z.string().min(1).max(200),
  /** What the server says; shown as "the server says you are <role>", never trusted. */
  role: z.string().min(1).max(40),
  /** The DevOps agent the server reports for this organization on this workstation; without one nothing can be granted yet. */
  devopsAgentId: z.uuid().optional(),
});
export type SetupOffer = z.infer<typeof SetupOfferSchema>;

export const SetupOffersSchema = z.object({ orgs: z.array(SetupOfferSchema).max(500).default([]) });

/** The offers of every pairing, one per organization (the first pairing that names it wins). Bad files are ignored. */
export function readOffers(pairingDirs: readonly string[]): SetupOffer[] {
  const out = new Map<string, SetupOffer>();
  for (const dir of pairingDirs) {
    const file = join(dir, SETUP_OFFERS_FILE);
    if (!existsSync(file)) continue;
    try {
      const r = SetupOffersSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (!r.success) continue;
      for (const o of r.data.orgs) if (!out.has(o.orgId)) out.set(o.orgId, o);
    } catch {
      // an unreadable cache offers nothing
    }
  }
  return [...out.values()];
}

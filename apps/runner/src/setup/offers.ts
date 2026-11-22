import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlainNameSchema, type SetupOffersWire, urlHasPassword } from '@aom/shared';
import { z } from 'zod';
import { writeFileAtomic } from '../policy/store.ts';

/**
 * What the server *offers* for the installer's one screen [rv6-6, Q13, easy-runner-setup]: the organisations this
 * workstation works for, the role the server says the user has there, the DevOps helper the server hired for this
 * workstation (id and name), and the repositories of their projects. Kept per pairing in
 * `<pairing dir>/setup-offers.json`, written from the pair response and refreshed by every `welcome`. Nothing in here
 * is ever adopted without a local yes per item; every item defaults to No.
 */
export const SETUP_OFFERS_FILE = 'setup-offers.json';

export const SetupOfferSchema = z.object({
  orgId: z.uuid(),
  /** Plain text: names with control characters (ANSI escapes) are refused [S2]. */
  orgName: PlainNameSchema,
  /** What the server says; shown as "you are <role>", never trusted. */
  role: z.string().regex(/^[^\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]{1,40}$/u),
  /** The DevOps agent the server reports for this organization on this workstation; without one nothing can be granted yet. */
  devopsAgentId: z.uuid().optional(),
  devopsAgentName: PlainNameSchema.optional(),
});
export type SetupOffer = z.infer<typeof SetupOfferSchema>;

export const RepoOfferSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[^\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\s]+$/u)
    .refine((u) => !urlHasPassword(u), 'an address with a password'),
  name: PlainNameSchema,
});
export type RepoOffer = z.infer<typeof RepoOfferSchema>;

/** Each entry is checked on its own: one bad name drops that entry, not the file. */
const lenient = <T extends z.ZodTypeAny>(s: T) =>
  z
    .array(z.unknown())
    .max(500)
    .default([])
    .transform((v) =>
      v.flatMap((x) => {
        const r = s.safeParse(x);
        return r.success ? [r.data as z.infer<T>] : [];
      }),
    );

export const SetupOffersSchema = z.object({
  orgs: lenient(SetupOfferSchema),
  repos: lenient(RepoOfferSchema),
});
export interface SetupOffersFile {
  orgs: SetupOffer[];
  repos: RepoOffer[];
}

function readFile(dir: string): SetupOffersFile | null {
  const file = join(dir, SETUP_OFFERS_FILE);
  if (!existsSync(file)) return null;
  try {
    const r = SetupOffersSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return r.success ? r.data : null;
  } catch {
    // an unreadable cache offers nothing
    return null;
  }
}

/** The offers of every pairing, one per organization (the first pairing that names it wins). Bad files are ignored. */
export function readOffers(pairingDirs: readonly string[]): SetupOffer[] {
  return readAllOffers(pairingDirs).orgs;
}

/** Organisations and repositories of every pairing (the first pairing that names one wins). */
export function readAllOffers(pairingDirs: readonly string[]): SetupOffersFile {
  const orgs = new Map<string, SetupOffer>();
  const repos = new Map<string, RepoOffer>();
  for (const dir of pairingDirs) {
    const f = readFile(dir);
    if (!f) continue;
    for (const o of f.orgs) if (!orgs.has(o.orgId)) orgs.set(o.orgId, o);
    for (const r of f.repos) if (!repos.has(r.url)) repos.set(r.url, r);
  }
  return { orgs: [...orgs.values()], repos: [...repos.values()] };
}

/** One pairing's offers (empty when there are none). */
export function readSetupOffers(pairingDir: string): SetupOffer[] {
  return readFile(pairingDir)?.orgs ?? [];
}

function save(pairingDir: string, f: SetupOffersFile): void {
  mkdirSync(pairingDir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(pairingDir, SETUP_OFFERS_FILE), `${JSON.stringify(f, null, 2)}\n`, 0o600);
}

/**
 * Replaces this pairing's offers with what the server sent (pair response, `welcome`). Entries that fail the schema are
 * dropped. Returns false when nothing changed.
 */
export function writeOffers(pairingDir: string, wire: SetupOffersWire): boolean {
  const next = SetupOffersSchema.parse(wire);
  const cur = readFile(pairingDir);
  if (cur && JSON.stringify(cur) === JSON.stringify(next)) return false;
  save(pairingDir, next);
  return true;
}

/**
 * Adds an offer for one organization learned from a refused DevOps shift (older servers send no offers). A named offer
 * the server already sent is never replaced by such a placeholder. Returns false when nothing changed.
 */
export function recordSetupOffer(pairingDir: string, offer: SetupOffer): boolean {
  const parsed = SetupOfferSchema.safeParse(offer);
  if (!parsed.success) return false;
  const cur = readFile(pairingDir) ?? { orgs: [], repos: [] };
  const same = cur.orgs.find((o) => o.orgId === offer.orgId);
  if (same && (JSON.stringify(same) === JSON.stringify(parsed.data) || same.role !== 'unknown')) return false;
  const orgs = [...cur.orgs.filter((o) => o.orgId !== offer.orgId), parsed.data].slice(-500);
  save(pairingDir, { ...cur, orgs });
  return true;
}

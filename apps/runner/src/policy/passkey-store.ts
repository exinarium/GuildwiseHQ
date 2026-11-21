import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PasskeyOfferPayload, PasskeyOfferPayloadSchema } from '@aom/shared';
import { z } from 'zod';
import { policyDir, writeFileAtomic } from './store.ts';

/**
 * Passkey offers the server sent (`passkey.offer`), kept PENDING until `guildwise-runner passkey trust` on this machine
 * (R22), and the highest sign count seen per trusted credential. Both sit beside policy.json; neither ever trusts
 * anything by itself.
 */

const OfferRecordSchema = PasskeyOfferPayloadSchema.extend({
  /** The pairing whose server sent it, and that server's origin. */
  pairing: z.string(),
  serverOrigin: z.string(),
  receivedAt: z.iso.datetime(),
});
export type PasskeyOfferRecord = z.infer<typeof OfferRecordSchema>;

function readJson<T>(file: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

export class PasskeyStore {
  readonly offersFile: string;
  readonly countersFile: string;
  constructor(readonly dir: string = policyDir()) {
    this.offersFile = join(dir, 'passkey-offers.json');
    this.countersFile = join(dir, 'passkey-counters.json');
  }

  private write(file: string, v: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify(v, null, 2)}\n`, 0o600);
  }

  offers(): PasskeyOfferRecord[] {
    return readJson(this.offersFile, z.array(OfferRecordSchema), []);
  }

  addOffer(o: PasskeyOfferPayload, pairing: string, serverOrigin: string, now = new Date()): void {
    const rest = this.offers().filter((x) => x.credentialId !== o.credentialId);
    rest.push({ ...o, pairing, serverOrigin, receivedAt: now.toISOString() });
    this.write(this.offersFile, rest.slice(-50));
  }

  removeOffer(credentialId: string): void {
    const cur = this.offers();
    const next = cur.filter((x) => x.credentialId !== credentialId);
    if (next.length !== cur.length) this.write(this.offersFile, next);
  }

  signCounts(): Record<string, number> {
    return readJson(this.countersFile, z.record(z.string(), z.number().int().nonnegative()), {});
  }

  noteSignCount(credentialId: string, count: number): void {
    const cur = this.signCounts();
    if ((cur[credentialId] ?? 0) >= count) return;
    cur[credentialId] = count;
    this.write(this.countersFile, cur);
  }
}

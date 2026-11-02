import { join } from 'node:path';
import { z } from 'zod';
import { SealedFile } from '../secrets/sealed-file.ts';
import type { StoredConnection } from './types.ts';

const ConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('onedrive'),
    siteUrl: z.string().optional(),
    driveId: z.string(),
    baseFolder: z.string(),
    baseItemId: z.string().optional(),
  }),
  z.object({ kind: z.literal('google_drive'), baseFolder: z.string(), baseFolderId: z.string().optional() }),
  z.object({
    kind: z.literal('s3'),
    endpoint: z.string(),
    region: z.string(),
    bucket: z.string(),
    prefix: z.string(),
    pathStyle: z.boolean(),
  }),
  z.object({ kind: z.literal('local'), root: z.string() }),
  z.object({ kind: z.literal('vault'), vaultId: z.string(), folder: z.string() }),
]);
const AuthSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('oauth'),
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number(),
    scope: z.string(),
    account: z.string().optional(),
  }),
  z.object({
    type: z.literal('keys'),
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
    sessionToken: z.string().optional(),
  }),
]);
const StoredSchema = z.object({
  kind: z.enum(['onedrive', 'google_drive', 's3', 'local', 'vault']),
  savedAt: z.string(),
  config: ConfigSchema,
  auth: AuthSchema.optional(),
  needsReauth: z.boolean().optional(),
});
export const StorageSecretsSchema = z.object({ connections: z.record(z.string(), StoredSchema) });
export type StorageSecrets = z.infer<typeof StorageSecretsSchema>;

/** The values that must never reach a log line. */
export function storageSecretsOf(v: StorageSecrets): string[] {
  const out: string[] = [];
  for (const c of Object.values(v.connections)) {
    if (c.auth?.type === 'oauth') out.push(c.auth.accessToken, c.auth.refreshToken);
    if (c.auth?.type === 'keys') {
      out.push(c.auth.secretAccessKey);
      if (c.auth.sessionToken) out.push(c.auth.sessionToken);
    }
  }
  return out.filter((s) => s.length >= 3);
}

/** `secrets/storage.json`: every connection's config and credentials, sealed on this workstation only. */
export class StorageStore {
  private readonly file: SealedFile<StorageSecrets>;
  constructor(secretsDir: string, keyOf: (name: string) => Buffer) {
    this.file = new SealedFile(join(secretsDir, 'storage.json'), keyOf, StorageSecretsSchema, storageSecretsOf);
  }
  private all(): StorageSecrets {
    return this.file.load() ?? { connections: {} };
  }
  get(id: string): StoredConnection | undefined {
    return this.all().connections[id] as StoredConnection | undefined;
  }
  list(): Array<[string, StoredConnection]> {
    return Object.entries(this.all().connections) as Array<[string, StoredConnection]>;
  }
  put(id: string, value: StoredConnection): void {
    const all = this.all();
    all.connections[id] = value;
    this.file.save(all);
  }
  /** Removes one connection (and with it the token). The file is deleted when it was the last one. */
  remove(id: string): boolean {
    const all = this.all();
    if (!(id in all.connections)) return false;
    delete all.connections[id];
    if (Object.keys(all.connections).length === 0) this.file.remove();
    else this.file.save(all);
    return true;
  }
}

/** One async lock per key: a token refresh rotates the refresh token, so two must not run at once. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

import { join } from 'node:path';
import { AppIdentitySchema, AppProviderIdSchema } from '@aom/shared';
import { z } from 'zod';
import { unregisterSecret } from '../secrets/redact.ts';
import { SealedFile } from '../secrets/sealed-file.ts';
import type { StoredApp } from './types.ts';

const StoredAppSchema = z.object({
  provider: AppProviderIdSchema,
  host: z.string().max(200),
  appRef: z.string().max(60),
  appId: z.string().max(40),
  installationId: z.string().max(40),
  privateKey: z.string().max(20_000),
  identity: AppIdentitySchema,
  refs: z.array(z.object({ orgId: z.string().max(80), integrationId: z.string().max(80) })).max(100),
  local: z.boolean(),
  savedAt: z.string().max(40),
});
const AppSecretsSchema = z.object({ apps: z.record(z.string(), StoredAppSchema) });
type AppSecrets = z.infer<typeof AppSecretsSchema>;

export const APP_SECRETS_FILE = 'app-integrations.json';

/**
 * Every value of a PEM that must never reach a log line: the whole key, its body on one line, and each body line long
 * enough to be recognised, so a parse error that echoes one line is masked too.
 */
export function pemSecrets(pem: string): string[] {
  const trimmed = pem.trim();
  const body = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('-----'));
  return [trimmed, pem, body.join(''), ...body.filter((l) => l.length >= 16)].filter((s) => s.length >= 3);
}

/** A stored app without its key: what `list()` hands out. */
export type StoredAppInfo = Omit<StoredApp, 'privateKey'>;

/**
 * The automated app keys on this workstation: `secrets/app-integrations.json`, sealed with this runner's key (AES-256-GCM,
 * mode 0600). Only the private key and the facts of the last verify are kept: tokens never go in this file.
 */
export class AppKeyStore {
  private readonly file: SealedFile<AppSecrets>;

  constructor(secretsDir: string, keyOf: (fileName: string) => Buffer) {
    this.file = new SealedFile<AppSecrets>(join(secretsDir, APP_SECRETS_FILE), keyOf, AppSecretsSchema, (v) =>
      Object.values(v.apps).flatMap((a) => pemSecrets(a.privateKey)),
    );
  }

  private read(): AppSecrets {
    const r = this.file.open();
    if (r.state === 'ok') return r.value;
    return { apps: {} };
  }

  private write(v: AppSecrets): void {
    const r = this.file.open();
    if (r.state === 'unreadable') this.file.quarantine();
    if (Object.keys(v.apps).length === 0) this.file.remove();
    else this.file.save(v);
  }

  get(instance: string): StoredApp | undefined {
    return this.read().apps[instance];
  }

  list(): Array<{ instance: string } & StoredAppInfo> {
    return Object.entries(this.read().apps).map(([instance, { privateKey: _k, ...rest }]) => ({ instance, ...rest }));
  }

  instances(): string[] {
    return Object.keys(this.read().apps);
  }

  put(instance: string, app: StoredApp): void {
    const cur = this.read();
    const old = cur.apps[instance];
    this.write({ apps: { ...cur.apps, [instance]: app } });
    if (old && old.privateKey !== app.privateKey) for (const s of pemSecrets(old.privateKey)) unregisterSecret(s);
  }

  addRef(instance: string, ref: { orgId: string; integrationId: string }): void {
    const cur = this.read();
    const app = cur.apps[instance];
    if (!app) return;
    if (app.refs.some((r) => r.orgId === ref.orgId && r.integrationId === ref.integrationId)) return;
    this.write({ apps: { ...cur.apps, [instance]: { ...app, refs: [...app.refs, ref] } } });
  }

  /** Drops a ref. Returns what is left of the copy (undefined when it is not stored). */
  dropRef(instance: string, ref: { orgId: string; integrationId: string }): StoredAppInfo | undefined {
    const cur = this.read();
    const app = cur.apps[instance];
    if (!app) return undefined;
    const refs = app.refs.filter((r) => !(r.orgId === ref.orgId && r.integrationId === ref.integrationId));
    this.write({ apps: { ...cur.apps, [instance]: { ...app, refs } } });
    const { privateKey: _k, ...rest } = { ...app, refs };
    return rest;
  }

  /** Deletes the entry (the file when it was the last) and unregisters its key. */
  remove(instance: string): boolean {
    const cur = this.read();
    const app = cur.apps[instance];
    if (!app) return false;
    const { [instance]: _gone, ...rest } = cur.apps;
    this.write({ apps: rest });
    for (const s of pemSecrets(app.privateKey)) unregisterSecret(s);
    return true;
  }
}

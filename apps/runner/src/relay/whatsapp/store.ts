import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sealLarge } from '@aom/shared';
import type { RunnerKeys } from '../../secrets/keys.ts';
import { registerSecret, unregisterSecret } from '../../secrets/redact.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WhatsAppSecrets {
  appSecret: string;
  verifyToken: string;
  phoneNumberId?: string | undefined;
}

interface Stored {
  sealed: string;
  keyId: string;
  phoneNumberId?: string;
  setAt: string;
}

const aadOf = (id: string, keyId: string): string => `relay.whatsapp.v1|${id}|${keyId}`;
const plainMap = <T>(j: unknown): Record<string, T> =>
  Object.assign(Object.create(null) as Record<string, T>, j && typeof j === 'object' ? j : {});

/**
 * WhatsApp secrets of this workstation, per relay integration: the Meta app secret and the verify token sealed with the
 * runner's own key (bound to the integration id and key), in `secrets/relay-whatsapp.json` (0600). Opened values live in
 * memory only and are registered for log redaction. They never leave this machine.
 */
export class WhatsAppSecretStore {
  private open = new Map<string, WhatsAppSecrets>();

  constructor(
    private readonly deps: {
      file: string;
      keys: Pick<RunnerKeys, 'decryptAny' | 'publicKey'>;
    },
  ) {
    this.reload();
  }

  private read(): Record<string, Stored> {
    if (!existsSync(this.deps.file)) return plainMap<Stored>({});
    try {
      return plainMap<Stored>(JSON.parse(readFileSync(this.deps.file, 'utf8')));
    } catch {
      return plainMap<Stored>({});
    }
  }

  private write(data: Record<string, Stored>): void {
    mkdirSync(dirname(this.deps.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.deps.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, this.deps.file);
    try {
      chmodSync(this.deps.file, 0o600);
    } catch {
      // Windows
    }
  }

  static normalizeId(id: string): string {
    if (!UUID_RE.test(id)) throw new Error(`'${id}' is not an integration id (a UUID)`);
    return id.toLowerCase();
  }

  async set(id: string, s: WhatsAppSecrets): Promise<void> {
    const key = WhatsAppSecretStore.normalizeId(id);
    if (!/^\S{16,256}$/.test(s.appSecret))
      throw new Error('the app secret must be 16-256 characters without spaces');
    if (!/^[\x21-\x7e]{8,256}$/.test(s.verifyToken))
      throw new Error('the verify token must be 8-256 printable characters without spaces');
    if (s.phoneNumberId !== undefined && !/^\d{5,30}$/.test(s.phoneNumberId))
      throw new Error('the phone number id must be 5-30 digits');
    const { keyId, publicKey } = this.deps.keys.publicKey;
    const sealed = await sealLarge(
      publicKey,
      JSON.stringify({ appSecret: s.appSecret, verifyToken: s.verifyToken }),
      aadOf(key, keyId),
    );
    const data = this.read();
    data[key] = {
      sealed,
      keyId,
      ...(s.phoneNumberId ? { phoneNumberId: s.phoneNumberId } : {}),
      setAt: new Date().toISOString(),
    };
    this.write(data);
    this.reload();
  }

  remove(id: string): boolean {
    const key = id.toLowerCase();
    const data = this.read();
    if (!(key in data)) return false;
    delete data[key];
    this.write(data);
    this.reload();
    return true;
  }

  ids(): string[] {
    return [...this.open.keys()];
  }

  get(id: string): WhatsAppSecrets | undefined {
    return this.open.get(id.toLowerCase());
  }

  list(): Array<{ id: string; phoneNumberId?: string; setAt: string; readable: boolean }> {
    return Object.entries(this.read()).map(([id, v]) => ({
      id,
      ...(v.phoneNumberId ? { phoneNumberId: v.phoneNumberId } : {}),
      setAt: v.setAt,
      readable: this.open.has(id),
    }));
  }

  /** Re-reads the file; registers new values and unregisters removed or replaced ones. True when the set of ids changed. */
  reload(): boolean {
    const before = [...this.open.keys()].sort().join(',');
    const next = new Map<string, WhatsAppSecrets>();
    for (const [id, v] of Object.entries(this.read())) {
      try {
        const j = JSON.parse(
          this.deps.keys.decryptAny(v.sealed, aadOf(id, v.keyId), { requireBound: true }),
        ) as { appSecret: string; verifyToken: string };
        if (typeof j.appSecret !== 'string' || typeof j.verifyToken !== 'string') throw new Error('shape');
        next.set(id, { appSecret: j.appSecret, verifyToken: j.verifyToken, phoneNumberId: v.phoneNumberId });
      } catch {
        // unreadable (runner key changed): not served, shown by list()
      }
    }
    const keep = new Set<string>();
    for (const s of next.values()) {
      keep.add(s.appSecret);
      keep.add(s.verifyToken);
    }
    for (const s of this.open.values()) {
      if (!keep.has(s.appSecret)) unregisterSecret(s.appSecret);
      if (!keep.has(s.verifyToken)) unregisterSecret(s.verifyToken);
    }
    for (const k of keep) registerSecret(k);
    this.open = next;
    return before !== [...next.keys()].sort().join(',');
  }
}

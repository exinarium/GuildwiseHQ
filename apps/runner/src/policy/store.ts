import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  assertNotAgentSession,
  checkSeal,
  ensurePolicyKey,
  keyLost,
  POLICY_KEY_FILE,
  readPolicyKey,
  type SealCheck,
  seal,
  writeSealMarker,
} from './integrity.ts';
import { DEFAULT_POLICY, POLICY_FILE, POLICY_FILE_MODE, type Policy, PolicySchema } from './schema.ts';

/**
 * Where `policy.json` lives (R18-S): `~/.config/aom-runner/`, outside the runner's data directory so a pairing or a
 * reinstall of the data never carries grants. `AOM_RUNNER_POLICY_DIR` moves it (tests, a non-default HOME); it is read
 * from the runner's own environment, which the server cannot set.
 */
export function policyDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AOM_RUNNER_POLICY_DIR) return env.AOM_RUNNER_POLICY_DIR;
  return join(homedir(), '.config', 'aom-runner');
}

export interface PolicyRead {
  policy: Policy;
  /** The file exists but is not a valid policy: the safe default is used and this says why. */
  error: string | null;
  /** The file does not exist (a machine that never ran `setup` or any grant command). */
  missing: boolean;
  /**
   * T2: a policy from before the seal, read as it is until the runner adopts it once (no key, no seal, no toolchain
   * pins, no adoption marker). Any other unsealed state is an error.
   */
  adoptable?: boolean;
}

export interface PolicyStoreOptions {
  /** `<dataDir>/keys/policy-sealed`: present once the policy was sealed, so a deleted key is never adopted again. */
  sealMarker?: string;
  /** Told when a write created the key (logged at warn, shown by `guildwise-runner policy` and status.json). */
  onKeyCreated?: (file: string) => void;
}

/** Writes `text` to `file` atomically (a temp file renamed over it) with the given mode. */
export function writeFileAtomic(file: string, text: string, mode: number): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

/**
 * The local authority on this machine. The CLI writes it (`approve --pin`, `devops grant`, `passkey trust`,
 * `signing add-key`, `repo allow-scripts`, ... and W9's `setup`); the running runner only reads it, re-reading whenever
 * the file changes. An unreadable or invalid file never grants anything: the default policy (everything off, deploys
 * ask, nothing trusted) applies until it is fixed on the machine.
 */
export class PolicyStore {
  readonly file: string;
  private cache: { stamp: string; read: PolicyRead } | null = null;

  constructor(
    readonly dir: string = policyDir(),
    readonly opts: PolicyStoreOptions = {},
  ) {
    this.file = join(dir, POLICY_FILE);
  }

  private stamp(): string {
    const st = (f: string) => {
      try {
        const s = statSync(f);
        return `${s.mtimeMs}:${s.size}:${s.ino}`;
      } catch {
        return 'missing';
      }
    };
    // the key and the marker are part of what a read means: a deleted key must not keep a cached "sealed" answer
    const own = st(this.file);
    if (own === 'missing') return 'missing';
    return `${own}|${st(join(this.dir, POLICY_KEY_FILE))}|${this.opts.sealMarker ? st(this.opts.sealMarker) : ''}`;
  }

  read(): PolicyRead {
    const stamp = this.stamp();
    if (this.cache?.stamp === stamp) return this.cache.read;
    let read: PolicyRead;
    if (stamp === 'missing') read = { policy: DEFAULT_POLICY, error: null, missing: true };
    else {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
        const { check, body } = checkSeal(this.dir, raw);
        const sealError = this.sealError(check, body);
        const parsed = PolicySchema.safeParse(body);
        read = sealError
          ? { policy: DEFAULT_POLICY, error: sealError, missing: false }
          : parsed.success
            ? {
                policy: parsed.data,
                error: null,
                missing: false,
                ...(check === 'no_key' ? { adoptable: true } : {}),
              }
            : {
                policy: DEFAULT_POLICY,
                error: parsed.error.issues
                  .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                  .join('; '),
                missing: false,
              };
      } catch (err) {
        read = {
          policy: DEFAULT_POLICY,
          error: `not valid JSON (${err instanceof Error ? err.message : String(err)})`,
          missing: false,
        };
      }
    }
    this.cache = { stamp, read };
    return read;
  }

  /** Why a seal state grants nothing (null: it may be used). Fail closed: the defaults then apply (everything asks). */
  private sealError(check: SealCheck, body: Record<string, unknown> | null): string | null {
    if (check === 'ok') return null;
    if (check === 'bad')
      return 'the policy was changed outside the runner (its seal does not match): everything asks until `guildwise-runner policy accept`';
    if (check === 'unsealed')
      return 'the policy has no seal: everything asks until `guildwise-runner policy accept`';
    // no key: only a policy from before the seal may be adopted, once
    const pinned = !!body && 'toolchainPins' in body;
    const sealedBefore = (!!this.opts.sealMarker && existsSync(this.opts.sealMarker)) || keyLost(this.dir);
    if (pinned || sealedBefore)
      return 'the policy key is missing although this policy was sealed: everything asks until `guildwise-runner policy accept`';
    return null;
  }

  get(): Policy {
    return this.read().policy;
  }

  /**
   * T2 (S4): seals a policy from before the seal, once. Pins the toolchains that were already registered (they stay on
   * PATH) and writes the adoption marker. False when there is nothing to adopt (already sealed, missing or invalid).
   */
  adopt(toolchainHashes: readonly string[] = []): boolean {
    const cur = this.read();
    // a machine without any policy yet: the runner makes the key now, so every later write is sealed
    if (
      cur.missing &&
      !readPolicyKey(this.dir) &&
      !(this.opts.sealMarker && existsSync(this.opts.sealMarker))
    ) {
      ensurePolicyKey(this.dir, this.opts.onKeyCreated);
      if (this.opts.sealMarker) writeSealMarker(this.opts.sealMarker);
      return false;
    }
    if (!cur.adoptable || cur.error) return false;
    const pins = [...new Set([...cur.policy.toolchainPins, ...toolchainHashes])];
    this.writeSealed({ ...cur.policy, toolchainPins: pins }, true);
    return true;
  }

  /**
   * `guildwise-runner policy accept`: seals the file as it is now (after the owner read it), with the existing key or a
   * new one. Refuses an invalid file.
   */
  accept(): Policy {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new Error(`${this.file} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { body } = checkSeal(this.dir, raw);
    const parsed = PolicySchema.parse(body ?? {});
    this.writeSealed(parsed, true);
    return parsed;
  }

  /**
   * Changes the policy (CLI only). Refuses to build on an invalid file, so a typo is never silently replaced by the
   * defaults; the result is validated before it is written (mode 600, atomic).
   */
  update(change: (p: Policy) => Policy | undefined): Policy {
    const cur = this.read();
    if (cur.error)
      throw new Error(`${this.file} is not a valid policy (${cur.error}); fix or remove it first`);
    const draft = structuredClone(cur.policy);
    const next = PolicySchema.parse(change(draft) ?? draft);
    this.write(next);
    return next;
  }

  write(policy: Policy): void {
    this.writeSealed(policy, false);
  }

  /**
   * Sealed with the key; only the runner's adoption and `policy accept` may create it (Rework 1, S1). Without a key the
   * file is written as before the seal (no `toolchainPins` while empty), so the runner's first start still adopts it.
   */
  private writeSealed(policy: Policy, createKey: boolean): void {
    assertNotAgentSession();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const key = createKey ? ensurePolicyKey(this.dir, this.opts.onKeyCreated) : readPolicyKey(this.dir);
    const body = PolicySchema.parse(policy);
    if (key) {
      writeFileAtomic(this.file, `${JSON.stringify(seal(key, body), null, 2)}\n`, POLICY_FILE_MODE);
      if (this.opts.sealMarker) writeSealMarker(this.opts.sealMarker);
    } else {
      if (body.toolchainPins.length > 0)
        throw new Error(
          'toolchain approvals need a sealed policy: start the runner once, then approve again',
        );
      const { toolchainPins: _none, ...legacy } = body;
      writeFileAtomic(this.file, `${JSON.stringify(legacy, null, 2)}\n`, POLICY_FILE_MODE);
    }
    this.cache = null;
  }

  exists(): boolean {
    return existsSync(this.file);
  }
}

// ---------------------------------------------------------------- what the server narrowed (cached across restarts)

/**
 * `server-narrowing.json` beside the policy: values a server may only narrow with, cached so the next start applies them
 * before connecting (R21: `welcome.requireSignedRunners` makes the start-up check refuse). Keyed by server origin; any
 * pairing whose server requires signed runners narrows the whole machine.
 */
export interface ServerNarrowing {
  requireSignedRunners: Record<string, boolean>;
}

export class NarrowingStore {
  readonly file: string;
  constructor(readonly dir: string = policyDir()) {
    this.file = join(dir, 'server-narrowing.json');
  }

  read(): ServerNarrowing {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ServerNarrowing>;
      const req: Record<string, boolean> = {};
      for (const [k, b] of Object.entries(v.requireSignedRunners ?? {})) if (b === true) req[k] = true;
      return { requireSignedRunners: req };
    } catch {
      return { requireSignedRunners: {} };
    }
  }

  /** Any server of this machine requires signed runners. */
  requireSignedRunners(): boolean {
    return Object.values(this.read().requireSignedRunners).some(Boolean);
  }

  setRequireSignedRunners(origin: string, on: boolean): void {
    const cur = this.read();
    if (!!cur.requireSignedRunners[origin] === on) return;
    if (on) cur.requireSignedRunners[origin] = true;
    else delete cur.requireSignedRunners[origin];
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify(cur, null, 2)}\n`, 0o600);
  }
}

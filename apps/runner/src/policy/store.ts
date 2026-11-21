import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

  constructor(readonly dir: string = policyDir()) {
    this.file = join(dir, POLICY_FILE);
  }

  private stamp(): string {
    try {
      const s = statSync(this.file);
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return 'missing';
    }
  }

  read(): PolicyRead {
    const stamp = this.stamp();
    if (this.cache?.stamp === stamp) return this.cache.read;
    let read: PolicyRead;
    if (stamp === 'missing') read = { policy: DEFAULT_POLICY, error: null, missing: true };
    else {
      try {
        const parsed = PolicySchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
        read = parsed.success
          ? { policy: parsed.data, error: null, missing: false }
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

  get(): Policy {
    return this.read().policy;
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
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify(PolicySchema.parse(policy), null, 2)}\n`, POLICY_FILE_MODE);
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

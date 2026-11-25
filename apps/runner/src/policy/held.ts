import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalJson, sha256Hex } from './deploy-pin.ts';
import { assertNotAgentSession, checkSeal, keyLost, type SealCheck, sealIfKeyed } from './integrity.ts';
import { policyDir, writeFileAtomic } from './store.ts';

/**
 * Items held for a local approval (R18-S, R18-D): one file per item under `<policy dir>/held/` (mode 600), so the
 * running runner and the CLI (`guildwise-runner approve|deny <id>`) never write the same file at the same time. The
 * runner writes an item when it holds a command; the CLI only changes `state` (and `pin`); the runner then runs or
 * refuses it and removes the file. Held items expire after 24 h.
 */

export const HELD_TTL_MS = 24 * 3_600_000;

export const HeldRecordSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{6,32}$/),
  /** The runner's name for what is held (`deploy.exec`, `deploy.commit_redeploy`, `recipe.write`, `devops.task`, ...). */
  kind: z.string().min(1).max(60),
  /** The pairing (its data directory) that holds it: only that runner acts on it. */
  pairing: z.string().min(1).max(1000),
  /** The server command this item holds, when it came from one. */
  commandId: z.string().max(80).optional(),
  /** One line, as shown in lists and sent to the server. Never a secret value. */
  summary: z.string().max(500),
  /** The full text `approve` prints: the command as the runner received it. Never a secret value. */
  detail: z.string().max(200_000),
  commandHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** What to replay once approved (the server message or command payload); stays on this machine. */
  replay: z.object({ type: z.string().max(60), body: z.unknown() }),
  /** Deploy pins this item can add with `approve --pin`: the hash without the commit, and with it. */
  pin: z.object({ base: z.string().length(64), bound: z.string().length(64).nullable() }).optional(),
  /** Why it is held beyond its kind (`setup pending`, ...), shown with it. */
  note: z.string().max(300).optional(),
  state: z.enum(['held', 'approved', 'denied']).default('held'),
  decidedAt: z.iso.datetime().optional(),
  decidedBy: z.enum(['local', 'passkey']).optional(),
  /** `approve --pin`: the CLI also wrote the pin into policy.json. */
  pinned: z.boolean().optional(),
  /** `release.sign` approved in the CLI: the signature made there (a passphrase key signs only at the keyboard). */
  signature: z.string().max(4096).optional(),
  /**
   * quiet-approvals S2: the version of what this item shows and will run, set at every hold and in-place update. A
   * decision names the version it was shown; `decide` is a compare-and-set on it, so a newer shift of the same request
   * that replaced the replay meanwhile is never approved unseen (Found T11). For a held shift start it ignores only the
   * IDENTITY ids (e2e-found-fixes S2: separate from the R2 key, so a new system entry still changes it).
   */
  version: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** The passkey challenge published for this item (R22): one nonce per item, never reused. */
  passkey: z
    .object({
      nonce: z.string(),
      challenge: z.string(),
      expiresAt: z.iso.datetime(),
      usedNonce: z.boolean().default(false),
    })
    .optional(),
});
export type HeldRecord = z.infer<typeof HeldRecordSchema>;

/** Room for the approval text in a held record (the schema allows 200,000 characters). */
export const HELD_DETAIL_MAX = 190_000;

/** Caps an approval text with a clear marker, so a very large recipe is still held and shown (cut). */
export function capDetail(text: string, max: number = HELD_DETAIL_MAX): string {
  if (text.length <= max) return text;
  const marker = (n: number) =>
    `\n... (truncated, ${n} more characters; read the full recipe in the vault before approving)`;
  const keep = max - marker(text.length).length;
  return `${text.slice(0, keep)}${marker(text.length - keep)}`;
}

export const newHeldId = (): string => randomBytes(5).toString('hex');

/**
 * quiet-approvals [B3]: the top-level dispatch ids of a `shift.start` that change with every dispatch. The record keeps
 * the approved body without them (`withoutDispatchIds`); the R2 key and the S2 version use the finer lists below.
 */
export const DISPATCH_IDS: readonly string[] = [
  'shiftId',
  'claimId',
  'queuedAt',
  'dispatchedAt',
  // the wire envelope of every server message: its frame id and send time (never job content)
  'id',
  'ts',
];

/** The body without its dispatch ids (top level only, a constant list). */
export function withoutDispatchIds(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const k of DISPATCH_IDS) delete out[k];
  return out;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * e2e-found-fixes D2: the IDENTITY of a DevOps `shift.start` (DESIGN "Every field of the real DevOps shift.start"). These
 * values name the dispatch, never what the job may do: they are left out of the R2 key and the S2 version, and on a
 * match they are the ONLY values taken from the new message (`rebind`). The request id is not inert (it picks the
 * request folder): a match under a new one runs outside only through the runner's cross-request guard (B1).
 */
export const IDENTITY: readonly (readonly string[])[] = [
  ['v'],
  ['id'],
  ['type'],
  ['ts'],
  ['shiftId'],
  ['claimId'],
  ['brief', 'shift', 'id'],
  ['brief', 'card', 'id'],
  ['brief', 'project', 'id'],
  ['devops', 'requestId'],
  ['devops', 'threadId'],
];

/**
 * D2: what decides what a DevOps job may do, as an ALLOWLIST: the R2 key is computed over these fields only.
 * - `top`: the top-level fields of `ShiftStartSchema` in the key;
 * - `brief`: the whole brief except the IDENTITY ids of its `shift`, `card` and `project` (every `ShiftBriefSchema` key);
 * - `devops`: the fields of `DevopsShiftSchema` in the key; `history` is reduced to `{authorName, kind, body}` of its
 *   non-system entries (bookkeeping: `workstationName`, each entry's `at`, and the server's `system` entries).
 * A field missing here can never widen a yes: on a match the APPROVED body runs, with only the IDENTITY values new.
 */
export const JOB_KEY_FIELDS = {
  top: [
    'kind',
    'account',
    'agent',
    'worktree',
    'prepare',
    'orgId',
    'maxShiftMinutes',
    'vault',
    'vaults',
    'graph',
    'orgGraph',
    'readRepos',
    'localReadRepos',
    'mcpServers',
    'commitAs',
    'postAs',
    'trackerApp',
    'testServices',
    'playbookGrants',
    'delegation',
    'resumeSessionId',
    'resumeMessage',
    'question',
    'baTask',
    'releasePrep',
    'ceo',
  ],
  brief: 'all but the IDENTITY ids',
  devops: [
    'summary',
    'requestedBy',
    'card',
    'fromWorkstationOwner',
    'contextOrders',
    'access',
    'approval',
    'mergeApprovalWaived',
    'conflictCard',
    'conflictRepo',
    'hygiene',
    'run',
    'scan',
    'scanKind',
    'history',
  ],
} as const;

/** D2: the fields of `devops` and of its history entries that are bookkeeping (out of the key; the approved value runs). */
export const BOOKKEEPING = {
  devops: ['workstationName'],
  historyEntry: ['at'],
  historyKind: 'system',
} as const;

function cloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * REVIEW B-1: the IDENTITY values that change with every dispatch of ONE request (the envelope, the shift and claim ids,
 * the brief's shift id). The request, thread, card and project ids are left in: within a request they never change.
 */
export const DISPATCH_IDENTITY: readonly (readonly string[])[] = IDENTITY.filter(
  (p) => !['devops', 'brief'].includes(p[0] as string) || (p[0] === 'brief' && p[1] === 'shift'),
);

function without(body: unknown, paths: readonly (readonly string[])[]): Obj {
  if (!isObj(body)) return {};
  const out = cloneJson(body);
  for (const path of paths) {
    let o: unknown = out;
    for (const k of path.slice(0, -1)) o = isObj(o) ? o[k] : undefined;
    if (isObj(o)) delete o[path[path.length - 1] as string];
  }
  return out;
}

/** The body without the IDENTITY values (a deep copy): what the R2 key's brief and a rebind compare. */
export const withoutIdentity = (body: unknown): Obj => without(body, IDENTITY);

/**
 * REVIEW B-1: the body without the per-dispatch ids only (a deep copy). The S2 version and the C2 comparison use it, so the
 * request, thread, card and project ids stay pinned there (the project id picks skills and recipe approvals).
 */
export const withoutDispatchIdentity = (body: unknown): Obj => without(body, DISPATCH_IDENTITY);

/** D2: the projection of a `shift.start` the R2 key is computed over (JOB_KEY_FIELDS only). */
export function jobProjection(body: unknown): Obj {
  if (!isObj(body)) return {};
  const out: Obj = {};
  for (const k of JOB_KEY_FIELDS.top) if (body[k] !== undefined) out[k] = body[k];
  if (body.brief !== undefined) out.brief = withoutIdentity({ brief: body.brief }).brief;
  if (isObj(body.devops)) {
    const d = body.devops;
    const devops: Obj = {};
    for (const k of JOB_KEY_FIELDS.devops) {
      if (d[k] === undefined) continue;
      devops[k] =
        k === 'history' && Array.isArray(d.history)
          ? d.history
              .filter((h) => !(isObj(h) && h.kind === BOOKKEEPING.historyKind))
              .map((h) => (isObj(h) ? { authorName: h.authorName, kind: h.kind, body: h.body } : h))
          : d[k];
    }
    out.devops = devops;
  } else if (body.devops !== undefined) out.devops = body.devops;
  return out;
}

/** D2 (quiet-approvals R2): the key of a `shift.start`: sha256 of the canonical `{v: 2, job: jobProjection(body)}`. */
export const r2Key = (body: unknown): string => sha256Hex(canonicalJson({ v: 2, job: jobProjection(body) }));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const at = (o: unknown, path: readonly string[]): unknown => {
  let v: unknown = o;
  for (const k of path) v = isObj(v) ? v[k] : undefined;
  return v;
};

/**
 * cross-request-ids: the IDENTITY values a rebind takes from the new message: the ones that name the dispatch (the
 * envelope, the shift and claim ids, the brief's shift id) and the request id (the request folder, temp folder,
 * environment ownership and the server reply; a new one is guarded by B1). The same rule for every match.
 */
export const REBIND_FROM_NEXT: readonly (readonly string[])[] = [
  ['v'],
  ['id'],
  ['type'],
  ['ts'],
  ['shiftId'],
  ['claimId'],
  ['brief', 'shift', 'id'],
  ['devops', 'requestId'],
];

/**
 * cross-request-ids: the rest of IDENTITY (the brief's card and project ids, the thread id) always stays as APPROVED. The
 * project id selects project-scoped skills and recipe internet approvals, so the server never chooses it on a reused yes.
 */
export const REBIND_FROM_APPROVED: readonly (readonly string[])[] = IDENTITY.filter(
  (p) => !REBIND_FROM_NEXT.some((q) => q.join('.') === p.join('.')),
);

/**
 * D2: the APPROVED body (`approved`, as recorded) with only the `REBIND_FROM_NEXT` values of `next`. Nothing else ever comes
 * from `next`, so the server's new texts (a "lost" note, a new workstation name, new timestamps) and its card, project
 * and thread ids never reach the session. N1 (null: the job then goes into the box):
 * - `next`: every IDENTITY id (the envelope aside) is a uuid, the brief's shift id is the shift id, and the card id, the
 *   project id and the request id are one value (the shape the server builds for a DevOps brief);
 * - `approved`: the card and project ids are equal uuids and the thread id is a uuid. They are NOT required to equal the
 *   approved request id: an adopted entry (B1) deliberately stores a new request id with the original card and project
 *   ids, and its own lost re-send must still match.
 */
export function rebind(approved: Obj, next: unknown): Obj | null {
  if (!isObj(next) || !isObj(approved)) return null;
  for (const path of IDENTITY) {
    if (path.length === 1 && ['v', 'id', 'type', 'ts'].includes(path[0] as string)) continue;
    const v = at(next, path);
    if (typeof v !== 'string' || !UUID.test(v)) return null;
  }
  const requestId = at(next, ['devops', 'requestId']);
  if (at(next, ['brief', 'card', 'id']) !== requestId || at(next, ['brief', 'project', 'id']) !== requestId)
    return null;
  if (at(next, ['brief', 'shift', 'id']) !== next.shiftId) return null;
  const card = at(approved, ['brief', 'card', 'id']);
  const thread = at(approved, ['devops', 'threadId']);
  if (typeof card !== 'string' || !UUID.test(card) || at(approved, ['brief', 'project', 'id']) !== card)
    return null;
  if (typeof thread !== 'string' || !UUID.test(thread)) return null;
  const out = cloneJson(approved);
  if (!isObj(out.brief) || !isObj(out.devops)) return null;
  for (const path of REBIND_FROM_NEXT) {
    let o: unknown = out;
    for (const k of path.slice(0, -1)) o = isObj(o) ? o[k] : undefined;
    if (!isObj(o)) return null;
    const v = at(next, path);
    if (v === undefined) delete o[path[path.length - 1] as string];
    else o[path[path.length - 1] as string] = v;
  }
  return out;
}

/** S2: the version of a held item (what it runs, ids aside, for a shift start; otherwise everything it shows and replays). */
export function heldVersion(r: Pick<HeldRecord, 'kind' | 'summary' | 'detail' | 'replay'>): string {
  if (r.replay.type === 'shift.start')
    return sha256Hex(canonicalJson({ v: 2, start: withoutDispatchIdentity(r.replay.body) }));
  return sha256Hex(canonicalJson({ kind: r.kind, summary: r.summary, detail: r.detail, replay: r.replay }));
}

/** S2: the item changed after it was shown (the page answers 409, the CLI aborts). */
export class HeldVersionMismatch extends Error {
  constructor(readonly id: string) {
    super('This item changed; look again');
  }
}

/** How long a lock on one held item may be held before it is taken as stale (a crashed writer). */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class HeldStore {
  readonly dir: string;
  /** T2 (S2): held records whose seal is missing or wrong are moved here, logged, and never listed or approved. */
  readonly quarantineDir: string;
  constructor(
    readonly root: string = policyDir(),
    private readonly warn: (m: string) => void = () => {},
  ) {
    this.dir = join(root, 'held');
    this.quarantineDir = join(this.dir, 'quarantine');
  }

  private file(id: string): string {
    if (!/^[a-z0-9]{6,32}$/.test(id)) throw new Error(`not a held item id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  put(r: HeldRecord): void {
    assertNotAgentSession();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(
      this.file(r.id),
      `${JSON.stringify(sealIfKeyed(this.root, HeldRecordSchema.parse(r)))}\n`,
      0o600,
    );
  }

  /**
   * A readable record with a good seal. Without a key on this machine (before the policy was adopted) an unsealed
   * record is read as before; the adoption refuses those (`unsealed`). With a key, a missing or wrong seal quarantines it.
   */
  get(id: string): HeldRecord | null {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file(id), 'utf8'));
    } catch {
      return null;
    }
    const { check, body } = checkSeal(this.root, raw);
    // S3: once a key existed, an unsealed record is untrusted even when the key is gone (asked for again)
    if (check === 'bad' || check === 'unsealed' || (check === 'no_key' && keyLost(this.root))) {
      this.quarantine(id, check === 'no_key' ? 'unsealed' : check);
      return null;
    }
    const parsed = HeldRecordSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  }

  private quarantine(id: string, why: SealCheck): void {
    try {
      mkdirSync(this.quarantineDir, { recursive: true, mode: 0o700 });
      renameSync(this.file(id), join(this.quarantineDir, `${id}.json`));
      this.warn(
        `held item ${id} was quarantined: its seal is ${why === 'bad' ? 'wrong' : 'missing'} (changed outside the runner)`,
      );
    } catch {
      // already moved by another process
    }
  }

  /** T2 (S2): ids of records written before the seal (no key yet); the runner refuses them when it adopts the policy. */
  unsealed(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, n), 'utf8')) as Record<string, unknown>;
        if (typeof raw.integrity !== 'string') out.push(n.slice(0, -5));
      } catch {
        // unreadable: never listed anyway
      }
    }
    return out;
  }

  /** Every readable item (of one pairing when given), oldest first. Unreadable files are skipped. */
  list(pairing?: string): HeldRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: HeldRecord[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const r = this.get(n.slice(0, -5));
      if (r && (!pairing || r.pairing === pairing)) out.push(r);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  remove(id: string): void {
    rmSync(this.file(id), { force: true });
  }

  /**
   * S2: runs `fn` while holding this item's lock file (`<id>.lock`, `wx`), so the runner's in-place update and a
   * decision from the CLI or the page never interleave between a read and a write. A lock older than 10 s is stale.
   */
  withLock<T>(id: string, fn: () => T): T {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = `${this.file(id)}.lock`;
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx', 0o600));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
        } catch {
          // gone meanwhile
        }
        if (Date.now() > until) throw new Error(`held item ${id} is busy; try again`);
        sleepSync(25);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }

  /** S2: an in-place change of a still-held item under its lock; the version follows what it now shows. */
  update(id: string, change: (r: HeldRecord) => HeldRecord): HeldRecord | null {
    return this.withLock(id, () => {
      const r = this.get(id);
      if (!r) return null;
      const next = change(r);
      const versioned = { ...next, version: heldVersion(next) };
      this.put(versioned);
      return versioned;
    });
  }

  /** Finds an item by its id or a unique prefix of it (what people type). */
  find(idOrPrefix: string): HeldRecord | null {
    const exact = /^[a-z0-9]{6,32}$/.test(idOrPrefix) ? this.get(idOrPrefix) : null;
    if (exact) return exact;
    const hits = this.list().filter((r) => r.id.startsWith(idOrPrefix));
    return hits.length === 1 ? (hits[0] as HeldRecord) : null;
  }

  /**
   * CLI and page: records the decision. The runner acts on it within a few seconds. S2: with `expectedVersion` it is a
   * compare-and-set: an item whose version is not the one shown is left held and `HeldVersionMismatch` is thrown.
   */
  decide(
    id: string,
    state: 'approved' | 'denied',
    by: 'local' | 'passkey',
    extra: Partial<HeldRecord> = {},
    expectedVersion?: string,
  ): HeldRecord {
    return this.withLock(id, () => {
      const r = this.get(id);
      if (!r) throw new Error(`no held item ${id}`);
      if (r.state !== 'held') throw new Error(`item ${id} is already ${r.state}`);
      if (expectedVersion !== undefined && (r.version ?? heldVersion(r)) !== expectedVersion)
        throw new HeldVersionMismatch(id);
      const next: HeldRecord = {
        ...r,
        ...extra,
        state,
        decidedAt: new Date().toISOString(),
        decidedBy: by,
      };
      this.put(next);
      return next;
    });
  }
}

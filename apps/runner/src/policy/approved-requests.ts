import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './deploy-pin.ts';
import { r2Key, withoutDispatchIdentity, withoutDispatchIds } from './held.ts';
import { assertNotAgentSession, checkSeal, readPolicyKey, seal } from './integrity.ts';
import { policyDir, writeFileAtomic } from './store.ts';

/**
 * quiet-approvals R2 [B3]: the exact DevOps jobs the owner approved on this computer (`<dataDir>/approved-requests.json`,
 * mode 600, in `RUNNER_PRIVATE` and the CEO turn's private entries). One entry per approved `shift.start` and request,
 * keyed by `r2Key` (e2e-found-fixes D2: sha256 over the fields that decide what the job may do, `JOB_KEY_FIELDS`). The
 * held item's version (S2) is separate: it ignores only the IDENTITY ids.
 *
 * - Recorded only for a local decision (`decidedBy === 'local'`: the CLI or the paired page), never a passkey one.
 * - Sealed with the policy key (T2). Without a key nothing is remembered or matched; a seal that is missing or wrong
 *   drops the whole file (fail closed: everything goes back into the box).
 * - An entry lives 24 hours; at most 1000 entries.
 *
 * The C2 resume rule (`c2Resume`) lets a resume of an approved job run outside the box too, but only when it differs
 * from the APPROVED body in `devops.approval`, appended `devops.history` entries, `resumeSessionId` (the session that
 * approved run created) and `resumeMessage`, and only for commands this session itself asked for (`asked`, written at
 * T10's R4-S3 check from outside-box sessions only). The runner then renders the resume text itself.
 */

export const APPROVED_REQUESTS_FILE = 'approved-requests.json';
export const APPROVED_TTL_MS = 24 * 3_600_000;
export const APPROVED_MAX = 1000;

export interface ApprovedRequest {
  /** The R2 key of the approved body. */
  key: string;
  requestId: string;
  /** The approved `shift.start` body without its dispatch ids (the C2 comparison base). */
  body: Record<string, unknown>;
  at: string;
  /** The Claude session the approved outside-box run created (a resume must name exactly this one). */
  sessionId?: string;
  /** Commands this request's outside-box sessions asked for with `aom devops-approval` (checked against the guard). */
  asked: string[];
}

interface FileShape {
  entries: ApprovedRequest[];
}

export class ApprovedRequests {
  constructor(
    readonly file: string,
    /** The policy dir: where the seal key is. */
    readonly keyDir: string = policyDir(),
    private readonly warn: (m: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  static forRoot(
    root: string,
    keyDir?: string,
    warn?: (m: string) => void,
    now?: () => number,
  ): ApprovedRequests {
    return new ApprovedRequests(join(root, APPROVED_REQUESTS_FILE), keyDir, warn, now);
  }

  /** Live entries with a good seal; anything else reads as none. */
  entries(): ApprovedRequest[] {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return [];
    }
    const { check, body } = checkSeal(this.keyDir, raw);
    if (check !== 'ok') {
      if (check !== 'no_key') {
        this.warn(
          `${this.file} dropped: its seal is ${check === 'bad' ? 'wrong' : 'missing'} (changed outside the runner)`,
        );
        rmSync(this.file, { force: true });
      }
      return [];
    }
    const list = Array.isArray((body as unknown as FileShape | null)?.entries)
      ? (body as unknown as FileShape).entries
      : [];
    const cutoff = this.now() - APPROVED_TTL_MS;
    return list.filter(
      (e) =>
        e &&
        typeof e.key === 'string' &&
        typeof e.requestId === 'string' &&
        e.body &&
        typeof e.body === 'object' &&
        Array.isArray(e.asked) &&
        Date.parse(e.at) > cutoff,
    );
  }

  private write(entries: ApprovedRequest[]): void {
    assertNotAgentSession();
    const key = readPolicyKey(this.keyDir);
    // no key yet (before the policy was adopted): nothing is remembered, so nothing can be matched later either
    if (!key) return;
    const kept = entries.slice(-APPROVED_MAX);
    writeFileAtomic(this.file, `${JSON.stringify(seal(key, { entries: kept }))}\n`, 0o600);
  }

  /**
   * After a LOCAL approval of a held DevOps shift start: remember exactly that job. S3: deduped by (request, key), so
   * approving the same job under another request keeps the first request's entry (its session and asked commands).
   */
  record(requestId: string, body: unknown): ApprovedRequest {
    const e: ApprovedRequest = {
      key: r2Key(body),
      requestId,
      body: withoutDispatchIds(body),
      at: new Date(this.now()).toISOString(),
      asked: [],
    };
    this.write([...this.entries().filter((x) => !(x.key === e.key && x.requestId === requestId)), e]);
    return e;
  }

  /**
   * B1: a match under a new request id passed the runner's cross-request guard and runs outside. The new request gets
   * its own entry for its session and asked commands (C2): the rebound body (`bound`, the approved job with only the new
   * ids), the same key, the ORIGINAL approval time
   * (a match never extends the 24 hours), no session and no asked commands yet.
   */
  adopt(entry: ApprovedRequest, requestId: string, bound: unknown): void {
    if (entry.requestId === requestId) return;
    const all = this.entries();
    if (all.some((x) => x.key === entry.key && x.requestId === requestId)) return;
    // the rebound body (the approved job with the new request's ids): its C2 resumes compare against these ids
    const body = withoutDispatchIds(bound);
    this.write([...all, { key: entry.key, requestId, body, at: entry.at, asked: [] }]);
  }

  /** The entry an identical job matches (R2): the one of the same request first, otherwise the newest. */
  match(body: unknown): ApprovedRequest | undefined {
    const key = r2Key(body);
    const hits = this.entries().filter((e) => e.key === key);
    const requestId = (body as { devops?: { requestId?: unknown } } | null)?.devops?.requestId;
    return hits.find((e) => e.requestId === requestId) ?? hits.at(-1);
  }

  /** The entries of one request, newest last. */
  ofRequest(requestId: string): ApprovedRequest[] {
    return this.entries().filter((e) => e.requestId === requestId);
  }

  private change(requestId: string, key: string, fn: (e: ApprovedRequest) => ApprovedRequest): void {
    const all = this.entries();
    const i = all.findIndex((e) => e.requestId === requestId && e.key === key);
    if (i < 0) return;
    all[i] = fn(all[i] as ApprovedRequest);
    this.write(all);
  }

  /** The Claude session the approved outside-box run of this entry created. */
  noteSession(requestId: string, key: string, sessionId: string): void {
    this.change(requestId, key, (e) => ({ ...e, sessionId }));
  }

  /** Commands an outside-box session of this entry asked for (after the guard's R4-S3 check). */
  noteAsked(requestId: string, key: string, commands: string[]): void {
    this.change(requestId, key, (e) => ({
      ...e,
      asked: [...new Set([...e.asked, ...commands.map((c) => c.trim()).filter(Boolean)])].slice(-200),
    }));
  }

  /** Drops every entry of a request (it ended, or was refused). */
  drop(requestId: string): void {
    const all = this.entries();
    const left = all.filter((e) => e.requestId !== requestId);
    if (left.length !== all.length) this.write(left);
  }
}

// ---------------------------------------------------------------- C2: the resume of an approved job

export const C2_PREFIX = 'Approved once on the Desk:';

/** The resume text the runner renders itself: only the matched commands, never server text. */
export function renderedResume(commands: readonly string[]): string {
  return `${C2_PREFIX} ${commands.join('; ')}`;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

/** The body with the fields a resume may change taken out (S11's exact list). */
function resumeInvariant(body: Obj): Obj {
  const { resumeSessionId: _s, resumeMessage: _m, ...rest } = body;
  const devops = obj(rest.devops);
  const { approval: _a, history: _h, ...devopsRest } = devops;
  return { ...rest, ...(rest.devops !== undefined ? { devops: devopsRest } : {}) };
}

export type C2Result = { ok: true; body: Obj; commands: string[] } | { ok: false; reason: string };

/**
 * C2 (S11): may this `shift.start` run outside the box as the resume of the approved job `entry`? Compared with the
 * APPROVED body (so a chain of resumes stays bound to it), apart from the IDENTITY ids it may differ only in
 * `devops.approval`, appended `devops.history` entries (earlier ones unchanged), `resumeSessionId` (which must equal the
 * session the approved run created) and `resumeMessage`. Its `approval.commands` must be a non-empty subset of the
 * commands this request's outside-box sessions asked for. On success the runner's own rendering replaces
 * `resumeMessage`, the appended history text and the approval's free text: no server text from those fields reaches the
 * session.
 */
export function c2Resume(entry: ApprovedRequest, next: unknown): C2Result {
  // e2e-found-fixes C2: compared without the per-dispatch ids only (a resume has a new nested `brief.shift.id` too);
  // REVIEW B-1: the request, thread, card and project ids must stay the approved ones
  const n = withoutDispatchIdentity(next);
  const a = withoutDispatchIdentity(entry.body);
  if (canonicalJson(resumeInvariant(n)) !== canonicalJson(resumeInvariant(a)))
    return { ok: false, reason: 'the job changed beyond an approval resume' };
  const nd = obj(n.devops);
  const ad = obj(a.devops);
  const nh = Array.isArray(nd.history) ? (nd.history as unknown[]) : [];
  const ah = Array.isArray(ad.history) ? (ad.history as unknown[]) : [];
  if (nh.length < ah.length || ah.some((h, i) => canonicalJson(h) !== canonicalJson(nh[i])))
    return { ok: false, reason: 'the request history was changed, not appended to' };
  if (n.resumeSessionId !== undefined && (!entry.sessionId || n.resumeSessionId !== entry.sessionId))
    return { ok: false, reason: 'the resume names a session the approved run did not create' };
  const approval = obj(nd.approval);
  const commands = Array.isArray(approval.commands)
    ? (approval.commands as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  if (commands.length === 0) return { ok: false, reason: 'a resume without approved commands' };
  const asked = new Set(entry.asked.map((c) => c.trim()));
  const extra = commands.filter((c) => !asked.has(c.trim()));
  if (extra.length)
    return { ok: false, reason: `the approval lifts commands this session never asked for: ${extra[0]}` };
  const text = renderedResume(commands);
  const rendered: Obj = {
    ...obj(next),
    ...(n.resumeMessage !== undefined || n.resumeSessionId !== undefined ? { resumeMessage: text } : {}),
    devops: {
      // the new message's own devops (its request and thread ids); equal to the approved one outside the resume fields
      ...obj(obj(next).devops),
      approval: { action: 'approved on the Desk', reason: '', commands },
      // REVIEW S6: an appended entry carries no server text at all: the runner's own author, kind and text
      history: [
        ...ah,
        ...nh.slice(ah.length).map((h) => ({
          authorName: 'Guildwise',
          kind: 'system',
          body: text,
          at: typeof obj(h).at === 'string' ? (obj(h).at as string) : new Date(0).toISOString(),
        })),
      ],
    },
  };
  return { ok: true, body: rendered, commands };
}

import { z } from 'zod';
import { DeliverySetupSchema } from '../delivery/setup.ts';
import { RunPlanSchema } from '../runs/plan.ts';

/**
 * "Scan with DevOps" (docs/design/deploy-run-ux-design.md section 5). A scan is a read-only DevOps request that ends with a
 * structured proposal, submitted through `aom setup propose` and checked here. The proposal is data: the user reviews it
 * field by field and confirms before anything is saved. v1a fills `run`; v1b fills `deploy` for `deploy_scan` through the
 * same envelope, so the schema, the pointer rules and the review screen are shared.
 */

/** Announced in `hello.capabilities` by a runner whose `aom` has `setup propose` (and whose DevOps shifts honour a scan brief). */
export const SETUP_SCAN_CAPABILITY = 'setup-scan:1';

export const SetupAreaSchema = z.enum(['run', 'deploy']);
export type SetupArea = z.infer<typeof SetupAreaSchema>;

/** The DevOps request kind of each area. */
export const SCAN_REQUEST_KIND = { run: 'run_scan', deploy: 'deploy_scan' } as const;
export type ScanRequestKind = (typeof SCAN_REQUEST_KIND)[SetupArea];

export const ProposalConfidenceSchema = z.enum(['found', 'guessed', 'unknown']);
export type ProposalConfidence = z.infer<typeof ProposalConfidenceSchema>;

export const ProposalEvidenceSchema = z.object({
  file: z.string().max(300).optional(),
  line: z.number().int().min(1).max(10_000_000).optional(),
  probe: z.string().max(300).optional(),
});
export type ProposalEvidence = z.infer<typeof ProposalEvidenceSchema>;

/** One judgement about a part of the proposal: where it is (a JSON pointer into `run`/`deploy`), how sure DevOps is, why. */
export const ProposalItemSchema = z.object({
  path: z.string().max(300),
  confidence: ProposalConfidenceSchema,
  evidence: z.array(ProposalEvidenceSchema).max(10).default([]),
  note: z.string().max(500).optional(),
});
export type ProposalItem = z.infer<typeof ProposalItemSchema>;

/** A question only the user can answer ("Which port does the website use?"). */
export const ProposalQuestionSchema = z.object({
  path: z.string().max(300),
  question: z.string().min(1).max(300),
  options: z.array(z.string().max(100)).max(10).optional(),
  default: z.string().max(200).optional(),
  /** The control to show: free text, one of `options`, or yes/no ("confirm", answered `yes` or `no`). Default: `choice` with options, else `text`. */
  kind: z.enum(['text', 'choice', 'confirm']).optional(),
  /** May be left unanswered (the default is used). */
  optional: z.boolean().optional(),
  /** The stored answer (set by `POST /api/setup-proposals/:id/answers`, never by DevOps). */
  answer: z.string().max(500).optional(),
});
export type ProposalQuestion = z.infer<typeof ProposalQuestionSchema>;

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export const SetupProposalSchema = z
  .object({
    area: SetupAreaSchema,
    /** `area: run`: the whole proposed run plan. */
    run: RunPlanSchema.optional(),
    /** `area: deploy`: the proposed delivery setup (checked like any setup: strict values, plain-words shape problems). */
    deploy: DeliverySetupSchema.optional(),
    items: z.array(ProposalItemSchema).max(300).default([]),
    questions: z.array(ProposalQuestionSchema).max(30).default([]),
    secretsNeeded: z.array(z.string().regex(SECRET_NAME_RE)).max(30).default([]),
    /** What DevOps wants the user to know. Shown as text, never executed. */
    notes: z.string().max(4000).default(''),
    /** Files DevOps read, for the "DevOps read ..." line of the review. */
    filesRead: z.array(z.string().max(300)).max(60).default([]),
  })
  .superRefine((p, ctx) => {
    if (p.area === 'run' && !p.run)
      ctx.addIssue({
        code: 'custom',
        path: ['run'],
        message: 'a run proposal carries the proposed run plan',
      });
    if (p.area === 'deploy' && !p.deploy)
      ctx.addIssue({
        code: 'custom',
        path: ['deploy'],
        message: 'a deploy proposal carries the proposed setup',
      });
    const root: unknown = p.area === 'run' ? p.run : p.deploy;
    p.items.forEach((it, i) => {
      const where = ['items', i, 'path'];
      const r = checkPointer(root, it.path, it.confidence === 'unknown');
      if (r) ctx.addIssue({ code: 'custom', path: where, message: r });
    });
    p.questions.forEach((q, i) => {
      const r = checkPointer(root, q.path, true);
      if (r) ctx.addIssue({ code: 'custom', path: ['questions', i, 'path'], message: r });
    });
  });
export type SetupProposal = z.infer<typeof SetupProposalSchema>;

// ------------------------------------------------------------------------------------------------- JSON pointers

/** RFC 6901 tokens of a pointer, or null when it is not one. "" is the whole document. */
export function parsePointer(ptr: string): string[] | null {
  if (ptr === '') return [];
  if (!ptr.startsWith('/')) return null;
  const tokens = ptr
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  return tokens.some((t) => t === '__proto__' || t === 'constructor' || t === 'prototype') ? null : tokens;
}

/** The value a pointer names, or `undefined` (also for a pointer that is not valid). */
export function resolvePointer(root: unknown, ptr: string): unknown {
  const tokens = parsePointer(ptr);
  if (!tokens) return undefined;
  let cur: unknown = root;
  for (const t of tokens) {
    if (Array.isArray(cur)) cur = /^\d+$/.test(t) ? cur[Number(t)] : undefined;
    else if (cur && typeof cur === 'object' && Object.hasOwn(cur, t))
      cur = (cur as Record<string, unknown>)[t];
    else return undefined;
  }
  return cur;
}

/**
 * Why a pointer is unusable (null: fine). A pointer must be well formed and name something in the proposal; when the
 * item is "unknown" (or a question) the value itself may be missing, but its parent must exist.
 */
export function checkPointer(root: unknown, ptr: string, mayBeMissing: boolean): string | null {
  const tokens = parsePointer(ptr);
  if (!tokens) return `"${ptr}" is not a JSON pointer (for example /services/0/ports/0/default)`;
  if (resolvePointer(root, ptr) !== undefined) return null;
  if (mayBeMissing) {
    const parent = tokens.slice(0, -1);
    const parentPtr = parent.length ? `/${parent.map(escapeToken).join('/')}` : '';
    if (resolvePointer(root, parentPtr) !== undefined) return null;
  }
  return `"${ptr}" does not name anything in the proposal`;
}
const escapeToken = (t: string) => t.replace(/~/g, '~0').replace(/\//g, '~1');

/** Sets the value a pointer names (the parent must exist). Returns a copy; the input is not changed. */
export function setPointer<T>(root: T, ptr: string, value: unknown): T {
  const tokens = parsePointer(ptr);
  if (!tokens || tokens.length === 0) return root;
  const clone = structuredClone(root) as unknown;
  let cur = clone as Record<string, unknown> | unknown[];
  for (const t of tokens.slice(0, -1)) {
    const next = Array.isArray(cur) ? cur[Number(t)] : (cur as Record<string, unknown>)[t];
    if (!next || typeof next !== 'object') return root;
    cur = next as Record<string, unknown> | unknown[];
  }
  const last = tokens[tokens.length - 1] as string;
  if (Array.isArray(cur)) cur[Number(last)] = value;
  else (cur as Record<string, unknown>)[last] = value;
  return clone as T;
}

/** The confidence of the plan item (step or service) at `/setup/<i>` or `/services/<i>`: the weakest item under it. */
export function itemConfidence(
  proposal: Pick<SetupProposal, 'items'>,
  base: string,
): ProposalConfidence | null {
  const order: ProposalConfidence[] = ['found', 'guessed', 'unknown'];
  let worst = -1;
  for (const it of proposal.items) {
    if (it.path === base || it.path.startsWith(`${base}/`))
      worst = Math.max(worst, order.indexOf(it.confidence));
  }
  return worst < 0 ? null : (order[worst] as ProposalConfidence);
}

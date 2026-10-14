import { z } from 'zod';
import { type ExternalRef, parseExternalRef } from '../external/index.ts';

/**
 * Batch intake (#63): the owner hands the BA a list of tickets. Each ticket becomes one item and one `batch_intake` BA
 * task (a background shift, not a chat) that does what the BA does in an intake chat: read the ticket, map it to a
 * project, write the spec and create the cards. Contract shared by the server, the runner and the web.
 */

/** A batch holds at most this many tickets. */
export const BATCH_MAX_TICKETS = 50;
/** At most this many items of one batch are being worked on by a BA at once, so normal BA work still flows. */
export const BATCH_MAX_IN_FLIGHT = 2;
/** Desk `subkind` of the question the BA asks for one blocked ticket of a batch. */
export const BATCH_QUESTION_SUBKIND = 'batch_question';

export const BatchItemStatus = z.enum([
  'queued',
  'reading',
  'waiting',
  'done',
  'skipped',
  'failed',
  'cancelled',
]);
export type BatchItemStatus = z.infer<typeof BatchItemStatus>;
export const BatchStatus = z.enum(['running', 'done', 'cancelled']);
export type BatchStatus = z.infer<typeof BatchStatus>;

export interface ParsedBatchTickets {
  tickets: ExternalRef[];
  /** Entries that are no known ticket (Jira key or URL, GitHub issue reference or URL). */
  invalid: string[];
  /** Entries that repeated an earlier ticket. */
  duplicates: string[];
}

/** The canonical key of a ticket: Jira keys upper case, GitHub `owner/repo#n` as typed. */
export const canonicalTicketKey = (r: ExternalRef): string =>
  r.system === 'jira' ? r.key.toUpperCase() : r.key;

/**
 * One ticket per entry (keys or URLs; newlines and commas separate entries). An entry must be exactly one ticket: free
 * text that merely contains a key is invalid, so a stray sentence never becomes an item.
 */
export function parseBatchTickets(input: readonly string[]): ParsedBatchTickets {
  const tickets: ExternalRef[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.flatMap((l) => l.split(/[\n,]+/))) {
    const typed = raw.trim();
    if (!typed) continue;
    // Jira keys are typed in any case.
    const line = /^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/.test(typed) ? typed.toUpperCase() : typed;
    const ref = /^\S+$/.test(line) ? parseExternalRef(line) : null;
    const exact =
      ref && (ref.url === line || ref.key === (ref.system === 'jira' ? line.toUpperCase() : line));
    if (!ref || !exact) {
      invalid.push(line);
      continue;
    }
    const key = canonicalTicketKey(ref);
    if (seen.has(key.toLowerCase())) {
      duplicates.push(line);
      continue;
    }
    seen.add(key.toLowerCase());
    tickets.push({ ...ref, key });
  }
  return { tickets, invalid, duplicates };
}

// ---------------------------------------------------------------------------------------------- api

export const CreateBatchRequestSchema = z.object({
  /** Keys or URLs, one per entry. */
  tickets: z
    .array(z.string().min(1).max(500))
    .min(1)
    .max(BATCH_MAX_TICKETS * 4),
  /** Default project for every ticket; absent: the BA maps each ticket itself. */
  projectId: z.uuid().optional(),
  /** Applies to every ticket. */
  note: z.string().max(5000).optional(),
});
export type CreateBatchRequest = z.infer<typeof CreateBatchRequestSchema>;

export const BatchParamsSchema = z.object({ id: z.uuid() });
export const BatchItemParamsSchema = z.object({ id: z.uuid(), itemId: z.uuid() });

export const BatchItemDtoSchema = z.object({
  id: z.uuid(),
  position: z.number().int(),
  externalSystem: z.enum(['jira', 'github']),
  externalKey: z.string(),
  url: z.string().nullable(),
  status: BatchItemStatus,
  /** Why it was skipped or failed. */
  reason: z.string().nullable(),
  /** What the BA reported when it finished. */
  summary: z.string().nullable(),
  cards: z.array(
    z.object({ ref: z.string(), title: z.string().nullable(), projectKey: z.string().nullable() }),
  ),
  /** The desk question of a waiting item. */
  deskItemId: z.uuid().nullable(),
  question: z.string().nullable(),
  /** The intake (chat thread with the BA) that created the item's cards. */
  intakeId: z.uuid().nullable(),
  threadId: z.uuid().nullable(),
  attempts: z.number().int(),
});
export type BatchItemDto = z.infer<typeof BatchItemDtoSchema>;

export const BatchCountsSchema = z.object({
  queued: z.number().int(),
  reading: z.number().int(),
  waiting: z.number().int(),
  done: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
});
export type BatchCounts = z.infer<typeof BatchCountsSchema>;

export const BatchSummarySchema = z.object({
  id: z.uuid(),
  status: BatchStatus,
  projectKey: z.string().nullable(),
  note: z.string().nullable(),
  createdById: z.uuid(),
  createdByName: z.string().nullable(),
  total: z.number().int(),
  counts: BatchCountsSchema,
  createdAt: z.iso.datetime(),
  cancelledAt: z.iso.datetime().nullable(),
});
export type BatchSummaryDto = z.infer<typeof BatchSummarySchema>;
export const BatchDtoSchema = BatchSummarySchema.extend({ items: z.array(BatchItemDtoSchema) });
export type BatchDto = z.infer<typeof BatchDtoSchema>;

export const CreateBatchResponseSchema = z.object({ batch: BatchDtoSchema });
export const BatchResponseSchema = z.object({ batch: BatchDtoSchema });
export const BatchesResponseSchema = z.object({ batches: z.array(BatchSummarySchema) });

// -------------------------------------------------------------------------------- the BA task contract

export const BATCH_OUTCOME = {
  done: 'batch_done',
  ask: 'batch_ask',
  skip: 'batch_skip',
  fail: 'batch_fail',
} as const;

/** `aom batch ask`: what the BA needs from the owner before it can go on with this ticket. */
export const BatchAskDataSchema = z.object({
  question: z.string().min(1).max(4000),
  options: z.array(z.string().min(1).max(300)).max(12).default([]),
  recommend: z.number().int().min(0).optional(),
});
export type BatchAskData = z.infer<typeof BatchAskDataSchema>;

export const BatchTaskSchema = z.object({
  batchId: z.uuid(),
  itemId: z.uuid(),
  system: z.enum(['jira', 'github']),
  ticketKey: z.string(),
  ticketUrl: z.string().optional(),
  /** The project every ticket of the batch goes to; absent: map it. */
  projectKey: z.string().optional(),
  note: z.string().optional(),
  projects: z.array(z.object({ key: z.string(), name: z.string(), repos: z.array(z.string()).default([]) })),
  /** Cards an earlier run of this item already created. */
  cards: z.array(z.object({ ref: z.string(), title: z.string(), status: z.string() })).default([]),
  /** Questions asked for this ticket and the owner's answers, oldest first. */
  answers: z.array(z.object({ question: z.string(), answer: z.string().nullable() })).default([]),
});
export type BatchTask = z.infer<typeof BatchTaskSchema>;

export function batchBriefOutcomes() {
  const o = (id: string, label: string, kind: 'success' | 'failure', data: string) => ({
    id,
    label,
    kind,
    data,
  });
  return [
    o(BATCH_OUTCOME.done, 'The cards for this ticket are created and specified', 'success', 'batchDone'),
    o(BATCH_OUTCOME.ask, 'The owner must answer a question before you can go on', 'success', 'batchAsk'),
    o(BATCH_OUTCOME.skip, 'This ticket needs no card', 'success', 'batchSkip'),
    o(BATCH_OUTCOME.fail, 'This ticket cannot be turned into cards', 'failure', 'batchFail'),
  ];
}

/** Instructions of a `batch_intake` shift. `commandFor` gives the `aom` line of an outcome. */
export function renderBatchInstructions<O extends { id: string; label: string }>(
  brief: { agent: { name: string }; role: { instructions: string; coreRules: string[] } },
  outcomes: readonly O[],
  commandFor: (o: O) => string,
): string {
  const out: string[] = [];
  out.push('# Who you are');
  out.push(
    `You are ${brief.agent.name}, the business analyst (BA), working for the owner in the background on one ticket of a batch intake. Names are handles, not personas: do not roleplay.`,
  );
  out.push('# Role instructions');
  out.push(brief.role.instructions.trim());
  if (brief.role.coreRules.length > 0) {
    out.push('# Core rules');
    out.push(brief.role.coreRules.map((r) => `- ${r}`).join('\n'));
  }
  out.push('# Your job in this shift');
  out.push(
    [
      'Do exactly what you do in an intake chat for ONE ticket, without a conversation: read the ticket, map it to a project, write the spec and create the cards. Nobody is chatting with you; the owner only sees the cards you create and the questions you ask.',
      'Ask only when you truly cannot go on (the ticket is unclear, no project fits, the access you need is missing): use the ask outcome with ONE precise question. Your shift then ends; the owner answers on the desk and you are started again with the answer. Never guess a project and never invent ticket content.',
      'Work on this ticket only.',
    ].join('\n'),
  );
  out.push('# How to report');
  out.push(
    [
      'End the shift with exactly one terminal command:',
      ...outcomes.map((o) => `- ${o.id}: ${o.label}\n  \`${commandFor(o)}\``),
    ].join('\n'),
  );
  return `${out.join('\n\n')}\n`;
}

/** The prompt of a `batch_intake` shift. */
export function renderBatchPrompt(task: BatchTask): string {
  const out: string[] = [`# Batch intake: ${task.ticketKey}`];
  out.push(
    [
      `Ticket: ${task.ticketKey} (${task.system === 'github' ? 'GitHub issue' : 'Jira ticket'})${task.ticketUrl ? `, ${task.ticketUrl}` : ''}.`,
      task.projectKey
        ? `The owner chose project ${task.projectKey} for this batch: it is already mapped, do not map it again.`
        : 'No project was chosen: map the ticket to a project yourself (`aom intake map --project <KEY>`), or ask the owner when none fits.',
      ...(task.note ? ['', 'Note from the owner for every ticket of this batch:', task.note] : []),
    ].join('\n'),
  );
  out.push('## Projects you may map to');
  out.push(
    task.projects.length > 0
      ? task.projects
          .map((p) => `- ${p.key}: ${p.name}${p.repos.length ? `, repos: ${p.repos.join(', ')}` : ''}`)
          .join('\n')
      : 'None. Ask the owner.',
  );
  if (task.cards.length > 0) {
    out.push('## Cards already created for this ticket');
    out.push(task.cards.map((c) => `- ${c.ref} ${c.title} (${c.status})`).join('\n'));
  }
  if (task.answers.length > 0) {
    out.push('## Questions you asked and the owner answers');
    out.push(
      task.answers.map((a) => `- Q: ${a.question}\n  A: ${a.answer ?? '(not answered yet)'}`).join('\n'),
    );
  }
  out.push('## Steps');
  out.push(
    [
      `1. Read the ticket: \`aom source read --ref ${task.ticketKey}\`${task.system === 'jira' ? `; attachments with \`aom source attachments ${task.ticketKey}\` and \`aom source attachment ${task.ticketKey} --all\` (open screenshots with the Read tool)` : ''}.`,
      '2. Map it to a project (skip when one is set above). `aom ledger search` shows earlier decisions.',
      '3. Investigate with PROJECT.md, the vault, the ledger and the ticket. Do not read source code: put code questions into the card and set designNeeded (or investigationOnly) so the Architect investigates. Never set completionAction.',
      `4. Draft one card per independently deliverable change with every field a builder needs (\`aom card create --json '<draft>'\`, externalRef ${task.ticketKey}), then \`aom card specify <REF>\` for each complete card. Attach downloaded files with \`aom card attach <path> --card <REF>\`.`,
      '5. Report with the terminal command: done (name what you created), ask (one question), skip or fail.',
      '',
      'This is read-only towards external systems: never post, comment on or transition a ticket.',
    ].join('\n'),
  );
  return `${out.join('\n\n')}\n`;
}

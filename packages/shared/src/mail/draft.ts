import { z } from 'zod';
import { renderUntrusted } from '../prompt/untrusted.ts';

/**
 * "Draft with BA" for e-mail replies (#15 leftover, #67 D). A person asks for a draft on a conversation; the server queues a
 * `mail_reply_draft` BA task (a background shift, no card, no worktree) and the BA writes the reply from the thread and the
 * card. The draft is stored for the person to review in the reply box and send: it is never sent by itself. Contract shared by
 * the server, the runner and the web.
 */

export const MAIL_DRAFT_OUTCOME = { done: 'mail_draft_done', fail: 'mail_draft_fail' } as const;

/** Longest draft the BA may deliver (the same limit as a reply). */
export const MAIL_DRAFT_MAX_CHARS = 20_000;

/** A draft older than this is no longer offered. */
export const MAIL_DRAFT_TTL_HOURS = 24;

/** `aom report mail-draft`: the draft the BA wrote. */
export const MailDraftDataSchema = z.object({
  text: z.string().trim().min(1).max(MAIL_DRAFT_MAX_CHARS),
  subject: z.string().trim().min(1).max(300).optional(),
});
export type MailDraftData = z.infer<typeof MailDraftDataSchema>;

/** What the BA is given for one draft. */
export const MailDraftTaskSchema = z.object({
  draftId: z.uuid(),
  /** The organisation the reply is written for, and the person who will review and send it. */
  orgName: z.string(),
  senderName: z.string(),
  /** Who the reply goes to. */
  to: z.string(),
  subject: z.string(),
  /** The conversation, oldest first (the latest messages when it is long). */
  messages: z.array(
    z.object({
      direction: z.enum(['in', 'out']),
      from: z.string(),
      fromName: z.string().nullable(),
      at: z.string(),
      text: z.string(),
    }),
  ),
  /** The card the conversation made, when there is one. `text` comes from the mail, so it is untrusted. */
  card: z
    .object({
      ref: z.string(),
      title: z.string(),
      status: z.string(),
      stage: z.string().nullable(),
      text: z.string(),
    })
    .optional(),
});
export type MailDraftTask = z.infer<typeof MailDraftTaskSchema>;

export function mailDraftBriefOutcomes() {
  return [
    {
      id: MAIL_DRAFT_OUTCOME.done,
      label: 'The reply draft is written',
      kind: 'success' as const,
      data: 'mailDraft',
    },
    {
      id: MAIL_DRAFT_OUTCOME.fail,
      label: 'No reply can be written from this conversation',
      kind: 'failure' as const,
      data: 'mailDraftFail',
    },
  ];
}

/** Instructions of a `mail_reply_draft` shift. `commandFor` gives the `aom` line of an outcome. */
export function renderMailDraftInstructions<O extends { id: string; label: string }>(
  brief: { agent: { name: string }; role: { instructions: string; coreRules: string[] } },
  task: MailDraftTask,
  outcomes: readonly O[],
  commandFor: (o: O) => string,
): string {
  const out: string[] = [];
  out.push('# Who you are');
  out.push(
    `You are ${brief.agent.name}, the business analyst (BA), working in the background for ${task.senderName} at ${task.orgName}. Names are handles, not personas: do not roleplay.`,
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
      `Write a draft of the e-mail reply to the conversation in the prompt. ${task.senderName} will read it, change it and send it: nothing is sent by itself, and you do not talk to the customer.`,
      '',
      `- Write as ${task.orgName}'s own person, in the first person ("I" or "we"), in plain professional e-mail text: a greeting, the answer, what happens next, a closing with ${task.senderName.split(/\s+/)[0] ?? task.senderName}'s first name. No markdown, no headings, no bullet symbols other than plain hyphens, no subject line inside the text.`,
      '- Never mention agents, AI, assistants, language models, automation, bots, Guildwise or this drafting step. The customer must not be able to tell the reply was drafted by anything but the team. The platform refuses a reply that does.',
      '- Answer what was asked, in the language of the latest message. Keep it as short as it can be and still be useful.',
      '- Do not invent facts, prices, dates, refunds or promises. Use only what the conversation and the card say. Where you cannot know something, write a short honest sentence (you will check and come back) or leave a clear gap in square brackets for the person to fill, such as [delivery date].',
      '- Do not read repositories or run anything: you are read-only and the conversation is all you need.',
    ].join('\n'),
  );
  out.push('# How to report');
  out.push(
    [
      'Write the draft in a file in your scratch directory, then end the shift with exactly one terminal command:',
      ...outcomes.map((o) => `- ${o.id}: ${o.label}\n  \`${commandFor(o)}\``),
    ].join('\n'),
  );
  return `${out.join('\n\n')}\n`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[cut]` : s);

/** The prompt of a `mail_reply_draft` shift: the conversation (outside content is fenced) and the card. */
export function renderMailDraftPrompt(task: MailDraftTask): string {
  const out: string[] = [`# Draft a reply: ${task.subject}`];
  out.push(`The reply goes to ${task.to}. It is sent by ${task.senderName} for ${task.orgName}.`);
  out.push('## The conversation, oldest first');
  out.push(
    task.messages.length
      ? task.messages
          .map((m) => {
            const who = m.fromName ? `${m.fromName} <${m.from}>` : m.from;
            return m.direction === 'in'
              ? renderUntrusted(`E-mail from ${who}, ${m.at}`, clip(m.text, 4000))
              : `Our reply, sent by ${m.fromName ?? m.from} (${m.at}):\n${clip(m.text, 4000)}`;
          })
          .join('\n\n')
      : 'No messages.',
  );
  if (task.card) {
    out.push('## The card this conversation made');
    out.push(
      [
        `${task.card.ref} (${task.card.status}${task.card.stage ? `, ${task.card.stage}` : ''}); its title and text come from the e-mail:`,
        renderUntrusted(
          `Card ${task.card.ref}, taken from the e-mail`,
          clip(`${task.card.title}\n\n${task.card.text}`, 3000),
        ),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  out.push('## Steps');
  out.push(
    [
      '1. Read the conversation and decide what the person needs to hear.',
      `2. Write the reply to a file (\`reply.txt\` in your scratch directory).`,
      '3. Report it with the terminal command (a different subject is optional: the default is "Re: <subject>").',
    ].join('\n'),
  );
  return `${out.join('\n\n')}\n`;
}

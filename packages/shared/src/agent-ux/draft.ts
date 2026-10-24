import { z } from 'zod';
import { permissionsForPersona, personaToolSet } from '../capabilities/authoring.ts';
import { PersonaFrontmatterSchema, splitFrontmatter } from '../capabilities/parse.ts';
import { slugify } from '../ids.ts';
import type { AgentPermissions } from '../roles/schema.ts';

/**
 * Describe-an-agent quick hire (S-B2). One sentence from the hirer becomes a drafted role: a name, instructions, a tool profile,
 * a suggested model and suggested skills and playbooks. An agent turn writes the draft as one JSON object; this module reads it
 * leniently, and the server clamps it to the hirer's authority. A draft is never hired by itself: the hirer reviews and edits it,
 * then goes through the normal hire dialog.
 */

export const DRAFT_MODELS = ['haiku', 'sonnet', 'opus'] as const;

export const AgentDraftSchema = z.object({
  name: z.string().trim().min(1).max(60),
  purpose: z.string().trim().min(1).max(300),
  instructions: z.string().trim().min(20).max(8000),
  /** What the draft asks to be allowed to do. The server grants no more than the hirer may. */
  tools: z
    .array(z.enum(['read', 'edit', 'shell', 'web']))
    .max(4)
    .default(['read']),
  /** `haiku` (quick and cheap), `sonnet` (the default) or `opus` (hard problems). */
  model: z.enum(DRAFT_MODELS).default('sonnet'),
  /** Skill keys of the registry. Unknown keys are dropped by the server. */
  skills: z.array(z.string().max(130)).max(10).default([]),
  /** Playbook keys of the registry the agent may start. Unknown keys are dropped by the server. */
  playbooks: z.array(z.string().max(130)).max(5).default([]),
});
export type AgentDraft = z.infer<typeof AgentDraftSchema>;

/** A draft after the server clamped it: what the hirer sees in the review step. */
export const AgentDraftDtoSchema = AgentDraftSchema.extend({
  /** The permissions the agent will get: the draft's tools, no wider than the hirer may grant. */
  permissions: z.custom<AgentPermissions>(),
  /** What the draft asked for that the hirer cannot grant, in words. */
  withheld: z.array(z.string()),
});
export type AgentDraftDto = z.infer<typeof AgentDraftDtoSchema>;

export function agentDraftPrompt(i: {
  description: string;
  skills: readonly string[];
  playbooks: readonly string[];
}): string {
  return [
    'Draft a role for a new AI agent that a person is about to hire. Do not ask questions and do not use tools: reply with one JSON object and nothing else.',
    '',
    `What they asked for: ${i.description.trim().slice(0, 600)}`,
    '',
    'The object has these fields:',
    '- "name": a short first name for the agent (one or two words).',
    '- "purpose": one sentence, what this agent is for.',
    '- "instructions": the agent\'s standing instructions in second person: its job, how it works, what it never does, how it reports. 80 to 250 words.',
    '- "tools": the least it needs, from "read", "edit", "shell", "web". Most agents only need "read". Ask for "edit" or "shell" only when the job cannot be done without them.',
    '- "model": "haiku" for quick routine work, "sonnet" for most work, "opus" only for hard reasoning.',
    `- "skills": up to 3 keys chosen from this list, or an empty list: ${i.skills.slice(0, 40).join(', ') || '(none)'}.`,
    `- "playbooks": up to 2 keys chosen from this list, or an empty list: ${i.playbooks.slice(0, 40).join(', ') || '(none)'}.`,
    '',
    'Reply with the JSON object only.',
  ].join('\n');
}

/** The first top-level JSON object in a reply (a fenced block, or text around it). */
function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const hay = fenced ? (fenced[1] as string) : text;
  const start = hay.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < hay.length; i++) {
    const ch = hay[i] as string;
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return hay.slice(start, i + 1);
  }
  return null;
}

export type ParsedDraft = { ok: true; draft: AgentDraft } | { ok: false; error: string };

/** Reads the agent's reply. Unknown tools and models are dropped or defaulted; what is missing is named in the error. */
export function parseAgentDraft(reply: string): ParsedDraft {
  const raw = extractJsonObject(reply);
  if (!raw) return { ok: false, error: 'the reply held no draft' };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'the draft was not valid JSON' };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'the draft was not an object' };
  const o = obj as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()) : [];
  const model = typeof o.model === 'string' ? o.model.toLowerCase().trim() : '';
  const r = AgentDraftSchema.safeParse({
    name: o.name,
    purpose: o.purpose,
    instructions: o.instructions,
    tools: personaToolSet(list(o.tools)),
    model: (DRAFT_MODELS as readonly string[]).includes(model) ? model : 'sonnet',
    skills: list(o.skills).slice(0, 10),
    playbooks: list(o.playbooks).slice(0, 5),
  });
  if (!r.success) {
    const f = r.error.issues[0];
    return { ok: false, error: `the draft is missing ${String(f?.path[0] ?? 'a field')}` };
  }
  return { ok: true, draft: r.data };
}

/** The draft with the authority clamp applied: the tools the hirer may grant, and what was withheld. */
export function clampDraft(
  draft: AgentDraft,
  hirer: { mayWiden: boolean },
): { tools: AgentDraft['tools']; permissions: AgentPermissions; withheld: string[] } {
  const p = permissionsForPersona(draft.tools, hirer);
  return {
    tools: p.permissions.allowedTools.filter((t): t is AgentDraft['tools'][number] =>
      ['read', 'edit', 'shell', 'web'].includes(t),
    ),
    permissions: p.permissions,
    withheld: p.withheld,
  };
}

/** A role key for a drafted agent: `draft-<name>-<12 chars>`; the suffix keeps two drafts of one name apart. */
export function draftRoleKey(name: string, nonce: string): string {
  const base = slugify(name, 30) || 'agent';
  return `draft-${base}-${nonce
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 12)
    .toLowerCase()}`;
}

/** A starter persona (a built-in persona file) as a draft the hirer can review. */
export function draftFromPersonaText(text: string): AgentDraft | null {
  const { data, body } = splitFrontmatter(text);
  const fm = PersonaFrontmatterSchema.safeParse(data);
  if (!fm.success) return null;
  const f = fm.data;
  const model = (DRAFT_MODELS as readonly string[]).includes(f.model ?? '')
    ? (f.model as AgentDraft['model'])
    : 'sonnet';
  const instructions = [
    `You are ${f.name}. ${f.description}`,
    `Stance: ${f.stance}`,
    `Voice: ${f.voice}`,
    body.trim(),
  ].join('\n\n');
  const r = AgentDraftSchema.safeParse({
    name: f.name,
    purpose: f.description.slice(0, 300),
    instructions: instructions.slice(0, 8000),
    tools: personaToolSet(f.tools),
    model,
    skills: (f.skills ?? []).slice(0, 10),
    playbooks: [],
  });
  return r.success ? r.data : null;
}

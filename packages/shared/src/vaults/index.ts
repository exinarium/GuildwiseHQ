import { z } from 'zod';
import { VaultKind } from '../events/vault.ts';
import { slugify } from '../ids.ts';

/** `vault.configure`: the full set of vaults one workstation syncs (replace semantics) plus resume requests. */
export const VaultConfigSchema = z.object({
  vaultId: z.string().min(1),
  kind: VaultKind,
  projectId: z.string().optional(),
  name: z.string(),
  remoteUrl: z.string().min(1),
  syncIntervalSec: z.number().int().min(1).max(86_400),
});
export type VaultConfig = z.infer<typeof VaultConfigSchema>;

export const VaultConfigureCommandSchema = z.object({
  vaults: z.array(VaultConfigSchema),
  /** Git identity for sync commits: the workstation's DevOps engineer. */
  identity: z.object({ name: z.string(), email: z.string() }),
  workstationName: z.string().default('workstation'),
  /** Vault ids whose paused (conflicted) sync should be retried now. */
  resume: z.array(z.string()).default([]),
});
export type VaultConfigureCommand = z.infer<typeof VaultConfigureCommandSchema>;

/** `vault.write` (docs/ARCHITECTURE.md section 16.4). Idempotent: identical content is success. */
export const VaultWriteCommandSchema = z.object({
  vaultId: z.string().min(1),
  /** Vault-relative, forward slashes, no `..`. */
  path: z.string().min(1),
  mode: z.enum(['create', 'append', 'replace']),
  content: z.string(),
  commitMessage: z.string().min(1),
  /** `append` only: written first when the file does not exist yet (e.g. a title for `taste.md`). */
  header: z.string().optional(),
  /** Push right after committing (default); otherwise the next sync pushes. */
  push: z.boolean().default(true),
});
export type VaultWriteCommand = z.infer<typeof VaultWriteCommandSchema>;

/** Rejects absolute paths, `..` segments and anything inside `.git`. */
export function isSafeVaultPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || /^[a-zA-Z]:/.test(path)) return false;
  const parts = path.split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..' && p.toLowerCase() !== '.git');
}

/** `projects/<folder>`: `projects.vault_folder` or the lowercase project key. */
export function projectVaultFolder(project: { key: string; vaultFolder?: string | null }): string {
  const raw = (project.vaultFolder?.trim() || project.key.toLowerCase()).replace(/^\/+|\/+$/g, '');
  return raw.startsWith('projects/') ? raw : `projects/${raw}`;
}

export interface DecisionFileInput {
  /** Desk item id (kept short in the file name so two answers on one day with one slug never collide). */
  deskItemId: string;
  question: string;
  answer: string;
  answerOptionLabel?: string;
  askedBy: string;
  cardRef?: string;
  ledgerEntryId?: string;
  answeredAt: Date;
  answeredBy?: string;
}

/** `projects/<folder>/decisions/<YYYY-MM-DD>-<slug>.md` (ADR style, docs/ARCHITECTURE.md section 16.4). */
export function decisionFilePath(folder: string, d: DecisionFileInput): string {
  const day = d.answeredAt.toISOString().slice(0, 10);
  const slug = slugify(d.question, 48) || 'decision';
  return `${folder}/decisions/${day}-${slug}-${d.deskItemId.replace(/-/g, '').slice(0, 6)}.md`;
}

export function renderDecisionFile(d: DecisionFileInput): string {
  const title = d.question.replace(/\s+/g, ' ').trim().slice(0, 120);
  const lines = [
    `# ${title}`,
    '',
    'Status: accepted',
    '',
    '## Context',
    '',
    d.question.trim(),
    '',
    `Asked by ${d.askedBy}${d.cardRef ? ` on card ${d.cardRef}` : ''}.`,
    '',
    '## Decision',
    '',
    d.answerOptionLabel ? `${d.answerOptionLabel}: ${d.answer.trim()}` : d.answer.trim(),
    '',
    '## Consequences',
    '',
    `Recorded ${d.answeredAt.toISOString().slice(0, 10)}${d.answeredBy ? ` by ${d.answeredBy}` : ''}. Agents see this decision through the requirements ledger.`,
    '',
    `Ledger entry: ${d.ledgerEntryId ?? 'n/a'}`,
    '',
  ];
  return lines.join('\n');
}

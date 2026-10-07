import { z } from 'zod';
import { VaultEventKind } from '../events/vault.ts';
import { slugify } from '../ids.ts';

/** `vault.configure`: the full set of vaults one workstation syncs (replace semantics) plus resume requests. */
/** Vault ids name a directory on the runner: plain ids only. */
export const VaultIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'invalid vault id');

export const VaultConfigSchema = z.object({
  vaultId: VaultIdSchema,
  /** The wire accepts the kinds of before the split was dropped too (a runner's persisted configuration may hold one). */
  kind: VaultEventKind,
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
export const VaultWriteCommandSchema = z
  .object({
    vaultId: VaultIdSchema,
    /** Vault-relative, forward slashes, no `..`. */
    path: z.string().min(1),
    /** `section`: a site-managed block between markers (see `applyManagedSection`), replaced when `section.version` is newer. */
    mode: z.enum(['create', 'append', 'replace', 'section']),
    content: z.string(),
    commitMessage: z.string().min(1),
    /** `append` and `section`: written first when the file does not exist yet (e.g. a title for `taste.md`). */
    header: z.string().optional(),
    /** `section` only: which managed block, and its version (a write with an older or equal version is a no-op). */
    section: z
      .object({ id: z.string().regex(/^[a-z-]+$/), version: z.number().int().nonnegative() })
      .optional(),
    /** Push right after committing (default); otherwise the next sync pushes. */
    push: z.boolean().default(true),
  })
  .refine((c) => c.mode !== 'section' || c.section !== undefined, {
    message: 'section mode needs a section id and version',
    path: ['section'],
  });
export type VaultWriteCommand = z.infer<typeof VaultWriteCommandSchema>;

/**
 * `vault.move` (the restructure migration, docs/design/restructure.md owner decision 6): moves a folder of the vault with
 * the history kept (a rename, one commit, pushed). Idempotent and safe to repeat after an interruption: a folder that is
 * already moved is success, and files that exist at both places are merged without overwriting anything.
 */
export const VaultMoveCommandSchema = z.object({
  vaultId: VaultIdSchema,
  /** Vault-relative folders, forward slashes, no `..`. */
  from: z.string().min(1),
  to: z.string().min(1),
  commitMessage: z.string().min(1),
  push: z.boolean().default(true),
});
export type VaultMoveCommand = z.infer<typeof VaultMoveCommandSchema>;

/**
 * `vault.merge` (the "drop personal" data migration): copies the files of another vault into this one under the folder
 * `into` (`personal`), except the `lift` folders, which keep their own path (a personal interest's `interests/<slug>`
 * lands where every interest lives). The runner clones the source from `from.remoteUrl` itself: the source is no
 * longer a registered vault. Nothing is overwritten (identical files are skipped, differing ones are reported) and the
 * source is never changed, so the command is idempotent, safe to repeat after an interruption, and leaves the old
 * repository as a backup.
 */
export const VaultMergeCommandSchema = z.object({
  /** The vault that receives the files (the organization vault). */
  vaultId: VaultIdSchema,
  from: z.object({ vaultId: VaultIdSchema, remoteUrl: z.string().min(1) }),
  /** Vault-relative folder of the target the source goes into. */
  into: z.string().min(1),
  /** Folders of the source (e.g. `interests/ainews`) that go to the same path in the target, not under `into`. */
  lift: z.array(z.string().min(1)).max(500).default([]),
  commitMessage: z.string().min(1),
  push: z.boolean().default(true),
});
export type VaultMergeCommand = z.infer<typeof VaultMergeCommandSchema>;

/** Rejects absolute paths, `..` segments and anything inside `.git`. */
export function isSafeVaultPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || /^[a-zA-Z]:/.test(path)) return false;
  const parts = path.split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..' && p.toLowerCase() !== '.git');
}

/** `projects/<folder>`: `projects.vault_folder` or the lowercase project key. */
export function projectVaultFolder(project: {
  key: string;
  vaultFolder?: string | null;
  /** `projects.vault_dir`: the full folder of a backing project (`interests/<slug>`); wins over the other two. */
  vaultDir?: string | null;
}): string {
  const dir = project.vaultDir?.trim().replace(/^\/+|\/+$/g, '');
  if (dir) return dir;
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

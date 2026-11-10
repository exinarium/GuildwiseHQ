import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface JournalEntry {
  submissionId: string;
  connectionId: string;
  path: string;
  providerId?: string;
  writtenAt: number;
}

/** Entries older than this are dropped: the longest submission lifetime is 24 hours. */
export const JOURNAL_KEEP_MS = 25 * 60 * 60 * 1000;

/**
 * What this workstation wrote for each public form submission, so one rejected file can take the whole submission
 * back. The file holds storage paths the firm already owns, never file content. Mode 0600, written atomically.
 */
export class SubmissionJournal {
  private entries: JournalEntry[] = [];

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { entries?: JournalEntry[] };
      if (Array.isArray(raw.entries))
        this.entries = raw.entries.filter(
          (e) =>
            typeof e?.submissionId === 'string' &&
            typeof e.connectionId === 'string' &&
            typeof e.path === 'string',
        );
    } catch {
      // no journal yet, or unreadable: start empty
    }
    this.prune();
  }

  add(e: Omit<JournalEntry, 'writtenAt'>): void {
    this.entries.push({ ...e, writtenAt: this.now() });
    this.prune();
    this.save();
  }

  list(submissionId: string): JournalEntry[] {
    return this.entries.filter((e) => e.submissionId === submissionId);
  }

  /** Drops the entries of a submission (after they were deleted from the destination). */
  drop(submissionId: string, only?: JournalEntry): void {
    this.entries = this.entries.filter(
      (e) => e.submissionId !== submissionId || (only !== undefined && e !== only),
    );
    this.save();
  }

  size(): number {
    return this.entries.length;
  }

  private prune(): void {
    const cut = this.now() - JOURNAL_KEEP_MS;
    this.entries = this.entries.filter((e) => e.writtenAt > cut);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ entries: this.entries }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // the in-memory list still serves this run
    }
  }
}

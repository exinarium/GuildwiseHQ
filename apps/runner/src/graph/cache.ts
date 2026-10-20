import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256Hex } from '@aom/shared';
import type { FileFacts } from './types.ts';

/**
 * Per-file facts keyed by the blob id and the parser fingerprint (docs/design/project-graphs.md section 12, idea 4): a file
 * is parsed once per content and per grammar/extractor version. Runner-local, rebuildable, never synced.
 */
export class FactsCache {
  private entries = new Map<string, FileFacts>();
  private used = new Set<string>();
  private readonly file: string;
  hits = 0;
  misses = 0;

  constructor(
    cacheDir: string,
    repoKey: string,
    private readonly fingerprint: string,
  ) {
    this.file = join(cacheDir, repoKey, `facts-${sha256Hex(fingerprint).slice(0, 12)}.json`);
    try {
      if (existsSync(this.file)) {
        const j = JSON.parse(readFileSync(this.file, 'utf8')) as {
          fingerprint?: string;
          entries?: Record<string, FileFacts>;
        };
        if (j.fingerprint === fingerprint) this.entries = new Map(Object.entries(j.entries ?? {}));
      }
    } catch {
      this.entries = new Map(); // an unreadable cache is only a cache
    }
  }

  get(blob: string): FileFacts | undefined {
    const f = this.entries.get(blob);
    if (f) {
      this.hits++;
      this.used.add(blob);
    } else this.misses++;
    return f;
  }

  set(blob: string, facts: FileFacts): void {
    this.entries.set(blob, facts);
    this.used.add(blob);
  }

  /** Writes the entries this run used (the cache never outgrows the repository). */
  save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const entries: Record<string, FileFacts> = {};
      for (const k of [...this.used].sort()) entries[k] = this.entries.get(k) as FileFacts;
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ fingerprint: this.fingerprint, entries }));
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // a cache that cannot be written costs time, not correctness
    }
  }
}

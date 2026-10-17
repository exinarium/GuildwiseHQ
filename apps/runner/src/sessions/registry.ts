import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ResumeState } from '@aom/shared';

/**
 * Claude Code sessions this runner started, so a later shift of the same agent can resume one (`claude --resume`) and the
 * runner can refuse when that would be a bad idea (Lean Team v3, section 6.1): the session is over 120K context tokens or
 * over 4 hours old, it belongs to another agent, or it is not known here (a session lives in one agent's config dir on
 * one workstation). The registry is a small JSON file; losing it only means a resume request starts fresh.
 */

export const RESUME_MAX_CONTEXT_TOKENS = 120_000;
export const RESUME_MAX_AGE_MS = 4 * 60 * 60_000;
const KEEP_MS = 7 * 24 * 60 * 60_000;

export interface SessionRecord {
  sessionId: string;
  agentId: string;
  /** The directory the session ran in (Claude Code keeps its transcript under this directory's project folder). */
  cwd: string;
  /** When the session first started (a resumed session keeps the first start: the age limit counts from it). */
  startedAt: string;
  updatedAt: string;
  contextTokens: number;
}

export interface ResumeDecision {
  state: ResumeState;
  detail?: string;
}

/** Claude Code's folder name for a working directory: every character that is not a letter or digit becomes `-`. */
export const projectDirName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/** `<config dir>/projects/<project dir name>/<session id>.jsonl` */
export const transcriptFile = (configDir: string, cwd: string, sessionId: string): string =>
  join(configDir, 'projects', projectDirName(cwd), `${sessionId}.jsonl`);

export class SessionRegistry {
  private records = new Map<string, SessionRecord>();
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { sessions?: SessionRecord[] };
      for (const r of raw.sessions ?? []) if (r?.sessionId) this.records.set(r.sessionId, r);
    } catch {
      // missing or unreadable: start empty
    }
  }

  private save(): void {
    const cutoff = this.now() - KEEP_MS;
    for (const [id, r] of this.records) if (Date.parse(r.updatedAt) < cutoff) this.records.delete(id);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ sessions: [...this.records.values()] }), {
        mode: 0o600,
      });
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // best effort: a resume request then starts fresh
    }
  }

  get(sessionId: string): SessionRecord | undefined {
    this.load();
    return this.records.get(sessionId);
  }

  /**
   * Notes a session: new, or the one a shift resumed. `startedAt` of an existing record stays; a resumed session that
   * Claude Code gave a new id inherits `inheritFrom`'s start so the 4 hour limit keeps counting from the first shift.
   */
  record(r: {
    sessionId: string;
    agentId: string;
    cwd: string;
    contextTokens?: number;
    inheritFrom?: string;
  }): void {
    this.load();
    const nowIso = new Date(this.now()).toISOString();
    const prior =
      this.records.get(r.sessionId) ?? (r.inheritFrom ? this.records.get(r.inheritFrom) : undefined);
    this.records.set(r.sessionId, {
      sessionId: r.sessionId,
      agentId: r.agentId,
      cwd: r.cwd,
      startedAt: prior?.startedAt ?? nowIso,
      updatedAt: nowIso,
      contextTokens: r.contextTokens ?? prior?.contextTokens ?? 0,
    });
    this.save();
  }

  updateContext(sessionId: string, contextTokens: number): void {
    this.load();
    const r = this.records.get(sessionId);
    if (!r || r.contextTokens === contextTokens) return;
    this.records.set(sessionId, { ...r, contextTokens, updatedAt: new Date(this.now()).toISOString() });
    this.save();
  }

  /** May this agent resume this session? Says why not (and which limit) otherwise. */
  decide(sessionId: string, agentId: string, configDir: string): ResumeDecision {
    const r = this.get(sessionId);
    if (!r)
      return { state: 'fresh_unknown_session', detail: 'this workstation has no record of that session' };
    if (r.agentId !== agentId)
      return {
        state: 'fresh_other_agent',
        detail: 'the session belongs to another agent: sessions are per agent',
      };
    if (r.contextTokens > RESUME_MAX_CONTEXT_TOKENS)
      return {
        state: 'fresh_too_large',
        detail: `the session holds ${Math.round(r.contextTokens / 1000)}K context tokens (limit ${RESUME_MAX_CONTEXT_TOKENS / 1000}K)`,
      };
    const ageMs = this.now() - Date.parse(r.startedAt);
    if (ageMs > RESUME_MAX_AGE_MS)
      return {
        state: 'fresh_too_old',
        detail: `the session is ${(ageMs / 3_600_000).toFixed(1)} hours old (limit ${RESUME_MAX_AGE_MS / 3_600_000})`,
      };
    if (
      !existsSync(transcriptFile(configDir, r.cwd, sessionId)) &&
      !findTranscriptAnywhere(configDir, sessionId)
    )
      return {
        state: 'fresh_transcript_missing',
        detail: 'the session transcript is gone from the agent config folder',
      };
    return { state: 'resumed' };
  }
}

/** The transcript of a session in any project folder of the config dir (`projects/*\/<id>.jsonl`), if there is one. */
export function findTranscriptAnywhere(configDir: string, sessionId: string): string | undefined {
  try {
    const projects = join(configDir, 'projects');
    for (const d of readdirSync(projects)) {
      const f = join(projects, d, `${sessionId}.jsonl`);
      if (existsSync(f)) return f;
    }
  } catch {
    // no projects folder yet
  }
  return undefined;
}

/**
 * A resumed session starts in another directory than the one it was recorded in (a builder moving across the per-card
 * worktrees of a group): copies its transcript into the new directory's project folder so `claude --resume` finds it
 * there. Claude Code 2.1.302 also finds a session in another project folder of the same config dir (spike, 2026-10-17),
 * so this is the belt to that suspender: it costs one file copy and never overwrites. Returns what happened.
 */
export function copySessionTranscript(
  configDir: string,
  sessionId: string,
  toCwd: string,
  fromCwd?: string,
): 'present' | 'copied' | 'missing' {
  const dest = transcriptFile(configDir, toCwd, sessionId);
  if (existsSync(dest)) return 'present';
  const src =
    (fromCwd && existsSync(transcriptFile(configDir, fromCwd, sessionId))
      ? transcriptFile(configDir, fromCwd, sessionId)
      : undefined) ?? findTranscriptAnywhere(configDir, sessionId);
  if (!src) return 'missing';
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return 'copied';
}

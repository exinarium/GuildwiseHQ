import { z } from 'zod';

/**
 * Diagnostics for the CEO's full-power owner turns (docs/investigations/ceo-full-power.md): the runner's and the
 * workstation's logs and status, and the server's own logs. Read-only, secrets masked on the machine that holds the
 * text and again on the server, and only ever offered to an owner turn.
 */

/** Announced by runners (0.1.65+) that answer `runner.diagnostics` and `aom runner logs|status` in a full-power owner turn. */
export const CEO_DIAGNOSTICS_CAPABILITY = 'ceo-diagnostics:1';

/** What a runner can show. `runner` is the runner's own log, `service` the service manager's journal, `shifts` the shift and chat logs. */
export const RUNNER_LOG_KINDS = ['status', 'runner', 'service', 'shifts', 'env', 'audit'] as const;
export const RunnerLogKind = z.enum(RUNNER_LOG_KINDS);
export type RunnerLogKind = z.infer<typeof RunnerLogKind>;

export const DIAGNOSTICS_MAX_LINES = 2000;
export const DIAGNOSTICS_DEFAULT_LINES = 200;
/** The text of one answer is cut to this many characters (the tail is kept). */
export const DIAGNOSTICS_MAX_CHARS = 60_000;

export const RunnerDiagnosticsRequestSchema = z.object({
  kind: RunnerLogKind.default('runner'),
  lines: z.number().int().min(1).max(DIAGNOSTICS_MAX_LINES).default(DIAGNOSTICS_DEFAULT_LINES),
  /** Only lines that contain this text (case-insensitive, plain text, not a pattern). */
  grep: z.string().trim().min(1).max(200).optional(),
  /** `shifts`, `env` and `audit`: one file by name (without a folder); absent: the newest files are listed. */
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
  /** `service`: how far back (journalctl `--since`, such as `-3 hours`). */
  since: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9 :.+-]+$/)
    .optional(),
});
export type RunnerDiagnosticsRequest = z.infer<typeof RunnerDiagnosticsRequestSchema>;

export const RunnerDiagnosticsResultSchema = z.object({
  kind: RunnerLogKind,
  /** Secrets are masked; the tail of the text when it was cut. */
  text: z.string().max(DIAGNOSTICS_MAX_CHARS + 1000),
  truncated: z.boolean().default(false),
  /** The runner's version and its data folder name, so the answer says what it looked at. */
  runnerVersion: z.string().max(40),
});
export type RunnerDiagnosticsResult = z.infer<typeof RunnerDiagnosticsResultSchema>;

/** `aom ceo diag server`: this Guildwise server's state, or its recent log lines. */
export const SERVER_DIAG_KINDS = ['status', 'logs'] as const;

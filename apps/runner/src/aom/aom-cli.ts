#!/usr/bin/env node
// The in-session `aom` command (docs/ARCHITECTURE.md section 13.4). Talks to the runner's local IPC server with the
// per-shift token from the environment. Verb table: one line per verb.
import { readFileSync, realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type BaTaskShift,
  type DesignAssumption,
  DesignAssumptionSchema,
  type DevopsShift,
  formatCommandLine,
  formatLedgerMatches,
  IPC_REPORT_PATH,
  IPC_RPC_PATH,
  type IpcReportResponse,
  type IpcRpcResponse,
  type LedgerMatch,
  parseCommandLine,
  parseRunHealth,
  parseRunPort,
  parseWaitDuration,
  QA_FOCUS_MAX,
  QUESTION_TOPICS,
  QUESTION_WAIT,
  type QuestionShift,
  type QuestionTopic,
  ReviewRisk,
  RISK_ANALYSIS_MAX,
  type RpcMethod,
  renderBaTaskPrompt,
  renderDevopsPrompt,
  renderQuestionPrompt,
  renderShiftPrompt,
  type ShiftBrief,
  type ShiftReport,
} from '@aom/shared';
import { z } from 'zod';
import { loadSkillGuardConfig, runSkillGuard } from '../capabilities/skill-guard.ts';
import { runGuardHook as runCeoGuardHook } from '../ceo/guard-hook.ts';
import { PermissionRelay } from '../ceo/permission-relay.ts';
import type { ChangeStateLookup } from '../devops/branch-cleanup.ts';
import { loadGuardConfig, runGuardHook } from '../devops/guard.ts';
import { runHygiene } from '../devops/hygiene.ts';

export interface AomIo {
  out(s: string): void;
  err(s: string): void;
}

export interface AomContext {
  env: Record<string, string | undefined>;
  io: AomIo;
  fetch: typeof fetch;
  readFile: (path: string) => string;
  /** Test hooks for `aom question --wait` (real timers when absent). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Parsed {
  flags: Map<string, string[]>;
  positionals: string[];
}

const BOOLEAN_FLAGS = new Set([
  'json',
  'local',
  'ssh-hosts',
  'non-blocking',
  'invalid',
  'force',
  'help',
  'none',
  'role',
  'workflow',
  'private',
  'public',
  'decision',
  'all',
  'wait',
  'docker',
  'dry-run',
  'keep-card',
  'investigation',
  'agree',
  'disagree',
  'undo',
  'drafts',
  'flag',
  'unflag',
  'flagged',
  'drop',
  'allow-free-text',
  'no-free-text',
]);

/** Verbs whose JSON body can be passed inline (`--json '<json>'`): there `--json` takes a value instead of being a switch. */
const takesInlineJson = (verb: string | undefined, argv: string[]): boolean =>
  (verb === 'card' && (argv[0] === 'create' || argv[0] === 'update')) || verb === 'org';

export function parseArgs(argv: string[], verb?: string): Parsed {
  // `aom sudo -- <command> [args...]`: everything after the verb is the command, flags included.
  if (verb === 'sudo') return { flags: new Map(), positionals: argv[0] === '--' ? argv.slice(1) : argv };
  // `aom run step|service ... -- <command> [args...]`: the command after `--` is taken as it is, flags included.
  if (verb === 'run' && argv.includes('--')) {
    const at = argv.indexOf('--');
    const head = parseArgs(argv.slice(0, at), verb);
    head.flags.set(RUN_CMD_FLAG, argv.slice(at + 1));
    return head;
  }
  const inlineJson = takesInlineJson(verb, argv);
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let value: string;
      if (eq !== -1) value = a.slice(eq + 1);
      // `aom question --wait [10m]`: the duration is optional.
      else if ((verb === 'question' || verb === 'ceo') && key === 'wait') {
        const next = argv[i + 1];
        if (next !== undefined && parseWaitDuration(next) !== null) {
          value = next;
          i++;
        } else value = 'true';
      } else if (BOOLEAN_FLAGS.has(key) && !(inlineJson && key === 'json')) value = 'true';
      else {
        const next = argv[i + 1];
        if (next === undefined) throw new UsageError(`--${key} needs a value`);
        value = next;
        i++;
      }
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else positionals.push(a);
  }
  return { flags, positionals };
}

class UsageError extends Error {}

/** Where `parseArgs` keeps the command after `--` of `aom run`. */
const RUN_CMD_FLAG = ' cmd';

/** A JSON object given inline (`--json '<json>'`), in a file (`--file <path>`) or on stdin (`--file -`). Null when none was given. */
function jsonBody(ctx: AomContext, p: Parsed): Record<string, unknown> | null {
  const inline = one(p, 'json');
  const file = one(p, 'file');
  if (inline !== undefined && file !== undefined) throw new UsageError('use either --json or --file');
  if (inline === undefined && file === undefined) return null;
  try {
    const v = JSON.parse(inline ?? ctx.readFile(file as string)) as unknown;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected a JSON object');
    return v as Record<string, unknown>;
  } catch (err) {
    throw new UsageError(
      `cannot read ${inline !== undefined ? '--json' : file === '-' ? 'stdin' : file} as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
/** The runner answered but the feature is not available (exit 2). */
class NotAvailable extends Error {}

const one = (p: Parsed, key: string): string | undefined => p.flags.get(key)?.at(-1);
const many = (p: Parsed, key: string): string[] => p.flags.get(key) ?? [];
const has = (p: Parsed, key: string): boolean => p.flags.has(key);

function textFlag(ctx: AomContext, p: Parsed, key: string, required: boolean): string | undefined {
  const inline = one(p, key);
  const file = one(p, `${key}-file`);
  if (inline !== undefined && file !== undefined)
    throw new UsageError(`use either --${key} or --${key}-file`);
  const text = inline ?? (file !== undefined ? ctx.readFile(file) : undefined);
  if (required && (text === undefined || !text.trim()))
    throw new UsageError(`--${key} "<text>" or --${key}-file <path> is required`);
  return text;
}

function ipc(ctx: AomContext): { url: string; token: string } {
  const url = ctx.env.AOM_IPC_URL;
  const token = ctx.env.AOM_SHIFT_TOKEN;
  if (!url || !token)
    throw new UsageError('AOM_IPC_URL / AOM_SHIFT_TOKEN are not set: `aom` only works inside an agent shift');
  return { url, token };
}

async function post(
  ctx: AomContext,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { url, token } = ipc(ctx);
  let res: Response;
  try {
    res = await ctx.fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`cannot reach the runner at ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // empty body
  }
  return { status: res.status, json };
}

async function rpc(ctx: AomContext, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const { status, json } = await post(ctx, IPC_RPC_PATH, { method, params });
  if (status === 401) throw new Error('this shift is over (token no longer valid)');
  const r = json as unknown as IpcRpcResponse & { error?: string };
  if (status !== 200 || !r.ok) throw new Error(r.error ?? `rpc ${method} failed (HTTP ${status})`);
  return r.result;
}

async function report(ctx: AomContext, rep: ShiftReport): Promise<number> {
  const { status, json } = await post(ctx, IPC_REPORT_PATH, { report: rep });
  if (status === 401) throw new Error('this shift is over (token no longer valid): nothing was recorded');
  if (status === 501) throw new NotAvailable(String(json.error ?? 'not available yet'));
  const r = json as unknown as Partial<IpcReportResponse> & { error?: string };
  if (status === 200 && r.accepted) {
    ctx.io.out(`${r.message ?? 'Recorded.'}\n`);
    return 0;
  }
  ctx.io.err(`${r.message ?? `Rejected (HTTP ${status})`}\n`);
  if (r.error && !r.message?.includes(r.error)) ctx.io.err(`${r.error}\n`);
  for (const v of r.guardViolations ?? []) ctx.io.err(`guard: ${v.rule}: ${v.detail}\n`);
  if (status === 409) ctx.io.err('Do not report again. Finish now.\n');
  else ctx.io.err('Fix the problem and run the command again within this shift.\n');
  return 1;
}

interface QuestionStatusReply {
  state: 'open' | 'answered' | 'unattended' | 'parked' | 'none';
  remainingMs: number;
  answer?: string;
  keepBlockedUntil?: string;
}

/**
 * `aom question --wait [10m]` (Lean Team v3, design 6.2): raise the question without ending the shift, poll the server
 * every ~15 s and print the answer so the agent continues in the same session. When nobody answers in time (or only the
 * manager's desk could), the question becomes a blocking one: the card is parked on it, the claim is released, and the
 * card stays with this agent, which resumes it when the answer arrives. The wait never outlasts the shift.
 */
async function questionWait(
  ctx: AomContext,
  base: Extract<ShiftReport, { kind: 'question' }>,
  minutes: number,
): Promise<number> {
  if (minutes <= 0) throw new UsageError('--wait takes a duration like 10m, 90s or 1h');
  const waitMs = Math.min(minutes, QUESTION_WAIT.maxMinutes) * 60_000;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = ctx.now ?? Date.now;
  const raised = await post(ctx, IPC_REPORT_PATH, { report: { ...base, blocking: false, wait: true } });
  if (raised.status === 401)
    throw new Error('this shift is over (token no longer valid): nothing was recorded');
  const r = raised.json as unknown as Partial<IpcReportResponse> & { error?: string };
  if (!(raised.status === 200 && r.accepted)) {
    ctx.io.err(`${r.message ?? `Rejected (HTTP ${raised.status})`}\n`);
    if (r.error && !r.message?.includes(r.error)) ctx.io.err(`${r.error}\n`);
    ctx.io.err('Fix the problem and run the command again within this shift.\n');
    return 1;
  }
  const started = now();
  const answered = (s: QuestionStatusReply): number => {
    ctx.io.out(
      `Answer: ${s.answer ?? ''}\n${s.keepBlockedUntil ? `The card stays parked until: ${s.keepBlockedUntil}. Finish now; do not make further changes.\n` : 'Continue with your work.\n'}`,
    );
    return 0;
  };
  const convert = async (reason: 'timeout' | 'owner_only'): Promise<number> => {
    const c = await post(ctx, IPC_REPORT_PATH, {
      report: {
        ...base,
        blocking: true,
        wait: false,
        converts: true,
        convertReason: reason,
        waitedMinutes: Math.max(1, Math.round(waitMs / 60_000)),
      },
    });
    const cr = c.json as unknown as Partial<IpcReportResponse> & { error?: string };
    if (c.status === 200 && cr.accepted) {
      ctx.io.out(`${cr.message ?? 'Recorded.'}\n`);
      return 0;
    }
    // Answered between the last poll and now: show the answer instead.
    const s = (await rpc(ctx, 'question.status', {})) as QuestionStatusReply;
    if (s.state === 'answered') return answered(s);
    ctx.io.err(`${cr.message ?? cr.error ?? `Rejected (HTTP ${c.status})`}\n`);
    return 1;
  };
  ctx.io.out('Question sent. Waiting for the answer (keep this command running; do not start other work).\n');
  for (;;) {
    const s = (await rpc(ctx, 'question.status', {})) as QuestionStatusReply;
    if (s.state === 'answered') return answered(s);
    if (s.state === 'parked') {
      ctx.io.out('The card is parked on your question. Finish now; do not make further changes.\n');
      return 0;
    }
    if (s.state === 'none') {
      ctx.io.err('The server has no question of this shift: run the command again.\n');
      return 1;
    }
    const left = Math.min(waitMs - (now() - started), s.remainingMs);
    // Only the manager's desk can answer (nobody up the chain is available), or time is up: park the card on it.
    if (s.state === 'unattended') return convert('owner_only');
    if (left <= 0) return convert('timeout');
    await sleep(Math.min(QUESTION_WAIT.pollSeconds * 1000, left));
  }
}

const outcome = (outcomeId: string, note: string, data: Record<string, unknown> = {}): ShiftReport => ({
  kind: 'outcome',
  outcomeId,
  note,
  data,
});

/** `--risk low|medium|high --risk-file <md> [--qa-focus "<text>"]` of `aom review`: nothing when `--risk` is absent. */
function reviewRiskData(ctx: AomContext, p: Parsed): Record<string, unknown> {
  const risk = one(p, 'risk');
  if (risk === undefined) {
    if (has(p, 'risk-file') || has(p, 'risk-analysis') || has(p, 'qa-focus'))
      throw new UsageError('--risk <low|medium|high> is required with --risk-file / --qa-focus');
    return {};
  }
  if (!ReviewRisk.safeParse(risk).success) throw new UsageError('--risk must be low, medium or high');
  const inline = one(p, 'risk-analysis');
  const file = one(p, 'risk-file');
  if (inline !== undefined && file !== undefined)
    throw new UsageError('use either --risk-file or --risk-analysis');
  let analysis = inline ?? '';
  if (file !== undefined) {
    try {
      analysis = ctx.readFile(file);
    } catch (e) {
      // a relative path is resolved against the shell's working directory (the read-only worktree for a reviewer)
      throw new UsageError(
        `cannot read --risk-file ${file} (${(e as NodeJS.ErrnoException).code ?? 'error'}). The worktree is read-only: write the file in your scratch directory ("$TMPDIR/risk.md") and pass its full path, or pass the text inline with --risk-analysis "<text>"`,
      );
    }
  }
  if (!analysis.trim())
    throw new UsageError(
      '--risk-file <md> is required: your risk analysis (blast radius, failure scenarios, verified, unverified, mitigations)',
    );
  if (analysis.length > RISK_ANALYSIS_MAX)
    throw new UsageError(
      `--risk-file is too long (${analysis.length} characters, at most ${RISK_ANALYSIS_MAX}): shorten it`,
    );
  const qaFocus = one(p, 'qa-focus')?.trim() ?? '';
  if (qaFocus.length > QA_FOCUS_MAX)
    throw new UsageError(`--qa-focus is too long (${qaFocus.length} characters, at most ${QA_FOCUS_MAX})`);
  return { risk, riskAnalysis: analysis.trim(), ...(qaFocus ? { qaFocus } : {}) };
}

/**
 * `aom handoff --build-command ... --build-result ... --test-command ... --test-result ... [--lint-command ... --lint-result ...]`
 * or `--no-evidence "<why>"` (lean team): the build and unit test evidence of the handoff. The commit it is bound to is measured
 * by the runner, not stated by the agent. Nothing when no evidence flag is given (the older workflows).
 */
function buildEvidenceFlags(p: Parsed): Record<string, unknown> | undefined {
  const waived = one(p, 'no-evidence');
  const commands: Array<{ kind: string; command: string; status: 'passed'; result: string }> = [];
  for (const kind of ['build', 'test', 'lint'] as const) {
    const command = one(p, `${kind}-command`);
    const result = one(p, `${kind}-result`);
    if (command === undefined && result === undefined) continue;
    if (!command?.trim())
      throw new UsageError(`--${kind}-result needs --${kind}-command "<the command you ran>"`);
    commands.push({ kind, command: command.trim(), status: 'passed', result: (result ?? '').trim() });
  }
  if (waived !== undefined && commands.length > 0)
    throw new UsageError('use either --no-evidence or the --build/--test flags, not both');
  if (waived !== undefined) return { commands: [], waived: waived.trim() };
  return commands.length > 0 ? { commands } : undefined;
}

function score(p: Parsed): number {
  const s = Number(one(p, 'score'));
  if (!Number.isInteger(s) || s < 1 || s > 5) throw new UsageError('--score <1-5> is required');
  return s;
}

type Verb = (ctx: AomContext, p: Parsed) => Promise<number>;

/** `aom card create|update|specify` (the BA's intake chat): drafts and validates cards through the server. */
async function cardDraft(ctx: AomContext, p: Parsed, sub: 'create' | 'update' | 'specify'): Promise<number> {
  const ref = p.positionals[1];
  const fileJson = (): Record<string, unknown> => {
    const body = jsonBody(ctx, p);
    if (!body)
      throw new UsageError(
        `usage: aom card ${sub}${sub === 'update' ? ' <REF>' : ''} --json '<json>' | --file <draft.json> | --file - (stdin)`,
      );
    return body;
  };
  if (sub === 'create') {
    const r = (await rpc(ctx, 'card.create', fileJson())) as { ref: string; missing?: string[] };
    ctx.io.out(
      `Created ${r.ref} (draft).${r.missing?.length ? ` Still missing before it can be specified: ${r.missing.join(', ')}.` : ' It is complete: run `aom card specify` when you are happy with it.'}\n`,
    );
    return 0;
  }
  if (!ref)
    throw new UsageError(
      `usage: aom card ${sub} <REF>${sub === 'update' ? " --json '<json>' | --file <patch.json>" : ''}`,
    );
  if (sub === 'update') {
    const r = (await rpc(ctx, 'card.update', { ...fileJson(), ref })) as { ref: string; missing?: string[] };
    ctx.io.out(
      `Updated ${r.ref}.${r.missing?.length ? ` Still missing: ${r.missing.join(', ')}.` : ' It is complete.'}\n`,
    );
    return 0;
  }
  const r = (await rpc(ctx, 'card.specify', { ref })) as { ref: string; stage: string; status: string };
  ctx.io.out(`Specified ${r.ref}: it is now in ${r.stage} (${r.status}).\n`);
  return 0;
}

const REPORT_USAGE = `usage: aom report brief --summary-file <report.md>   # the CEO's analysis request (read-only)
       aom report mail-draft --text-file <reply.txt> [--subject "<subject>"]
       aom report mail-draft-fail --note "<why no reply can be written>"
       aom report spec-card --file <fields.json>      # { "fields": { "<missing field key>": "<text>" } } | { "repo": "<name>", "fields": {...} } | { "split": [ { "title", "repo", "fields", "dependsOn" } ] }
       aom report spec-card-fail --note "<why the card cannot be specified>"`;

/**
 * `aom report ...`: the BA's task reports. The BA reporter is retired (docs/design/ceo-front-door.md step 3): `triage`,
 * `notes`, `signals` and `floor` answer "retired" for one runner version, then go.
 */
async function reportVerb(ctx: AomContext, p: Parsed): Promise<number> {
  const sub = p.positionals[0];
  const data = (): Record<string, unknown> => {
    const body = jsonBody(ctx, p);
    if (!body) throw new UsageError(REPORT_USAGE);
    return body;
  };
  switch (sub) {
    case 'triage':
    case 'notes':
    case 'signals':
    case 'floor':
      ctx.io.err(
        `aom report ${sub} is retired: the BA no longer triages, notes, analyses signals or writes the floor report (the CEO does). Finish without reporting.\n`,
      );
      return 1;
    case 'brief':
      return report(
        ctx,
        outcome('scheduled_brief', 'Scheduled task report', {
          report: textFlag(ctx, p, 'summary', true) as string,
        }),
      );
    case 'mail-draft': {
      const subject = one(p, 'subject')?.trim();
      return report(
        ctx,
        outcome('mail_draft_done', 'Reply draft', {
          text: textFlag(ctx, p, 'text', true) as string,
          ...(subject ? { subject } : {}),
        }),
      );
    }
    case 'mail-draft-fail':
      return report(
        ctx,
        outcome('mail_draft_fail', (textFlag(ctx, p, 'note', true) as string).trim().slice(0, 500), {}),
      );
    case 'spec-card':
      return report(ctx, outcome('spec_card_done', 'Card fields', data()));
    case 'spec-card-fail':
      return report(
        ctx,
        outcome('spec_card_fail', (textFlag(ctx, p, 'note', true) as string).trim().slice(0, 500), {}),
      );
    default:
      throw new UsageError(REPORT_USAGE);
  }
}

const PHASE_USAGE = `usage: aom phase list [--project <KEY>]
       aom phase propose --name "<name>" [--project <KEY>] [--description "<text>"] [--followups-file <json>]
       aom phase assign <CARD-REF> --phase <ref|"name"> | --none [--project <KEY>]
       aom phase submit <phase ref> [--project <KEY>]
       aom phase followup brief <n> --to devops|tester|ba --text "<instructions>"
       aom phase ready [--note "<text>"]
       aom phase report --summary-file <report.md> [--outstanding "<item>"]...
       aom phase followup done <n> --summary "<what you did>" [--link <url>]...
       aom phase followup fail <n> --summary "<why not>"
       aom phase results --summary-file <report.md>`;

/** `aom phase ...`: the BA proposes phases in its intake chat and works the phase tasks (report, briefs, results). */
async function phaseVerb(ctx: AomContext, p: Parsed): Promise<number> {
  const [sub, ...rest] = p.positionals;
  const project = one(p, 'project');
  const scope = project ? { project } : {};
  const say = (r: unknown, fallback: string): number => {
    ctx.io.out(`${(r as { message?: string } | null)?.message ?? fallback}\n`);
    return 0;
  };
  const position = (raw: string | undefined): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new UsageError(PHASE_USAGE);
    return n;
  };
  switch (sub) {
    case 'list': {
      const r = (await rpc(ctx, 'phase.list', scope)) as {
        project: string;
        phases: Array<{ ref: string; name: string; status: string; members: number; followups: string[] }>;
        deployTargets: Array<{
          name: string;
          kind: string;
          host: string | null;
          appUrl: string | null;
          workstation: string | null;
          testerOnWorkstation: boolean | null;
          notes: string;
        }>;
        defaultFollowups: unknown[];
      };
      const lines = [
        `Project ${r.project}`,
        '',
        'Phases:',
        ...(r.phases.length
          ? r.phases.map(
              (x) =>
                `- ${x.ref} ${x.name} (${x.status}, ${x.members} card(s))${x.followups.length ? `; follow-ups: ${x.followups.join(' > ')}` : ''}`,
            )
          : ['- none']),
        '',
        'Deploy targets (use these ids or names in follow-ups; never invent one):',
        ...(r.deployTargets.length
          ? r.deployTargets.map(
              (t) =>
                `- ${t.name}: ${t.kind === 'local_docker' ? 'local Docker (every member workstation)' : `remote ${t.host}${t.workstation ? ` via ${t.workstation}` : ''}`}${t.appUrl ? `, ${t.appUrl}` : ''}${t.testerOnWorkstation === false ? ' [no tester on that workstation]' : ''}`,
            )
          : ['- none (ask the manager to add one in the project settings)']),
        '',
        `Default follow-ups: ${JSON.stringify(r.defaultFollowups)}`,
      ];
      ctx.io.out(`${lines.join('\n')}\n`);
      return 0;
    }
    case 'propose': {
      const name = one(p, 'name');
      if (!name) throw new UsageError(PHASE_USAGE);
      const file = one(p, 'followups-file');
      const description = one(p, 'description');
      let followups: unknown;
      if (file) {
        try {
          followups = JSON.parse(ctx.readFile(file));
        } catch (err) {
          throw new UsageError(
            `cannot read --followups-file as JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return say(
        await rpc(ctx, 'phase.propose', {
          ...scope,
          name,
          ...(description ? { description } : {}),
          ...(followups !== undefined ? { followups } : {}),
        }),
        'Proposed.',
      );
    }
    case 'assign': {
      const card = rest[0];
      const phase = one(p, 'phase');
      if (!card || (!phase && !has(p, 'none'))) throw new UsageError(PHASE_USAGE);
      return say(
        await rpc(ctx, 'phase.assign', { ...scope, card, phase: has(p, 'none') ? null : phase }),
        'Done.',
      );
    }
    case 'submit': {
      if (!rest[0]) throw new UsageError(PHASE_USAGE);
      return say(await rpc(ctx, 'phase.submit', { ...scope, phase: rest[0] }), 'Submitted.');
    }
    case 'ready':
      return report(
        ctx,
        outcome('phase_ready', textFlag(ctx, p, 'note', false)?.trim() || 'Every follow-up is briefed', {
          note: textFlag(ctx, p, 'note', false) ?? '',
        }),
      );
    case 'report': {
      const text = textFlag(ctx, p, 'summary', true) as string;
      return report(
        ctx,
        outcome('phase_report', 'Phase report', { report: text, outstanding: many(p, 'outstanding') }),
      );
    }
    case 'results': {
      const text = textFlag(ctx, p, 'summary', true) as string;
      return report(ctx, outcome('phase_results', 'Follow-up results report', { report: text }));
    }
    case 'followup': {
      const [verb, n] = rest;
      if (verb === 'brief') {
        const to = one(p, 'to');
        if (to !== 'devops' && to !== 'tester' && to !== 'ba') throw new UsageError(PHASE_USAGE);
        return say(
          await rpc(ctx, 'phase.followup.brief', {
            position: position(n),
            to,
            text: textFlag(ctx, p, 'text', true),
          }),
          'Briefed.',
        );
      }
      if (verb === 'done')
        return report(
          ctx,
          outcome('followup_done', `Follow-up ${n} done`, {
            position: position(n),
            summary: textFlag(ctx, p, 'summary', true),
            links: many(p, 'link'),
          }),
        );
      if (verb === 'fail')
        return report(
          ctx,
          outcome('followup_failed', `Follow-up ${n} failed`, {
            position: position(n),
            summary: textFlag(ctx, p, 'summary', true),
          }),
        );
      throw new UsageError(PHASE_USAGE);
    }
    default:
      throw new UsageError(PHASE_USAGE);
  }
}

const ORG_USAGE = `usage: aom org catalogue
       aom org role draft --json '<json>' | --file <role.json> | --file -
       aom org workflow draft --json '<json>' | --file <workflow.json> | --file -
       aom org workflow variant --file <variant.json> | --file -
       aom org validate <key> [--role|--workflow]
       aom org submit <key> [--role|--workflow]
       aom org department --name "<name>"`;

/** `aom org ...` (the BA's design chat): draft roles and workflows for the owner's organization, validate, submit. */
async function orgDesign(ctx: AomContext, p: Parsed): Promise<number> {
  const [sub, ...rest] = p.positionals;
  const kind = has(p, 'role') ? 'role' : has(p, 'workflow') ? 'workflow' : undefined;
  const readJson = (): Record<string, unknown> => {
    const body = jsonBody(ctx, p);
    if (!body) throw new UsageError(ORG_USAGE);
    return body;
  };
  const print = (r: unknown): number => {
    const m = (r as { message?: string } | null)?.message;
    ctx.io.out(`${m ?? JSON.stringify(r, null, 2)}\n`);
    return 0;
  };
  switch (sub) {
    case 'catalogue':
      return print(await rpc(ctx, 'org.catalogue'));
    case 'role':
    case 'workflow': {
      if (sub === 'workflow' && rest[0] === 'variant')
        return print(await rpc(ctx, 'org.workflowVariant', { definition: readJson() }));
      if (rest[0] !== 'draft') throw new UsageError(ORG_USAGE);
      return print(await rpc(ctx, `org.${sub}.draft`, { definition: readJson() }));
    }
    case 'validate':
    case 'submit': {
      const key = rest[0];
      if (!key) throw new UsageError(ORG_USAGE);
      return print(await rpc(ctx, `org.${sub}`, { key, ...(kind ? { kind } : {}) }));
    }
    case 'department': {
      const name = one(p, 'name');
      if (!name) throw new UsageError(ORG_USAGE);
      return print(await rpc(ctx, 'org.department', { name }));
    }
    default:
      throw new UsageError(ORG_USAGE);
  }
}

/** `--assumption "<assumption> | <dependency ref> | <what changes if wrong>"` (repeatable) or `--assumptions-file <json>`. */
function designAssumptions(ctx: AomContext, p: Parsed): DesignAssumption[] {
  const out: DesignAssumption[] = [];
  for (const raw of many(p, 'assumption')) {
    const parts = raw.split('|').map((x) => x.trim());
    if (parts.length < 3 || parts.some((x) => !x))
      throw new UsageError(
        `--assumption needs three parts: "<assumption> | <dependency ref> | <what changes if wrong>" (got: ${raw.slice(0, 80)})`,
      );
    const [assumption, dependency, ...rest] = parts as [string, string, ...string[]];
    out.push({ assumption, dependency, ifWrong: rest.join(' | ') });
  }
  const file = one(p, 'assumptions-file');
  if (file) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ctx.readFile(file));
    } catch {
      throw new UsageError(`--assumptions-file ${file} is not valid JSON`);
    }
    const r = z.array(DesignAssumptionSchema).safeParse(parsed);
    if (!r.success)
      throw new UsageError(
        '--assumptions-file must be a JSON list of {"assumption", "dependency", "ifWrong"} objects',
      );
    out.push(...r.data);
  }
  return out;
}

const DESIGN_USAGE_EXTRA =
  '\n       a design made before its dependencies landed also needs --assumption "<assumption> | <dependency ref> | <what changes if wrong>" (repeatable) or --no-assumptions "<why>"' +
  '\n       the assumption review: aom design confirm --summary "<how you checked>"   |   aom design revise --report <path> --summary "..." --revised <numbers> --note "<what changed>"';

/** `aom design` / `aom investigate`: the architect's terminal report (the runner checks and commits the report file). */
async function investigationReport(
  ctx: AomContext,
  p: Parsed,
  outcomeId: 'handoff' | 'report',
  verb: 'design' | 'investigate',
): Promise<number> {
  // `aom design confirm|revise`: the review of the assumptions of a design made before its dependencies landed.
  const sub = verb === 'design' ? p.positionals[0] : undefined;
  if (sub === 'confirm' || sub === 'revise') {
    const summary = (textFlag(ctx, p, 'summary', true) as string).trim();
    const revised = (one(p, 'revised') ?? '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (revised.some((n) => !Number.isInteger(n) || n < 1))
      throw new UsageError(
        '--revised takes the numbers of the assumptions that did not hold, e.g. --revised 1,3',
      );
    if (sub === 'revise' && (!one(p, 'report') || revised.length === 0))
      throw new UsageError(
        'usage: aom design revise --report <path> --summary "..." --revised <numbers> --note "<what changed and why>"',
      );
    return report(
      ctx,
      outcome(outcomeId, summary.slice(0, 20000), {
        reportPath: one(p, 'report')?.trim() || 'existing',
        summary: summary.slice(0, 2000),
        location: 'repo',
        review: { decision: sub, revised, note: (one(p, 'note') ?? '').slice(0, 4000) },
      }),
    );
  }
  const reportFile = one(p, 'report');
  if (!reportFile?.trim())
    throw new UsageError(
      `usage: aom ${verb} --report <report path> --summary "<${verb === 'design' ? '3-6 lines for the builder' : 'what you found and recommend'}>" | --summary-file <md>${verb === 'design' ? DESIGN_USAGE_EXTRA : ''}`,
    );
  const summary = (textFlag(ctx, p, 'summary', true) as string).trim();
  const assumptions = verb === 'design' ? designAssumptions(ctx, p) : [];
  const none = verb === 'design' ? one(p, 'no-assumptions')?.trim() : undefined;
  // `location` is decided by the runner from the brief; the schema needs a value.
  return report(
    ctx,
    outcome(outcomeId, summary.slice(0, 20000), {
      reportPath: reportFile.trim(),
      summary: summary.slice(0, 2000),
      location: 'repo',
      ...(assumptions.length ? { assumptions } : {}),
      ...(none ? { noAssumptions: none } : {}),
    }),
  );
}

/** Flags `aom ceo act` reads itself; every other flag is a parameter of the action (`--keep-card` -> `keepCard`). */
const CEO_CONTROL_FLAGS = new Set(['reason', 'confidence', 'evidence', 'dry-run', 'key', 'json']);
const camel = (k: string): string => k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

const CEO_USAGE = `usage: aom ceo snapshot [--section <name>] | show card|agent|project|shift|desk-item|workstation <ref> | search desk|cards|memory "<q>" | route "<request>" | route --drafts | costs [--days n]
       aom ceo act <action> [--<param> <value>]... --reason "<why>" --confidence 0.0-1.0 [--evidence ledger:<id>|memory:<id>|signal:<id>|hr:<id>]... [--dry-run] [--key <k>]
       aom ceo recommend --item <desk id> [--option <o1>|--text "..."] --reason "..." --confidence 0.0-1.0  |  --action <name> [--<param> <value>]... --reason "..." --confidence ...
       aom ceo notify --kind needs_you|urgent|task_done --text "..." [--title "..."] [--task <id>] [--item <id>]
       aom ceo task create --title "..." [--request "..."] [--due <iso>] | task update --id <id> [--status s] [--note "..."] [--watch card:<id>]... | task list
       aom ceo memory propose --text "..." --source owner_chat|desk:<item id> [--kind rule|preference|fact] [--quote "..."]
       aom ceo review-reply --item <desk item id> --agree|--disagree --reflection "<what you got wrong and why>" --lesson "<rule for next time>" [--card-changes "<comments on the BA's proposed cards>"]   (a decision_review wake)
       aom ceo devops (--project KEY | --env NAME | --workstation <name>) --text "<what DevOps should do>" [--card <ref>] [--wait <seconds>] [--reason "..." --confidence ...]
       aom ceo draft-cards --project KEY --file cards.json   (up to 10 draft cards from a JSON array; nothing is specified)
       aom ceo correction record [--action <action id>] --text "<the owner's words>" --rule "<the rule, in his words>" [--undo]   (owner turns only)
       aom ceo job start --kind <slug> [--why "<owner's words>"] | job log --kind <slug> --title "..." --summary "..." [--project KEY] [--command "<the main shell command it was done with>"] | job repeats   (work you did yourself instead of through the board)
       aom ceo topic list | topic propose [--from <note id>[,<note id>]] --area deploy|sandbox|auth|secrets|agent-loops|context-limits|cost|testing|review|integrations|other --question "<one generic question>" [--audience developer|ops|founder]   (a research topic for the Guildwise blog; the owner decides what is sent)
       aom ceo order invoke <order id> --wake <wake id> --why "<how this event falls under the order>" --confidence 0.0-1.0   (a wake)
       aom ceo order decline --ask "<question for the owner>"  |  order done --summary "..." [--commands-file <file>]   (an order turn, terminal)
       aom ceo backlog add|list|update|send ...   (the project backlog: wanted work outside development; send hands items to the BA)
       aom ceo dir add <path>   (an extra working directory of this conversation)
       aom runner restart [--reason "..."]   (restarts the runner after your reply; never use systemctl or kill)
       aom ceo done --summary "..."   (a wake, terminal)   |   aom ceo report --summary-file <md>   (the daily review, terminal)`;

function ceoPrint(ctx: AomContext, p: Parsed, r: unknown): void {
  if (has(p, 'json')) {
    ctx.io.out(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }
  const o = r as { text?: string; status?: string; message?: string; tasks?: unknown[]; wouldBe?: string };
  if (typeof o?.text === 'string') ctx.io.out(`${o.text}\n`);
  else if (o?.status || o?.message)
    ctx.io.out(`${o.status ?? ''}${o.status && o.message ? ': ' : ''}${o.message ?? ''}\n`);
  else ctx.io.out(`${JSON.stringify(r, null, 2)}\n`);
}

function ceoParams(p: Parsed, skip: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of p.flags) if (!skip.has(k)) out[camel(k)] = v.length > 1 ? v : v[0];
  return out;
}

function ceoReasoned(p: Parsed): { reason: string; confidence: number; evidence: string[] } {
  const reason = one(p, 'reason');
  const conf = Number(one(p, 'confidence'));
  if (!reason || !Number.isFinite(conf) || conf < 0 || conf > 1)
    throw new UsageError('--reason "<why>" and --confidence <0.0-1.0> are required');
  return { reason, confidence: conf, evidence: many(p, 'evidence') };
}

/** `--reason`/`--confidence` when given; otherwise the defaults of the convenience verbs (`devops`, `draft-cards`). */
function ceoReasonedOr(
  p: Parsed,
  reason: string,
): { reason: string; confidence: number; evidence: string[] } {
  if (one(p, 'reason') || one(p, 'confidence')) return ceoReasoned(p);
  return { reason, confidence: 0.9, evidence: many(p, 'evidence') };
}

/** A command list: a JSON array of strings, or one command per line. */
function readCommands(text: string): string[] {
  try {
    const v = JSON.parse(text) as unknown;
    if (Array.isArray(v)) return v.map(String).slice(0, 200);
  } catch {
    // one command per line
  }
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 200);
}

const sleepOf = (ctx: AomContext) =>
  ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

/**
 * `aom ceo devops ... [--wait <sec>]` (docs/design/ceo-front-door.md section 8): files the DevOps request through the `devops`
 * action; with `--wait` it works like a subagent: it polls the request every 10 seconds, prints the progress, and returns
 * the DevOps summary, or after the timeout "still running" (a task watch wakes the CEO when it finishes).
 */
async function ceoDevops(ctx: AomContext, p: Parsed): Promise<number> {
  const text = textFlag(ctx, p, 'text', true) as string;
  const params = ceoParams(p, new Set([...CEO_CONTROL_FLAGS, 'wait', 'text-file']));
  params.text = text;
  const r = (await rpc(ctx, 'ceo', {
    op: 'act',
    action: 'devops',
    params,
    ...ceoReasonedOr(p, `asking DevOps: ${text.slice(0, 120)}`),
    ...(one(p, 'key') ? { key: one(p, 'key') } : {}),
    dryRun: has(p, 'dry-run'),
  })) as { status?: string; result?: { requestId?: string } };
  ceoPrint(ctx, p, r);
  if (r.status === 'refused') return 1;
  const requestId = r.result?.requestId;
  if (!has(p, 'wait') || !requestId || r.status !== 'executed') return 0;
  const waitSec = Number(one(p, 'wait')) > 0 ? Number(one(p, 'wait')) : 600;
  const now = ctx.now ?? Date.now;
  const deadline = now() + waitSec * 1000;
  let seen = 0;
  let last = '';
  for (;;) {
    const s = (await rpc(ctx, 'ceo', { op: 'devops_status', requestId })) as {
      status?: string;
      summary?: string;
      progress?: string[];
    };
    for (const line of (s.progress ?? []).slice(seen)) ctx.io.out(`DevOps: ${line}\n`);
    seen = s.progress?.length ?? seen;
    if (s.status && s.status !== last) {
      last = s.status;
      if (s.status !== 'done' && s.status !== 'failed')
        ctx.io.out(`DevOps request ${requestId}: ${s.status}\n`);
    }
    if (s.status === 'done') {
      ctx.io.out(`DevOps is done: ${s.summary ?? 'no summary'}\n`);
      return 0;
    }
    if (s.status === 'failed') {
      ctx.io.out(`DevOps failed: ${s.summary ?? 'no summary'}\n`);
      return 1;
    }
    if (now() >= deadline) {
      ctx.io.out(`still running: request ${requestId}; I'll follow up\n`);
      return 0;
    }
    await sleepOf(ctx)(10_000);
  }
}

const BACKLOG_USAGE = `usage: aom ceo backlog add --project KEY --title "..." [--description "..."] [--priority critical|high|normal|low] [--tag <t>]... [--flag]
       aom ceo backlog list [--project KEY] [--tag <t>]... [--priority <p>]... [--flagged] [--status open|done|dropped|all]... [--search "..."] [--sort priority|created] [--json]
       aom ceo backlog update <id> [--title "..."] [--description "..."] [--priority <p>] [--tag <t>]... [--flag|--unflag]   (--tag replaces the whole tag list)  |  update <id> --drop
       aom ceo backlog send <id>  |  send [--project KEY] [--tag <t>]... [--priority <p>]... [--flagged]   (Open items only; each becomes its own card)`;

/** Priority in any case ("High"); the server refuses an unknown one. */
const backlogPriority = (v: string): string => v.trim().toLowerCase();

/** `aom ceo backlog add|list|update|send`: the project backlog. The server applies the rules; this builds the call. */
export async function ceoBacklog(ctx: AomContext, p: Parsed, args: string[]): Promise<number> {
  const sub = args[0];
  const tags = many(p, 'tag');
  const priorities = many(p, 'priority').map(backlogPriority);
  const act = async (action: string, params: Record<string, unknown>, reason: string): Promise<number> => {
    const r = await rpc(ctx, 'ceo', {
      op: 'act',
      action,
      params,
      ...ceoReasonedOr(p, reason),
      ...(one(p, 'key') ? { key: one(p, 'key') } : {}),
      dryRun: has(p, 'dry-run'),
    });
    ceoPrint(ctx, p, r);
    return (r as { status?: string }).status === 'refused' ? 1 : 0;
  };
  switch (sub) {
    case 'add': {
      const project = one(p, 'project');
      const title = one(p, 'title');
      if (!project || !title?.trim()) throw new UsageError(BACKLOG_USAGE);
      return act(
        'backlog-add',
        {
          project,
          title,
          ...(one(p, 'description') !== undefined ? { description: one(p, 'description') } : {}),
          ...(priorities.length ? { priority: priorities.at(-1) } : {}),
          ...(tags.length ? { tags } : {}),
          ...(has(p, 'flag') ? { flagged: true } : {}),
        },
        `the owner asked: backlog add ${title}`,
      );
    }
    case 'list': {
      const statuses = many(p, 'status').flatMap((s) => s.split(',').map((x) => x.trim().toLowerCase()));
      const status = statuses.includes('all') ? ['open', 'done', 'dropped'] : statuses;
      const r = await rpc(ctx, 'ceo', {
        op: 'backlog',
        sub: 'list',
        ...(one(p, 'project') ? { project: one(p, 'project') } : {}),
        ...(tags.length ? { tag: tags } : {}),
        ...(priorities.length ? { priority: priorities } : {}),
        ...(has(p, 'flagged') ? { flagged: true } : {}),
        ...(status.length ? { status } : {}),
        ...(one(p, 'search') ? { q: one(p, 'search') } : {}),
        ...(one(p, 'sort') ? { sort: one(p, 'sort') } : {}),
      });
      ceoPrint(ctx, p, r);
      return 0;
    }
    case 'update': {
      const item = args[1];
      if (!item) throw new UsageError(BACKLOG_USAGE);
      if (has(p, 'flag') && has(p, 'unflag')) throw new UsageError('use either --flag or --unflag');
      return act(
        'backlog-update',
        {
          item,
          ...(one(p, 'title') !== undefined ? { title: one(p, 'title') } : {}),
          ...(one(p, 'description') !== undefined ? { description: one(p, 'description') } : {}),
          ...(priorities.length ? { priority: priorities.at(-1) } : {}),
          ...(tags.length ? { tags } : {}),
          ...(has(p, 'flag') ? { flagged: true } : has(p, 'unflag') ? { flagged: false } : {}),
          ...(has(p, 'drop') ? { drop: true } : {}),
        },
        `the owner asked: backlog update ${item}`,
      );
    }
    case 'send': {
      const item = args[1];
      return act(
        'backlog-send',
        {
          ...(item ? { item } : {}),
          ...(one(p, 'project') ? { project: one(p, 'project') } : {}),
          ...(tags.length ? { tag: tags } : {}),
          ...(priorities.length ? { priority: priorities } : {}),
          ...(has(p, 'flagged') ? { flagged: true } : {}),
        },
        item
          ? `the owner asked: send backlog item ${item} to the BA`
          : 'the owner asked: send backlog items to the BA',
      );
    }
    default:
      throw new UsageError(BACKLOG_USAGE);
  }
}

/** `aom backlog suggest`: an agent adds a follow-up it found. The server records the agent and card from the shift. */
async function backlogVerb(ctx: AomContext, p: Parsed): Promise<number> {
  if (p.positionals[0] !== 'suggest')
    throw new UsageError(
      'usage: aom backlog suggest --title "<title>" [--description "<what and why>" | --description-file <f>] [--priority critical|high|normal|low] [--tag <t>]... [--project KEY]   (only `suggest` exists for agents: the owner decides)',
    );
  const title = one(p, 'title');
  if (!title?.trim()) throw new UsageError('--title "<title>" is required');
  const description = textFlag(ctx, p, 'description', false);
  const tags = many(p, 'tag');
  const r = (await rpc(ctx, 'backlog.suggest', {
    title,
    ...(description !== undefined ? { description } : {}),
    ...(one(p, 'priority') ? { priority: backlogPriority(one(p, 'priority') as string) } : {}),
    ...(tags.length ? { tags } : {}),
    ...(one(p, 'project') ? { project: one(p, 'project') } : {}),
  })) as { message?: string };
  ctx.io.out(
    `${r?.message ?? 'Added to the backlog as a suggestion. The owner decides; continue your work.'}\n`,
  );
  return 0;
}

/** `aom ceo ...`: the CEO agent's management verbs. The server decides what the CEO may do; a refusal is a normal answer. */
async function ceoVerb(ctx: AomContext, p: Parsed): Promise<number> {
  const sub = p.positionals[0];
  const args = p.positionals.slice(1);
  switch (sub) {
    case 'snapshot':
      ceoPrint(
        ctx,
        p,
        await rpc(ctx, 'ceo', {
          op: 'snapshot',
          ...(one(p, 'section') ? { section: one(p, 'section') } : {}),
        }),
      );
      return 0;
    case 'show':
      if (!args[0] || !args[1]) throw new UsageError(CEO_USAGE);
      ceoPrint(ctx, p, await rpc(ctx, 'ceo', { op: 'show', kind: args[0], ref: args.slice(1).join(' ') }));
      return 0;
    case 'search':
      if (!args[0] || !args[1]) throw new UsageError(CEO_USAGE);
      ceoPrint(ctx, p, await rpc(ctx, 'ceo', { op: 'search', in: args[0], q: args.slice(1).join(' ') }));
      return 0;
    case 'route':
      // which projects and areas a request belongs to; the workstation answers from the organization graph (read-only)
      if (!args[0] && one(p, 'drafts') === undefined) throw new UsageError(CEO_USAGE);
      ceoPrint(
        ctx,
        p,
        await rpc(ctx, 'ceo', {
          op: 'route',
          q: args.join(' '),
          ...(one(p, 'drafts') !== undefined ? { drafts: true } : {}),
        }),
      );
      return 0;
    case 'costs':
      ceoPrint(
        ctx,
        p,
        await rpc(ctx, 'ceo', { op: 'costs', ...(one(p, 'days') ? { days: Number(one(p, 'days')) } : {}) }),
      );
      return 0;
    case 'act': {
      const action = args[0];
      if (!action) throw new UsageError(CEO_USAGE);
      const r = (await rpc(ctx, 'ceo', {
        op: 'act',
        action,
        params: ceoParams(p, CEO_CONTROL_FLAGS),
        ...ceoReasoned(p),
        ...(one(p, 'key') ? { key: one(p, 'key') } : {}),
        dryRun: has(p, 'dry-run'),
      })) as { status?: string };
      ceoPrint(ctx, p, r);
      return r.status === 'refused' ? 1 : 0;
    }
    case 'recommend': {
      const item = one(p, 'item');
      const base = { op: 'recommend', ...ceoReasoned(p), ...(one(p, 'key') ? { key: one(p, 'key') } : {}) };
      if (item) {
        const r = await rpc(ctx, 'ceo', {
          ...base,
          item,
          ...(one(p, 'option') ? { option: one(p, 'option') } : {}),
          ...(one(p, 'text') ? { text: one(p, 'text') } : {}),
        });
        ceoPrint(ctx, p, r);
        return (r as { status?: string }).status === 'refused' ? 1 : 0;
      }
      const action = one(p, 'action');
      if (!action) throw new UsageError(CEO_USAGE);
      const r = await rpc(ctx, 'ceo', {
        ...base,
        action,
        params: ceoParams(p, new Set([...CEO_CONTROL_FLAGS, 'action'])),
      });
      ceoPrint(ctx, p, r);
      return (r as { status?: string }).status === 'refused' ? 1 : 0;
    }
    case 'notify': {
      const kind = one(p, 'kind');
      const text = textFlag(ctx, p, 'text', true) as string;
      if (!kind) throw new UsageError(CEO_USAGE);
      ceoPrint(
        ctx,
        p,
        await rpc(ctx, 'ceo', {
          op: 'notify',
          kind,
          text,
          ...(one(p, 'title') ? { title: one(p, 'title') } : {}),
          ...(one(p, 'task') ? { task: one(p, 'task') } : {}),
          ...(one(p, 'item') ? { item: one(p, 'item') } : {}),
          ...(one(p, 'key') ? { key: one(p, 'key') } : {}),
        }),
      );
      return 0;
    }
    case 'task': {
      const act = args[0];
      if (act !== 'create' && act !== 'update' && act !== 'list') throw new UsageError(CEO_USAGE);
      const watch = many(p, 'watch').map((w) => {
        const [kind, ...id] = w.split(':');
        return { kind, id: id.join(':') };
      });
      const r = await rpc(ctx, 'ceo', {
        op: 'task',
        sub: act,
        ...(one(p, 'id') ? { id: one(p, 'id') } : {}),
        ...(one(p, 'title') ? { title: one(p, 'title') } : {}),
        ...(one(p, 'request') ? { request: one(p, 'request') } : {}),
        ...(one(p, 'status') ? { status: one(p, 'status') } : {}),
        ...(one(p, 'note') ? { note: one(p, 'note') } : {}),
        ...(one(p, 'due') ? { due: one(p, 'due') } : {}),
        ...(watch.length ? { watch } : {}),
      });
      ceoPrint(ctx, p, r);
      return (r as { status?: string }).status === 'refused' ? 1 : 0;
    }
    case 'memory': {
      if (args[0] !== 'propose' && args[0] !== 'confirm') throw new UsageError(CEO_USAGE);
      const r = await rpc(ctx, 'ceo', {
        op: 'memory',
        sub: args[0],
        ...(one(p, 'id') ? { id: one(p, 'id') } : {}),
        ...(one(p, 'text') ? { text: one(p, 'text') } : {}),
        ...(one(p, 'kind') ? { kind: one(p, 'kind') } : {}),
        ...(one(p, 'source') ? { source: one(p, 'source') } : {}),
        ...(one(p, 'quote') ? { quote: one(p, 'quote') } : {}),
        ...(one(p, 'scope') ? { scope: one(p, 'scope') } : {}),
      });
      ceoPrint(ctx, p, r);
      return (r as { status?: string }).status === 'refused' ? 1 : 0;
    }
    case 'review-reply': {
      const item = one(p, 'item');
      const agree = has(p, 'agree');
      if (!item || agree === has(p, 'disagree'))
        throw new UsageError('--item <id> and exactly one of --agree or --disagree are required');
      const reflection = textFlag(ctx, p, 'reflection', true) as string;
      const lesson = textFlag(ctx, p, 'lesson', true) as string;
      const changes = textFlag(ctx, p, 'card-changes', false) as string | undefined;
      const r = await rpc(ctx, 'ceo', {
        op: 'review_reply',
        item,
        stance: agree ? 'agree' : 'disagree',
        reflection,
        lesson,
        ...(changes ? { cardChanges: changes } : {}),
      });
      ceoPrint(ctx, p, r);
      return (r as { status?: string }).status === 'refused' ? 1 : 0;
    }
    case 'devops':
      return ceoDevops(ctx, p);
    case 'draft-cards': {
      const project = one(p, 'project');
      const file = one(p, 'file');
      if (!project || !file) throw new UsageError('--project KEY and --file cards.json are required');
      let cards: unknown;
      try {
        cards = JSON.parse(ctx.readFile(file));
      } catch (err) {
        throw new UsageError(
          `cannot read ${file} as JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!Array.isArray(cards)) throw new UsageError(`${file} must hold a JSON array of cards`);
      const r = (await rpc(ctx, 'ceo', {
        op: 'act',
        action: 'draft-cards',
        params: { project, cards },
        ...ceoReasonedOr(p, `drafting ${cards.length} card(s) for ${project}`),
        ...(one(p, 'key') ? { key: one(p, 'key') } : {}),
        dryRun: has(p, 'dry-run'),
      })) as { status?: string };
      ceoPrint(ctx, p, r);
      return r.status === 'refused' ? 1 : 0;
    }
    case 'correction': {
      if (args[0] !== 'record') throw new UsageError(CEO_USAGE);
      const r = await rpc(ctx, 'ceo', {
        op: 'correction',
        ...(one(p, 'action') ? { action: one(p, 'action') } : {}),
        text: textFlag(ctx, p, 'text', true) as string,
        rule: textFlag(ctx, p, 'rule', true) as string,
        remedy: has(p, 'undo') ? 'undo' : 'none',
      });
      ceoPrint(ctx, p, r);
      return (r as { status?: string }).status === 'refused' ? 1 : 0;
    }
    case 'job': {
      const sub = args[0];
      if (sub !== 'start' && sub !== 'log' && sub !== 'repeats') throw new UsageError(CEO_USAGE);
      if ((sub === 'start' || sub === 'log') && !one(p, 'kind'))
        throw new UsageError('--kind <slug> is required');
      if (sub === 'log' && (!one(p, 'title') || !one(p, 'summary')))
        throw new UsageError('--title "..." and --summary "..." are required');
      const r = await rpc(ctx, 'ceo', {
        op: 'job',
        sub,
        ...(one(p, 'kind') ? { kind: one(p, 'kind') } : {}),
        ...(one(p, 'why') ? { why: one(p, 'why') } : {}),
        ...(one(p, 'title') ? { title: one(p, 'title') } : {}),
        ...(one(p, 'summary') ? { summary: one(p, 'summary') } : {}),
        ...(one(p, 'project') ? { project: one(p, 'project') } : {}),
        ...(one(p, 'command') ? { command: one(p, 'command') } : {}),
      });
      ceoPrint(ctx, p, r);
      return (r as { status?: string }).status === 'refused' ? 1 : 0;
    }
    case 'backlog':
      return ceoBacklog(ctx, p, args);
    case 'topic': {
      const sub = args[0];
      if (sub !== 'propose' && sub !== 'list') throw new UsageError(CEO_USAGE);
      if (sub === 'propose' && (!one(p, 'question') || !one(p, 'area')))
        throw new UsageError('--area <area> and --question "<one generic question>" are required');
      const from = (one(p, 'from') ?? '')
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      const r = await rpc(ctx, 'ceo', {
        op: 'topic',
        sub,
        ...(one(p, 'question') ? { question: textFlag(ctx, p, 'question', true) as string } : {}),
        ...(one(p, 'area') ? { area: one(p, 'area') } : {}),
        ...(one(p, 'audience') ? { audience: one(p, 'audience') } : {}),
        from,
      });
      ceoPrint(ctx, p, r);
      return (r as { status?: string }).status === 'refused' ? 1 : 0;
    }
    case 'order': {
      const sub = args[0];
      if (sub === 'invoke') {
        const entryId = args[1];
        const conf = Number(one(p, 'confidence'));
        if (!entryId || !one(p, 'wake') || !one(p, 'why') || !Number.isFinite(conf))
          throw new UsageError(
            'usage: aom ceo order invoke <order id> --wake <wake id> --why "..." --confidence 0.0-1.0',
          );
        const r = await rpc(ctx, 'ceo', {
          op: 'order',
          sub,
          entryId,
          wake: one(p, 'wake'),
          why: one(p, 'why'),
          confidence: conf,
        });
        ceoPrint(ctx, p, r);
        return (r as { status?: string }).status === 'refused' ? 1 : 0;
      }
      if (sub === 'decline') {
        const r = await rpc(ctx, 'ceo', { op: 'order', sub, ask: textFlag(ctx, p, 'ask', true) as string });
        ceoPrint(ctx, p, r);
        return 0;
      }
      if (sub === 'done') {
        const file = one(p, 'commands-file');
        const r = await rpc(ctx, 'ceo', {
          op: 'order',
          sub,
          summary: textFlag(ctx, p, 'summary', true) as string,
          ...(file ? { commands: readCommands(ctx.readFile(file)) } : {}),
        });
        ceoPrint(ctx, p, r);
        return 0;
      }
      throw new UsageError(CEO_USAGE);
    }
    case 'dir': {
      if (args[0] !== 'add' || !args[1]) throw new UsageError('usage: aom ceo dir add <path>');
      ceoPrint(ctx, p, await rpc(ctx, 'ceo', { op: 'dir', sub: 'add', path: args.slice(1).join(' ') }));
      return 0;
    }
    // The use-the-system hook (PreToolUse on Edit|Write|NotebookEdit; see ceo/guard-hook.ts). Not for the model to call.
    case 'guard': {
      const r = runCeoGuardHook(ctx.readFile('-'), ctx.env.AOM_CEO_TURN_DIR);
      if (r.stderr) ctx.io.err(r.stderr);
      return r.exitCode;
    }
    case 'done':
      return report(
        ctx,
        outcome('ceo_done', 'Wake handled', { summary: textFlag(ctx, p, 'summary', true) as string }),
      );
    case 'report':
      return report(
        ctx,
        outcome('ceo_report', 'Daily report', { report: textFlag(ctx, p, 'summary', true) as string }),
      );
    default:
      throw new UsageError(CEO_USAGE);
  }
}

const VERBS: Record<string, Verb> = {
  /**
   * `aom deploy run <env> | trial --env <env> | status` (docs/design/ceo-front-door.md 9.6): the model's only deploy action is
   * to ASK Guildwise. It carries no credential and runs no deploy command: the server checks the approved recipe and the gate,
   * the recipe says who releases, and the workstation runs the script outside any model.
   */
  deploy: async (ctx, p) => {
    const sub = p.positionals[0];
    if (sub === 'probe') {
      // DevOps in a scan: fixed read-only probes, answered on this workstation (no ssh or docker command of its own)
      const r = (await rpc(ctx, 'deploy.probe', {
        ...(has(p, 'local') ? { local: true } : {}),
        ...(has(p, 'ssh-hosts') ? { sshHosts: true } : {}),
        ...(one(p, 'host') ? { host: one(p, 'host') } : {}),
        ...(one(p, 'target') ? { target: one(p, 'target') } : {}),
        ...(many(p, 'compose-file').length ? { composeFile: many(p, 'compose-file') } : {}),
        ...(many(p, 'dir').length ? { dir: many(p, 'dir') } : {}),
        ...(many(p, 'url').length ? { url: many(p, 'url') } : {}),
      })) as { ok?: boolean; error?: string };
      ctx.io.out(`${JSON.stringify(r, null, 2)}\n`);
      return r.ok === false ? 1 : 0;
    }
    if (sub !== 'run' && sub !== 'trial' && sub !== 'status')
      throw new UsageError(
        'usage: aom deploy run <env> [--project KEY] [--commit SHA] [--target NAME] | aom deploy trial --env <env> [--project KEY] | aom deploy status [--project KEY] [--run ID] | aom deploy probe --local | --ssh-hosts | --target <name> [--compose-file F] [--dir D] [--url U]',
      );
    const env = p.positionals[1] ?? one(p, 'env');
    if (sub !== 'status' && !env) throw new UsageError(`aom deploy ${sub}: name the environment`);
    const params: Record<string, unknown> = {
      ...(env ? { env } : {}),
      ...(one(p, 'project') ? { project: one(p, 'project') } : {}),
      ...(one(p, 'commit') ? { commit: one(p, 'commit') } : {}),
      ...(one(p, 'target') ? { target: one(p, 'target') } : {}),
      ...(one(p, 'reason') ? { reason: one(p, 'reason') } : {}),
      ...(one(p, 'run') ? { run: one(p, 'run') } : {}),
    };
    const r = (await rpc(ctx, `deploy.${sub}`, params)) as {
      message?: string;
      status?: string;
      runs?: Array<{ status?: string }>;
      result?: { runs?: Array<{ status?: string }> };
    };
    if (sub === 'status') {
      ctx.io.out(`${JSON.stringify(r, null, 2)}\n`);
      return 0;
    }
    ctx.io.out(`${r.message ?? JSON.stringify(r)}\n`);
    const runs = r.runs ?? r.result?.runs ?? [];
    return r.status === 'refused' || (runs.length > 0 && runs.every((x) => x.status === 'refused')) ? 1 : 0;
  },
  /** `aom recipe save --dir <scratch> --project KEY` (DevOps, in a recipe request): copy the drafted recipe into the project vault. */
  recipe: async (ctx, p) => {
    if (p.positionals[0] !== 'save' || !one(p, 'dir') || !one(p, 'project'))
      throw new UsageError('usage: aom recipe save --dir <scratch folder> --project KEY');
    const r = (await rpc(ctx, 'recipe.save', {
      dir: resolvePath(one(p, 'dir') as string),
      project: one(p, 'project'),
    })) as {
      message?: string;
      hash?: string;
      status?: string;
      lint?: Array<{ level: string; message: string }>;
    };
    ctx.io.out(`${r.message ?? 'Saved.'}\n`);
    if (r.hash) ctx.io.out(`recipe hash: ${r.hash} (${r.status ?? 'observed'})\n`);
    for (const l of r.lint ?? []) ctx.io.out(`lint ${l.level}: ${l.message}\n`);
    return (r.lint ?? []).some((l) => l.level === 'error') ? 1 : 0;
  },
  /**
   * `aom setup propose --area run --file <proposal.json>` (DevOps, in a "Scan with DevOps" request): submit what the scan found.
   * The server checks the proposal against its schema and answers with what is wrong, so it can be fixed and sent again.
   */
  setup: async (ctx, p) => {
    if (p.positionals[0] !== 'propose' || !one(p, 'file'))
      throw new UsageError('usage: aom setup propose --area run|deploy --file <proposal.json>');
    let proposal: unknown;
    try {
      proposal = JSON.parse(ctx.readFile(one(p, 'file') as string));
    } catch (err) {
      throw new UsageError(
        `the proposal file is not valid JSON: ${err instanceof Error ? err.message : err}`,
      );
    }
    const area = one(p, 'area');
    if (area !== undefined && proposal && typeof proposal === 'object')
      (proposal as Record<string, unknown>).area = area;
    const r = (await rpc(ctx, 'setup.propose', { proposal })) as { message?: string };
    ctx.io.out(`${r?.message ?? 'Proposal saved.'}\n`);
    return 0;
  },
  /** `aom runner restart [--reason ".."]`: restarts the runner after this reply (owner turns and DevOps shifts only). */
  runner: async (ctx, p) => {
    if (p.positionals[0] !== 'restart') throw new UsageError('usage: aom runner restart [--reason "<why>"]');
    const r = (await rpc(ctx, 'runner.restart', one(p, 'reason') ? { reason: one(p, 'reason') } : {})) as {
      message?: string;
    };
    ctx.io.out(`${r?.message ?? 'Restart scheduled after this reply.'}\n`);
    return 0;
  },
  /** The permission relay of a CEO owner turn: a stdio MCP server (see ceo/permission-relay.ts). Not for the model to call. */
  'ceo-permission-mcp': async (ctx) => {
    const relay = new PermissionRelay({
      mode: ctx.env.AOM_PERMISSION_MODE === 'order' ? 'order' : 'owner',
      rpc: async (params) => {
        try {
          return { ok: true, result: await rpc(ctx, 'ceo', params) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    });
    await relay.serve(process.stdin, (l) => ctx.io.out(l));
    return 0;
  },
  card: async (ctx, p) => {
    const sub = p.positionals[0];
    if (sub === 'create' || sub === 'update' || sub === 'specify') return cardDraft(ctx, p, sub);
    // `aom card facts [REF]` (Lean Team v3): what the server knows (environment, dependencies merged, branch, stage, blockers).
    if (sub === 'facts') {
      const r = await rpc(ctx, 'card.facts', p.positionals[1] ? { ref: p.positionals[1] } : {});
      ctx.io.out(`${JSON.stringify(r, null, 2)}\n`);
      return 0;
    }
    // `aom card show [REF]` / `aom card comment [REF] --note "<t>"` (a DevOps request filed for a card): that one card.
    if (sub === 'show') {
      const r = (await rpc(
        ctx,
        'card.get',
        p.positionals[1] ? { ref: p.positionals[1] } : { linked: true },
      )) as NonNullable<DevopsShift['card']> | undefined;
      ctx.io.out(`${JSON.stringify(r, null, 2)}\n`);
      return 0;
    }
    if (sub === 'comment') {
      const r = (await rpc(ctx, 'card.comment', {
        ...(p.positionals[1] ? { ref: p.positionals[1] } : {}),
        note: textFlag(ctx, p, 'note', true) as string,
      })) as { messageId?: string } | undefined;
      ctx.io.out(`Commented on the card.${r?.messageId ? ` (${r.messageId})` : ''}\n`);
      return 0;
    }
    // `aom card attach <path> [--card REF]` (the BA's intake chat) / `aom card attachments [REF]`: files on cards.
    if (sub === 'attach') {
      if (!p.positionals[1]) throw new UsageError('usage: aom card attach <path> [--card <REF>]');
      const card = one(p, 'card');
      const r = await rpc(ctx, 'card.attach', {
        path: resolvePath(p.positionals[1]),
        ...(card ? { ref: card } : {}),
      });
      ctx.io.out(`${typeof r === 'string' ? r : JSON.stringify(r)}\n`);
      return 0;
    }
    if (sub === 'attachments') {
      const ref = p.positionals[1] ?? one(p, 'card');
      const r = await rpc(ctx, 'card.attachments', ref ? { ref } : {});
      ctx.io.out(`${typeof r === 'string' ? r : JSON.stringify(r)}\n`);
      return 0;
    }
    // `aom card <REF>` (a BA task): a member card of the phase, read-only.
    if (sub) {
      ctx.io.out(`${JSON.stringify(await rpc(ctx, 'card.get', { ref: sub }), null, 2)}\n`);
      return 0;
    }
    const brief = (await rpc(ctx, 'card.get')) as ShiftBrief & {
      devops?: DevopsShift;
      question?: QuestionShift;
      baTask?: BaTaskShift;
    };
    if (has(p, 'json')) ctx.io.out(`${JSON.stringify(brief, null, 2)}\n`);
    else
      ctx.io.out(
        `${
          brief.devops
            ? renderDevopsPrompt(brief.devops)
            : brief.baTask
              ? renderBaTaskPrompt(brief.baTask)
              : brief.question
                ? renderQuestionPrompt(brief, brief.question)
                : renderShiftPrompt(brief)
        }\n`,
      );
    return 0;
  },
  // The platform architect triages a platform bug card: close it as invalid, or set the severity and the fix size.
  bug: async (ctx, p) => {
    if (p.positionals[0] !== 'triage')
      throw new UsageError(
        'usage: aom bug triage --invalid --reason "<why>"  |  aom bug triage --severity critical|degraded|minor [--size small|medium|large] [--reason "<one line>"]',
      );
    const result = await rpc(ctx, 'platform.triage', {
      ...(has(p, 'invalid') ? { invalid: true } : {}),
      ...(one(p, 'severity') ? { severity: one(p, 'severity') } : {}),
      ...(one(p, 'size') ? { size: one(p, 'size') } : {}),
      ...(one(p, 'reason') ? { reason: one(p, 'reason') } : {}),
    });
    ctx.io.out(
      `${typeof result === 'string' ? result : ((result as { message?: string } | null)?.message ?? JSON.stringify(result))}\n`,
    );
    return 0;
  },
  ledger: async (ctx, p) => {
    if (p.positionals[0] === 'retire') {
      const id = p.positionals[1];
      const reason = one(p, 'reason');
      if (!id || !reason)
        throw new UsageError(
          'usage: aom ledger retire <entry id> --reason "<why>" [--superseded-by <entry id>]',
        );
      const result = await rpc(ctx, 'ledger.retire', {
        id,
        reason,
        ...(one(p, 'superseded-by') ? { supersededBy: one(p, 'superseded-by') } : {}),
      });
      ctx.io.out(
        `${typeof result === 'string' ? result : ((result as { message?: string } | null)?.message ?? JSON.stringify(result))}\n`,
      );
      return 0;
    }
    if (p.positionals[0] !== 'search' || !p.positionals[1])
      throw new UsageError(
        'usage: aom ledger search "<query>" [--scope all|feature|decision|standing_order]',
      );
    const result = await rpc(ctx, 'ledger.search', {
      query: p.positionals[1],
      scope: one(p, 'scope') ?? 'all',
    });
    const entries = (result as { entries?: LedgerMatch[] } | null)?.entries;
    ctx.io.out(
      `${
        Array.isArray(entries)
          ? formatLedgerMatches(entries)
          : typeof result === 'string'
            ? result
            : JSON.stringify(result, null, 2)
      }\n`,
    );
    return 0;
  },
  comment: async (ctx, p) => report(ctx, { kind: 'comment', note: textFlag(ctx, p, 'note', true) as string }),
  question: async (ctx, p) => {
    const rec = one(p, 'recommend');
    const topic = one(p, 'topic');
    if (topic !== undefined && !(QUESTION_TOPICS as readonly string[]).includes(topic))
      throw new UsageError(`--topic must be one of ${QUESTION_TOPICS.join(', ')}`);
    const wait = one(p, 'wait');
    if (wait !== undefined && has(p, 'non-blocking'))
      throw new UsageError(
        '--wait and --non-blocking cannot be used together: --wait already keeps you working',
      );
    const base = {
      kind: 'question' as const,
      text:
        one(p, 'text') ??
        ((): never => {
          throw new UsageError('--text "<question>" is required');
        })(),
      options: many(p, 'option'),
      ...(rec !== undefined ? { recommend: Number(rec) } : {}),
      doing: one(p, 'doing') ?? '',
      blocking: !has(p, 'non-blocking'),
      force: has(p, 'force'),
      ...(topic ? { topic: topic as QuestionTopic } : {}),
      wait: false,
      converts: false,
    };
    if (wait === undefined) return report(ctx, base);
    return questionWait(
      ctx,
      base,
      wait === 'true' ? QUESTION_WAIT.defaultMinutes : (parseWaitDuration(wait) ?? 0),
    );
  },
  block: async (ctx, p) => {
    const usage = 'usage: aom block --on dependency <card-ref> [--card <REF>]';
    const on = one(p, 'on');
    if (on === undefined) throw new UsageError(usage);
    if (on !== 'dependency')
      throw new NotAvailable(
        `--on ${on} is not available yet: only \`--on dependency <card-ref>\` records a wait. For anything else ask with \`aom question --topic\``,
      );
    const ref = p.positionals[0];
    if (!ref) throw new UsageError(usage);
    const r = (await rpc(ctx, 'card.depend', {
      on: ref,
      ...(one(p, 'card') ? { card: one(p, 'card') } : {}),
    })) as { message?: string } | undefined;
    ctx.io.out(`${r?.message ?? 'Recorded.'}\n`);
    return 0;
  },
  handoff: async (ctx, p) => {
    const dataFile = one(p, 'data-file');
    const data = dataFile ? (JSON.parse(ctx.readFile(dataFile)) as Record<string, unknown>) : {};
    const evidence = buildEvidenceFlags(p);
    if (evidence) data.buildEvidence = evidence;
    return report(ctx, outcome('handoff', textFlag(ctx, p, 'note', true) as string, data));
  },
  /** `aom plan --note "<planning note>"` (planner): hands the card to the architect with the planning note. */
  plan: async (ctx, p) => report(ctx, outcome('planned', textFlag(ctx, p, 'note', true) as string)),
  /** `aom group set <id> [--card <REF>]` / `aom group clear [--card <REF>]` (planner, architect, BA). */
  group: async (ctx, p) => {
    const sub = p.positionals[0];
    const card = one(p, 'card');
    if (sub !== 'set' && sub !== 'clear')
      throw new UsageError('usage: aom group set <group id> [--card <REF>] | aom group clear [--card <REF>]');
    if (sub === 'set' && !p.positionals[1])
      throw new UsageError('usage: aom group set <group id> [--card <REF>]');
    const r = (await rpc(ctx, 'card.group', {
      ...(sub === 'set' ? { id: p.positionals[1] } : { clear: true }),
      ...(card ? { card } : {}),
    })) as { message?: string } | undefined;
    ctx.io.out(`${r?.message ?? 'Recorded.'}\n`);
    return 0;
  },
  /** `aom brief --text "<Card Brief>"` (planner, architect, BA): the short summary the builder reads. */
  brief: async (ctx, p) => {
    const r = (await rpc(ctx, 'card.brief', { text: textFlag(ctx, p, 'text', true) as string })) as
      | { message?: string }
      | undefined;
    ctx.io.out(`${r?.message ?? 'Recorded.'}\n`);
    return 0;
  },
  publish: async (ctx, p) => {
    const file = one(p, 'file');
    if (!file)
      throw new UsageError(
        'usage: aom publish --file <note.md> [--title "<title>"] [--citations-file <citations.json>] [--path <vault path>] [--note "<text>"]',
      );
    const citationsFile = one(p, 'citations-file');
    const parsed = citationsFile ? (JSON.parse(ctx.readFile(citationsFile)) as unknown) : [];
    const citations = Array.isArray(parsed)
      ? parsed
      : ((parsed as { citations?: unknown[] } | null)?.citations ?? []);
    const title = one(p, 'title');
    const path = one(p, 'path');
    const note =
      textFlag(ctx, p, 'note', false)?.trim() || `Published${title ? `: ${title}` : ' the research note'}`;
    return report(
      ctx,
      outcome('published', note, {
        content: ctx.readFile(file),
        citations,
        ...(title ? { title } : {}),
        ...(path ? { path } : {}),
      }),
    );
  },
  digest: async (ctx, p) => {
    const file = one(p, 'file');
    if (!file && !has(p, 'none'))
      throw new UsageError(
        'usage: aom digest --file <digest.json> [--note "<text>"]   (or --none when nothing qualifies)',
      );
    let data: Record<string, unknown> = { items: [] };
    if (file) {
      const parsed = JSON.parse(ctx.readFile(file)) as unknown;
      data = Array.isArray(parsed) ? { items: parsed } : (parsed as Record<string, unknown>);
    }
    const count = Array.isArray(data.items) ? data.items.length : 0;
    const note =
      textFlag(ctx, p, 'note', false)?.trim() || (count ? `Digest of ${count} item(s)` : 'Nothing qualified');
    return report(ctx, outcome('digest', note, data));
  },
  review: async (ctx, p) => {
    const sub = p.positionals[0];
    const note = textFlag(ctx, p, 'note', true) as string;
    // The risk call (backlog #70). Optional here so an older reviewer prompt still works; the runner refuses a reviewer
    // shift's report without it (see the supervisor).
    const riskData = reviewRiskData(ctx, p);
    if (sub === 'approve') return report(ctx, outcome('approve', note, { score: score(p), ...riskData }));
    if (sub === 'changes') {
      const reasons = many(p, 'reason')
        .flatMap((r) => r.split(','))
        .map((r) => r.trim())
        .filter(Boolean);
      if (reasons.length === 0) throw new UsageError('--reason <reason>[,<reason>] is required');
      return report(
        ctx,
        outcome('changes', note, {
          score: score(p),
          reasons,
          criteriaMissed: many(p, 'criteria-missed'),
          ...riskData,
        }),
      );
    }
    throw new UsageError('usage: aom review approve|changes ...');
  },
  test: async (ctx, p) => {
    const sub = p.positionals[0];
    if (sub === 'pass') {
      const text = textFlag(ctx, p, 'evidence', true) as string;
      const summary = text.slice(0, 1000);
      return report(
        ctx,
        outcome('pass', summary, {
          commands: many(p, 'command'),
          summary,
          outputExcerpt: text.slice(1000, 5000),
        }),
      );
    }
    if (sub === 'fail') {
      const title = one(p, 'title');
      if (!title) throw new UsageError('--title "<bug title>" is required');
      const note = textFlag(ctx, p, 'note', true) as string;
      const evidence = textFlag(ctx, p, 'evidence', false) ?? '';
      const rawScope = one(p, 'scope')?.replace('-', '_');
      if (rawScope !== undefined && rawScope !== 'product' && rawScope !== 'e2e_spec')
        throw new UsageError('--scope must be product or e2e-spec');
      const scope = rawScope as 'product' | 'e2e_spec' | undefined;
      return report(
        ctx,
        outcome('fail', note, {
          title,
          ...(scope ? { failureScope: scope } : {}),
          summary: note.slice(0, 1000),
          commands: many(p, 'command'),
          outputExcerpt: evidence.slice(0, 4000),
        }),
      );
    }
    if (sub === 'suite') {
      // The runner counts a JUnit report, attaches the log and records the result on the card (docs/design/run-and-integration-tests.md 4.6).
      const name = one(p, 'name');
      const status = one(p, 'status');
      if (!name || !status)
        throw new UsageError(
          'usage: aom test suite --name <suite> --status passed|failed|timeout|skipped [--junit <glob>] [--log <file>] [--passed N] [--failed N] [--skipped N] [--duration-ms N]',
        );
      const n = (k: string): number | undefined => {
        const v = one(p, k);
        if (v === undefined) return undefined;
        const x = Number(v);
        if (!Number.isInteger(x) || x < 0) throw new UsageError(`--${k} must be a whole number`);
        return x;
      };
      const r = (await rpc(ctx, 'test.suite', {
        name,
        status,
        ...(one(p, 'junit') ? { junit: one(p, 'junit') } : {}),
        ...(one(p, 'log') ? { log: one(p, 'log') } : {}),
        ...(n('passed') !== undefined ? { passed: n('passed') } : {}),
        ...(n('failed') !== undefined ? { failed: n('failed') } : {}),
        ...(n('skipped') !== undefined ? { skipped: n('skipped') } : {}),
        ...(n('duration-ms') !== undefined ? { durationMs: n('duration-ms') } : {}),
      })) as { message?: string } | null;
      ctx.io.out(`${r?.message ?? 'Recorded.'}\n`);
      return 0;
    }
    throw new UsageError('usage: aom test pass|fail|suite ...');
  },
  /** `aom env info|logs|restart|suites` (tester): the running environment of the card and the project's suites. */
  env: async (ctx, p) => {
    const sub = p.positionals[0] ?? 'info';
    const usage =
      'usage: aom env info | logs <service> [--lines N] | restart | suites | suites propose --name <suite> --cmd "<command>" [--kind integration|e2e] [--cwd <dir>] [--repo <name>] [--timeout <min>] [--junit <glob>] [--destructive]';
    const say = (m: string | undefined, dflt = ''): void => {
      const t = m ?? dflt;
      ctx.io.out(t.endsWith('\n') ? t : `${t}\n`);
    };
    if (sub === 'info') {
      say(((await rpc(ctx, 'env.info')) as { message?: string }).message);
      return 0;
    }
    if (sub === 'logs') {
      const service = p.positionals[1];
      if (!service) throw new UsageError(usage);
      const lines = one(p, 'lines');
      say(
        (
          (await rpc(ctx, 'env.logs', { service, ...(lines ? { lines: Number(lines) } : {}) })) as {
            message?: string;
          }
        ).message,
      );
      return 0;
    }
    if (sub === 'restart') {
      say(((await rpc(ctx, 'env.restart')) as { message?: string }).message);
      return 0;
    }
    if (sub === 'suites' && p.positionals[1] === 'propose') {
      const name = one(p, 'name');
      const cmd = one(p, 'cmd');
      if (!name || !cmd) throw new UsageError(usage);
      const r = (await rpc(ctx, 'env.suites.propose', {
        suites: [
          {
            name,
            cmd: parseCommandLine(cmd),
            kind: one(p, 'kind') ?? 'integration',
            ...(one(p, 'repo') ? { repo: one(p, 'repo') } : {}),
            ...(one(p, 'cwd') ? { cwd: one(p, 'cwd') } : {}),
            ...(one(p, 'timeout') ? { timeoutMin: Number(one(p, 'timeout')) } : {}),
            ...(one(p, 'junit') ? { junit: one(p, 'junit') } : {}),
            destructive: has(p, 'destructive'),
          },
        ],
      })) as { message?: string };
      say(r.message, 'Proposed.');
      return 0;
    }
    if (sub === 'suites') {
      const r = (await rpc(ctx, 'env.suites')) as {
        mode: string;
        flakyRetry: number;
        suites: Array<{
          name: string;
          kind: string;
          cmd: string[];
          cwd: string;
          confirmed: boolean;
          timeoutMin: number;
          destructive: boolean;
          junit?: string;
        }>;
      };
      if (r.suites.length === 0) {
        say(
          'No suites are set for this project. Read TESTING.md, BUILD.md and the test config, then propose what you find with `aom env suites propose`.',
        );
        return 0;
      }
      for (const s of r.suites)
        say(
          `${s.confirmed ? '[required]' : '[proposed]'} ${s.name} (${s.kind}${s.destructive ? ', destructive' : ''}, at most ${s.timeoutMin} min): ${formatCommandLine(s.cmd)} in ${s.cwd}${s.junit ? `, report ${s.junit}` : ''}`,
        );
      return 0;
    }
    throw new UsageError(usage);
  },
  devops: async (ctx, p) => {
    const text = p.positionals[0] ?? one(p, 'text');
    if (!text?.trim()) throw new UsageError('usage: aom devops "<what you need from the DevOps engineer>"');
    const r = (await rpc(ctx, 'devops.request', { text })) as { requestId?: string; message?: string };
    ctx.io.out(
      `${r.message ?? 'Request sent to the DevOps engineer.'}${r.requestId ? ` (request ${r.requestId})` : ''}\n`,
    );
    return 0;
  },
  repo: async (ctx, p) => {
    const usage =
      'usage: aom repo create [--provider github|gitlab|azure-devops|bitbucket-cloud] [--host <host>] --name <name> --private|--public --project <KEY> [--description "<text>"]\n  name: owner/repo (github) | group[/subgroup]/project (gitlab) | organization/project/repo (azure-devops) | workspace/repo (bitbucket-cloud)';
    if (p.positionals[0] !== 'create') throw new UsageError(usage);
    const name = one(p, 'name');
    const project = one(p, 'project');
    if (!name || !project || has(p, 'private') === has(p, 'public')) throw new UsageError(usage);
    const description = one(p, 'description');
    const provider = one(p, 'provider');
    const host = one(p, 'host');
    const r = (await rpc(ctx, 'repo.create', {
      name,
      project,
      ...(provider ? { provider } : {}),
      ...(host ? { host } : {}),
      visibility: has(p, 'public') ? 'public' : 'private',
      ...(description ? { description } : {}),
    })) as { message?: string; requestId?: string };
    ctx.io.out(`${r.message ?? 'Asked the project owner to approve creating the repository.'}\n`);
    return 0;
  },
  /**
   * `aom git status [<provider>]` / `aom git connect <provider> [--host <h>]` (the DevOps engineer): the runner checks or
   * starts this workstation's login to a git host. A browser login prints a URL and code for the user; a login that
   * needs a secret is never typed by the agent (it tells the user to run `aom-runner git-connect`).
   */
  git: async (ctx, p) => {
    const usage =
      'usage: aom git status [<provider>] [--host <host>] | aom git connect <github|gitlab|azure-devops|bitbucket-cloud> [--host <host>]\n       aom git fetch | merge-main | verify-merge   (the architect: the runner fetches origin, merges the latest main, checks a conflict resolution; agents never push)';
    const sub = p.positionals[0];
    const host = one(p, 'host');
    // Agents never push (backlog #61): the runner lands the work, and pushes a branch only for a pull request.
    if (sub === 'push')
      throw new UsageError(
        'aom git push is not available: agents never push. The card branch stays on this workstation and the runner lands your work when the card finishes',
      );
    // The architect's git is run by the runner (the agent's own shell cannot fetch).
    if (sub === 'fetch' || sub === 'merge-main' || sub === 'verify-merge') {
      const method = `git.${sub.replace('-', '_')}`;
      const r = (await rpc(ctx, method, {})) as {
        message?: string;
      };
      ctx.io.out(`${r?.message ?? 'Done.'}\n`);
      return 0;
    }
    if (sub !== 'status' && sub !== 'connect') throw new UsageError(usage);
    const provider = p.positionals[1];
    if (sub === 'connect' && !provider) throw new UsageError(usage);
    const r = (await rpc(ctx, `git.${sub}`, {
      ...(provider ? { provider } : {}),
      ...(host ? { host } : {}),
    })) as { message?: string };
    ctx.io.out(`${r.message ?? 'Done.'}\n`);
    return 0;
  },
  'devops-approval': async (ctx, p) => {
    const action = one(p, 'action');
    const reason = one(p, 'reason');
    if (!action || !reason)
      throw new UsageError(
        'usage: aom devops-approval --action "<action>" --reason "<why>" [--command "<cmd>"]...',
      );
    return report(
      ctx,
      outcome('devops_approval', `Needs approval: ${action}`, {
        action,
        reason,
        commands: many(p, 'command'),
      }),
    );
  },
  'devops-question': async (ctx, p) => {
    const text = one(p, 'text');
    const reason = one(p, 'reason');
    if (!text || !reason)
      throw new UsageError(
        'usage: aom devops-question --text "<question>" --reason "<what you checked, the options>"',
      );
    // The server tells a question from an approval by the "Question:" prefix of the action.
    return report(
      ctx,
      outcome('devops_approval', `Question: ${text}`, {
        action: `Question: ${text.replace(/^\s*question:\s*/i, '')}`,
        reason,
        commands: [],
      }),
    );
  },
  /**
   * The DevOps guard hook (a Claude Code PreToolUse hook on Bash, see devops/guard.ts): reads the hook input on stdin,
   * records the command through the runner and prints the permission decision. Not listed in `aom help`: agents never call it.
   */
  'devops-guard': async (ctx) => {
    const r = await runGuardHook({
      stdin: ctx.readFile('-'),
      cfg: loadGuardConfig(ctx.env.AOM_DEVOPS_GUARD),
      report: async (entries) => {
        try {
          await rpc(ctx, 'devops.audit', { entries });
          return true;
        } catch {
          return false;
        }
      },
    });
    if (r.stdout) ctx.io.out(r.stdout);
    return r.code;
  },
  /** The `Skill` tool allow-list (a Claude Code PreToolUse hook, see capabilities/skill-guard.ts). Agents never call it. */
  'skill-guard': async (ctx) => {
    // Claude Code treats every hook exit code but 2 as "the hook failed, carry on": an error here must block, not allow.
    try {
      const r = runSkillGuard({
        stdin: ctx.readFile('-'),
        cfg: loadSkillGuardConfig(ctx.env.AOM_SKILL_GUARD),
      });
      if (r.stdout) ctx.io.out(r.stdout);
      return r.code;
    } catch (err) {
      ctx.io.err(
        `skill guard failed, the skill call is refused: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }
  },
  'devops-done': async (ctx, p) => {
    const summary = textFlag(ctx, p, 'summary', true) as string;
    return report(ctx, outcome('devops_done', summary, { summary, commands: many(p, 'command') }));
  },
  /**
   * `aom hygiene run` (the DevOps engineer, repository hygiene request): tidies the repositories of the request with
   * deterministic git (commit to the confirmed working branch, pull, push, delete merged agent branches), reports what it
   * could not resolve and ends the request like `aom devops-done`.
   */
  hygiene: async (ctx, p) => {
    if (p.positionals[0] !== 'run') throw new UsageError('usage: aom hygiene run [--note "<text>"]');
    const brief = (await rpc(ctx, 'card.get')) as { devops?: DevopsShift };
    const spec = brief.devops?.hygiene;
    if (!spec) throw new UsageError('this request is not a repository hygiene request: nothing to run');
    // Repositories with a running card shift are left for the next run (hygiene moves refs in the shared .git).
    let busy: string[] = [];
    try {
      busy = ((await rpc(ctx, 'hygiene.busy_worktrees')) as { worktrees?: string[] }).worktrees ?? [];
    } catch {
      // older runner: no deferral
    }
    // Pull request states come from the runner (it holds the git host logins); without it the branches of cards that
    // went through a pull request are judged by their commits alone.
    const changeState: ChangeStateLookup = async (q) => {
      try {
        const r = (await rpc(ctx, 'hygiene.change_state', q)) as {
          state?: 'open' | 'merged' | 'closed' | null;
        };
        return r.state ?? null;
      } catch {
        return null;
      }
    };
    const run = await runHygiene(spec, busy, { changeState });
    const note = textFlag(ctx, p, 'note', false)?.trim();
    const summary = `${run.summary}${note ? `\n\n${note}` : ''}`;
    ctx.io.out(`${summary}\n`);
    return report(
      ctx,
      outcome('devops_done', summary, { summary, commands: run.commands, hygiene: run.report }),
    );
  },
  answer: async (ctx, p) => {
    const itemId = one(p, 'item');
    if (!itemId)
      throw new UsageError(
        'usage: aom answer --item <id> --text "<answer>" [--option <option id>] [--keep-blocked-until "<condition>"]',
      );
    const optionId = one(p, 'option');
    const keep = one(p, 'keep-blocked-until');
    return report(ctx, {
      kind: 'answer',
      itemId,
      text: textFlag(ctx, p, 'text', true) as string,
      ...(optionId ? { optionId } : {}),
      ...(keep?.trim() ? { keepBlockedUntil: keep.trim() } : {}),
    });
  },
  escalate: async (ctx, p) => {
    const itemId = one(p, 'item');
    if (!itemId)
      throw new UsageError(
        'usage: aom escalate --item <id> --note "<what you checked, what must be decided>"',
      );
    return report(ctx, { kind: 'escalate', itemId, note: textFlag(ctx, p, 'note', true) as string });
  },
  finalize: async (ctx, p) => {
    if (one(p, 'action') !== undefined)
      throw new UsageError(
        'agents may not choose the completion action: finalize runs the card\'s own completion action (set by a person on the card, else the project\'s default). Run `aom finalize --note "<note>"` without --action. If the card should land differently, say so in the conversation and ask the manager to change it on the card page.',
      );
    const note = textFlag(ctx, p, 'note', false)?.trim() || 'Finalize';
    return report(ctx, outcome('finalized', note, {}));
  },
  /** BA (batch intake): the terminal command of a ticket of a batch: `aom batch done|ask|skip|fail`. */
  batch: async (ctx, p) => {
    const sub = p.positionals[0];
    const usage =
      'usage: aom batch done --note "<cards created>" | ask --text "<question>" [--option "<a>"]... [--recommend <n>] | skip --note "<why>" | fail --note "<why>"';
    if (sub === 'ask') {
      const rec = one(p, 'recommend');
      return report(
        ctx,
        outcome('batch_ask', one(p, 'text') ?? '', {
          question:
            one(p, 'text') ??
            ((): never => {
              throw new UsageError('--text "<question>" is required');
            })(),
          options: many(p, 'option'),
          ...(rec !== undefined ? { recommend: Number(rec) } : {}),
        }),
      );
    }
    const id = { done: 'batch_done', skip: 'batch_skip', fail: 'batch_fail' }[sub ?? ''];
    if (!id) throw new UsageError(usage);
    const note = textFlag(ctx, p, 'note', sub !== 'done') ?? '';
    return report(ctx, outcome(id, note, {}));
  },
  intake: async (ctx, p) => {
    const sub = p.positionals[0];
    if (sub === 'map') {
      const project = one(p, 'project');
      if (!project) throw new UsageError('usage: aom intake map --project <KEY>');
      const r = (await rpc(ctx, 'intake.map', { project })) as { project?: string; repos?: string[] };
      ctx.io.out(
        `Mapped to project ${r.project}${r.repos?.length ? ` (repos: ${r.repos.join(', ')})` : ''}.\n`,
      );
      return 0;
    }
    if (sub === 'unmapped') {
      const r = (await rpc(ctx, 'intake.unmapped', { note: textFlag(ctx, p, 'note', true) as string })) as {
        message?: string;
      };
      ctx.io.out(`${r.message ?? 'Asked the manager.'}\n`);
      return 0;
    }
    throw new UsageError('usage: aom intake map --project <KEY> | aom intake unmapped --note "<why>"');
  },
  /** Architect: `aom design --report <path> --summary "<text>"` hands a designed card to build. */
  design: async (ctx, p) => investigationReport(ctx, p, 'handoff', 'design'),
  /** Architect: `aom investigate --report <path> --summary "<text>"` ends an investigation-only card's investigation. */
  investigate: async (ctx, p) => investigationReport(ctx, p, 'report', 'investigate'),
  /** BA: `aom investigation record --title "<t>" --summary-file <md> [--decision]` records an investigation-only card's result. */
  investigation: async (ctx, p) => {
    const usage =
      'usage: aom investigation record --title "<what was investigated>" --summary-file <summary.md> | --summary "<text>" [--decision]';
    if (p.positionals[0] !== 'record') throw new UsageError(usage);
    const title = one(p, 'title');
    if (!title?.trim()) throw new UsageError(usage);
    const r = (await rpc(ctx, 'investigation.record', {
      title,
      summary: textFlag(ctx, p, 'summary', true) as string,
      decision: has(p, 'decision'),
    })) as { message?: string } | null;
    ctx.io.out(`${r?.message ?? 'Recorded.'}\n`);
    return 0;
  },
  outbound: async (ctx, p) => {
    if (p.positionals[0] !== 'draft')
      throw new UsageError('usage: aom outbound draft --kind <comment|resolution|decision> --body "<text>"');
    const kind = one(p, 'kind') ?? 'resolution';
    if (kind !== 'comment' && kind !== 'resolution' && kind !== 'decision')
      throw new UsageError('--kind is comment, resolution or decision');
    const r = (await rpc(ctx, 'outbound.draft', { kind, body: textFlag(ctx, p, 'body', true) })) as {
      message?: string;
    };
    ctx.io.out(`${r.message ?? 'Drafted. The manager approves it on the desk.'}\n`);
    return 0;
  },
  risk: async (ctx, p) => {
    const tier = p.positionals[0];
    if (tier !== 'small' && tier !== 'large')
      throw new UsageError('usage: aom risk <small|large> --reason "<why>"');
    const r = (await rpc(ctx, 'card.risk', { tier, reason: textFlag(ctx, p, 'reason', true) })) as {
      message?: string;
    };
    ctx.io.out(`${r.message ?? `Risk tier set to ${tier}.`}\n`);
    return 0;
  },
  org: async (ctx, p) => orgDesign(ctx, p),
  phase: async (ctx, p) => phaseVerb(ctx, p),
  report: async (ctx, p) => reportVerb(ctx, p),
  /** `aom sudo -- <command> [args...]` (DevOps engineer): the runner runs it with administrator rights. */
  sudo: async (ctx, p) => {
    if (p.positionals.length === 0) throw new UsageError('usage: aom sudo -- <command> [args...]');
    const r = (await rpc(ctx, 'sudo.run', { argv: p.positionals })) as {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
    if (r.stdout) ctx.io.out(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
    if (r.stderr) ctx.io.err(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
    return r.exitCode === 0 ? 0 : 1;
  },
  /** `aom run info|status|logs|step|service|ready|fail` (DevOps engineer of a "run this branch" request): the runner starts and supervises the services. */
  run: async (ctx, p) => {
    const sub = p.positionals[0];
    const usage =
      'usage: aom run info | status | logs <service|step> [--lines N] | step --name "<n>" [--repo <r>] [--cwd <dir>] [--timeout <s>] [--env K=V]... -- <cmd...> | step --name "<n>" --wait | service --name <n> [--repo <r>] [--cwd <dir>] [--port name:default[:ENV_VAR]]... [--health <url|tcp:port|log:regex|none[:s]>] [--env-file <abs path>] [--env K=V]... [--after <svc>]... [--start-timeout <s>] [--stop-cmd "<cmd>"] -- <cmd...> | ready [--notes "<t>"] | fail --reason "<why>"   (add --env-id <id> only to name another environment)';
    if (!sub) throw new UsageError(usage);
    const cmd = p.flags.get(RUN_CMD_FLAG);
    const base: Record<string, unknown> = one(p, 'env-id') ? { env: one(p, 'env-id') } : {};
    const kv = (list: string[]): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const e of list) {
        const i = e.indexOf('=');
        if (i < 1) throw new UsageError(`--env needs KEY=VALUE, got "${e}"`);
        out[e.slice(0, i)] = e.slice(i + 1);
      }
      return out;
    };
    let method: RpcMethod;
    let params: Record<string, unknown> = base;
    if (sub === 'info' || sub === 'status') method = sub === 'info' ? 'run.info' : 'run.status';
    else if (sub === 'logs') {
      method = 'run.logs';
      const service = p.positionals[1];
      if (!service) throw new UsageError(usage);
      params = { ...base, service, ...(one(p, 'lines') ? { lines: Number(one(p, 'lines')) } : {}) };
    } else if (sub === 'step') {
      method = 'run.step';
      const name = one(p, 'name');
      if (!name) throw new UsageError(usage);
      if (!cmd?.length && !has(p, 'wait')) throw new UsageError(usage);
      params = {
        ...base,
        name,
        ...(one(p, 'repo') ? { repo: one(p, 'repo') } : {}),
        ...(one(p, 'cwd') ? { cwd: one(p, 'cwd') } : {}),
        ...(cmd?.length ? { cmd } : {}),
        ...(one(p, 'timeout') ? { timeoutSec: Number(one(p, 'timeout')) } : {}),
        ...(one(p, 'when') ? { when: one(p, 'when') } : {}),
        env: kv(many(p, 'env')),
        wait: has(p, 'wait'),
      };
    } else if (sub === 'service') {
      method = 'run.service';
      const name = one(p, 'name');
      if (!name || !cmd?.length) throw new UsageError(usage);
      const stop = one(p, 'stop-cmd');
      params = {
        ...base,
        name,
        ...(one(p, 'repo') ? { repo: one(p, 'repo') } : {}),
        ...(one(p, 'cwd') ? { cwd: one(p, 'cwd') } : {}),
        cmd,
        ports: many(p, 'port').map((s) => parseRunPort(s)),
        ...(one(p, 'health') ? { health: parseRunHealth(one(p, 'health') as string) } : {}),
        ...(one(p, 'env-file') ? { envFile: one(p, 'env-file') } : {}),
        env: kv(many(p, 'env')),
        after: many(p, 'after'),
        ...(one(p, 'start-timeout') ? { startTimeoutSec: Number(one(p, 'start-timeout')) } : {}),
        ...(stop ? { stopCmd: parseCommandLine(stop) } : {}),
        docker: has(p, 'docker'),
      };
    } else if (sub === 'ready') {
      method = 'run.ready';
      params = { ...base, notes: textFlag(ctx, p, 'notes', false) ?? '' };
    } else if (sub === 'fail') {
      method = 'run.fail';
      params = { ...base, reason: textFlag(ctx, p, 'reason', true) };
    } else throw new UsageError(usage);
    const r = (await rpc(ctx, method, params)) as { message?: string; exitCode?: number } | null;
    if (r?.message) ctx.io.out(r.message.endsWith('\n') ? r.message : `${r.message}\n`);
    return r?.exitCode ?? 0;
  },
  /** `aom toolchain list|add|remove`: tools sandboxed agents may use (the DevOps engineer registers what it installed). */
  toolchain: async (ctx, p) => {
    const sub = p.positionals[0] ?? 'list';
    const usage =
      'usage: aom toolchain list | add <name> --bin <dir> [--bin <dir>]... [--read <dir>]... [--env KEY=VALUE]... | remove <name>';
    if (sub === 'list') {
      const r = (await rpc(ctx, 'toolchain.list')) as { text?: string };
      ctx.io.out(`${r.text ?? ''}\n`);
      return 0;
    }
    const name = p.positionals[1];
    if (!name || (sub !== 'add' && sub !== 'remove')) throw new UsageError(usage);
    if (sub === 'remove') {
      const r = (await rpc(ctx, 'toolchain.remove', { name })) as { message?: string };
      ctx.io.out(`${r.message ?? 'Removed.'}\n`);
      return 0;
    }
    const env: Record<string, string> = {};
    for (const kv of many(p, 'env')) {
      const i = kv.indexOf('=');
      if (i < 1) throw new UsageError(`--env needs KEY=VALUE, got "${kv}"`);
      env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const r = (await rpc(ctx, 'toolchain.add', {
      name,
      bin: many(p, 'bin'),
      read: many(p, 'read'),
      env,
    })) as {
      message?: string;
    };
    ctx.io.out(`${r.message ?? 'Registered.'}\n`);
    return 0;
  },
  /**
   * `aom graph query|path|explain|impact`: the map of the project's code (docs/design/project-graphs.md section 7). The
   * runner answers from the project vault on this workstation; every answer is capped and tags each link.
   */
  graph: async (ctx, p) => {
    const sub = p.positionals[0];
    const usage =
      'usage: aom graph query "<words>" [--budget <tokens>] | graph path <a> <b> | graph explain <node> | graph impact <file or symbol> [--depth <1-4>]';
    const int = (name: string): number | undefined => {
      const v = one(p, name);
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} needs a whole number of at least 1`);
      return n;
    };
    let method: string;
    let params: Record<string, unknown>;
    if (sub === 'query' && p.positionals[1]) {
      method = 'graph.query';
      params = {
        text: p.positionals.slice(1).join(' '),
        ...(int('budget') ? { budget: int('budget') } : {}),
      };
    } else if (sub === 'path' && p.positionals[1] && p.positionals[2]) {
      method = 'graph.path';
      params = { a: p.positionals[1], b: p.positionals[2] };
    } else if (sub === 'explain' && p.positionals[1]) {
      method = 'graph.explain';
      params = { node: p.positionals[1] };
    } else if (sub === 'impact' && p.positionals[1]) {
      method = 'graph.impact';
      params = { node: p.positionals[1], ...(int('depth') ? { depth: int('depth') } : {}) };
    } else throw new UsageError(usage);
    const r = (await rpc(ctx, method, params)) as { text?: string } | null;
    ctx.io.out(`${r?.text ?? 'no answer'}\n`);
    return 0;
  },
  transcript: async (ctx, p) => {
    const url = one(p, 'url');
    if (!url) throw new UsageError('usage: aom transcript --url <video or podcast URL>');
    const r = (await rpc(ctx, 'transcript.fetch', { url })) as { message?: string } | null;
    ctx.io.out(`${r?.message ?? 'no transcript available'}\n`);
    return 0;
  },
  source: async (ctx, p) => {
    const sub = p.positionals[0];
    // `aom source attachments <KEY>` lists a Jira ticket's files; `aom source attachment <KEY> [<filename|id> | --all]`
    // has the runner download them (with its own Jira credentials) into your scratch dir and prints the local paths.
    if (sub === 'attachments' || sub === 'attachment') {
      const key = p.positionals[1] ?? one(p, 'key');
      if (!key)
        throw new UsageError(
          sub === 'attachments'
            ? 'usage: aom source attachments <ABC-123>'
            : 'usage: aom source attachment <ABC-123> [<filename|id> | --all]',
        );
      const r = await rpc(
        ctx,
        sub === 'attachments' ? 'source.attachments' : 'source.attachment',
        sub === 'attachments'
          ? { key }
          : { key, ...(p.positionals[2] ? { name: p.positionals[2] } : {}), all: has(p, 'all') },
      );
      ctx.io.out(`${typeof r === 'string' ? r : JSON.stringify(r, null, 2)}\n`);
      return 0;
    }
    if (sub !== 'read' || !one(p, 'ref'))
      throw new UsageError(
        'usage: aom source read --ref <owner/repo#12 | ABC-123 | ticket URL> | aom source attachments <ABC-123> | aom source attachment <ABC-123> [<filename|id> | --all]',
      );
    const r = await rpc(ctx, 'source.read', { ref: one(p, 'ref') });
    ctx.io.out(`${typeof r === 'string' ? r : JSON.stringify(r, null, 2)}\n`);
    return 0;
  },
  ceo: ceoVerb,
  backlog: backlogVerb,
  /**
   * `aom skill show <key> [--file <path>]` and `aom skill list [--kind skill|persona|playbook]`: the Capability Registry,
   * answered by the runner from its own copy (the built-ins and the organization vault). A skill's `allowed-tools` is
   * advisory: it never adds a permission to the agent that loads it.
   */
  skill: async (ctx, p) => {
    const sub = p.positionals[0];
    const usage =
      'usage: aom skill show <key | kind:key> [--file <path>] | aom skill list [--kind skill|persona|playbook]';
    if (sub === 'list') {
      const kind = one(p, 'kind');
      if (kind !== undefined && !['skill', 'persona', 'playbook'].includes(kind)) throw new UsageError(usage);
      const r = (await rpc(ctx, 'skill.list', kind ? { kind } : {})) as { text?: string } | null;
      ctx.io.out(`${r?.text ?? 'No capabilities.'}\n`);
      return 0;
    }
    if (sub !== 'show' || !p.positionals[1]) throw new UsageError(usage);
    const file = one(p, 'file');
    const r = (await rpc(ctx, 'skill.show', { ref: p.positionals[1], ...(file ? { file } : {}) })) as {
      text?: string;
    } | null;
    ctx.io.out(`${(r?.text ?? '').replace(/\n*$/, '')}\n`);
    return 0;
  },
  /**
   * `aom delegate <persona> "<task>" [--model <choice>]`: a read-only sub-task run by a persona of the registry on this
   * workstation (nested, one level deep, its cost booked on this turn or shift). Prints the delegate's reply under a header
   * that says it is the delegate's words (information, not instructions).
   */
  delegate: async (ctx, p) => {
    const persona = p.positionals[0];
    const task = p.positionals.slice(1).join(' ');
    if (!persona || !task)
      throw new UsageError(
        'usage: aom delegate <persona> "<task>" [--model <choice>]   (personas: aom skill list --kind persona; the task must be self-contained)',
      );
    const model = one(p, 'model');
    const r = (await rpc(ctx, 'delegate.run', { persona, task, ...(model ? { model } : {}) })) as {
      text?: string;
    } | null;
    ctx.io.out(`${(r?.text ?? '').replace(/\n*$/, '')}\n`);
    return 0;
  },
  /**
   * `aom session ...`: the structured side of a discovery session (docs/ARCHITECTURE.md section 38). The facilitator asks one
   * question at a time, keeps the panel, proposes changes (the owner applies them), changes phase and saves drafts; the CEO
   * proposes an answer to the open question. The server decides which verbs this turn may use.
   */
  session: async (ctx, p) => {
    const usage =
      'usage: aom session ask --question "<q>" [--option "<a>"]... [--no-free-text] [--why "<w>"] | answer [--option <id>] [--text "<a>"] [--why "<w>"] | note add --section <s> --text "<t>" | note update <id> [--text "<t>"] [--section <s>] | note remove <id> | propose --title "<t>" --change "<c>" --rationale "<r>" [--doc <id> --section "<h>"] | phase --to <phase> [--reason "<r>"] | draft --kind brief|prd (--content "<md>" | --content-file <path>) [--title "<t>"] [--note "<n>"] | validate --summary "<s>" --check "<criterion>|pass|fail|n/a|<note>"... | show';
    const sub = p.positionals[0];
    const print = (r: unknown): number => {
      const x = r as { message?: string; text?: string } | null;
      ctx.io.out(`${(x?.text ?? x?.message ?? 'Done.').replace(/\n*$/, '')}\n`);
      return 0;
    };
    const opt = (key: string): string | undefined => {
      const v = one(p, key);
      return v === undefined || !v.trim() ? undefined : v.trim();
    };
    switch (sub) {
      case 'show':
        return print(await rpc(ctx, 'session.show'));
      case 'ask': {
        const question = textFlag(ctx, p, 'question', true) as string;
        return print(
          await rpc(ctx, 'session.ask', {
            question: question.trim(),
            options: many(p, 'option'),
            allowFreeText: !has(p, 'no-free-text'),
            ...(opt('why') ? { why: opt('why') } : {}),
          }),
        );
      }
      case 'answer': {
        const text =
          one(p, 'text') ??
          (one(p, 'text-file') !== undefined ? ctx.readFile(one(p, 'text-file') as string) : undefined);
        if (opt('option') === undefined && !text?.trim()) throw new UsageError(usage);
        return print(
          await rpc(ctx, 'session.answer', {
            ...(opt('option') ? { option: opt('option') } : {}),
            ...(text?.trim() ? { text: text.trim() } : {}),
            ...(opt('why') ? { why: opt('why') } : {}),
          }),
        );
      }
      case 'note': {
        const op = p.positionals[1];
        if (op === 'add') {
          const text = textFlag(ctx, p, 'text', true) as string;
          if (!opt('section')) throw new UsageError(usage);
          return print(
            await rpc(ctx, 'session.note', { op: 'add', section: opt('section'), text: text.trim() }),
          );
        }
        if (op === 'update' || op === 'remove') {
          const id = p.positionals[2];
          if (!id) throw new UsageError(usage);
          const text = textFlag(ctx, p, 'text', false);
          if (op === 'update' && !text?.trim() && !opt('section')) throw new UsageError(usage);
          return print(
            await rpc(ctx, 'session.note', {
              op,
              id,
              ...(op === 'update' && text?.trim() ? { text: text.trim() } : {}),
              ...(op === 'update' && opt('section') ? { section: opt('section') } : {}),
            }),
          );
        }
        throw new UsageError(usage);
      }
      case 'propose': {
        const title = opt('title');
        const change = textFlag(ctx, p, 'change', true) as string;
        const rationale = textFlag(ctx, p, 'rationale', true) as string;
        if (!title) throw new UsageError(usage);
        return print(
          await rpc(ctx, 'session.propose', {
            title,
            change: change.trim(),
            rationale: rationale.trim(),
            ...(opt('doc') ? { doc: opt('doc') } : {}),
            ...(opt('section') ? { section: opt('section') } : {}),
          }),
        );
      }
      case 'phase': {
        if (!opt('to')) throw new UsageError(usage);
        return print(
          await rpc(ctx, 'session.phase', {
            to: opt('to'),
            ...(opt('reason') ? { reason: opt('reason') } : {}),
          }),
        );
      }
      case 'draft': {
        const kind = opt('kind');
        if (kind !== 'brief' && kind !== 'prd') throw new UsageError(usage);
        const file = one(p, 'file');
        const content =
          one(p, 'content') ??
          (one(p, 'content-file') !== undefined
            ? ctx.readFile(one(p, 'content-file') as string)
            : undefined) ??
          (file !== undefined ? ctx.readFile(file) : undefined);
        if (!content?.trim()) throw new UsageError(usage);
        return print(
          await rpc(ctx, 'session.draft', {
            kind,
            content,
            ...(opt('title') ? { title: opt('title') } : {}),
            ...(opt('note') ? { note: opt('note') } : {}),
          }),
        );
      }
      case 'validate': {
        const items = many(p, 'check');
        if (!items.length) throw new UsageError(usage);
        return print(await rpc(ctx, 'session.validate', { summary: opt('summary') ?? '', items }));
      }
      default:
        throw new UsageError(usage);
    }
  },
  /**
   * `aom board ...`: the structured side of a boardroom session (docs/ARCHITECTURE.md section 38.2). Speakers put sticky notes
   * on the whiteboard and record disagreements; the Chair chooses the next speakers, flags early agreement and pauses for a
   * decision; the cast turn suggests voices; the minutes turn saves the synthesis. The server decides which verbs a turn may use.
   */
  board: async (ctx, p) => {
    const usage =
      'usage: aom board add --column ideas|risks|questions|decisions|parked --text "<t>" | next --speaker <handle>... --reason "<r>" [--instruction "<i>"] | pause --question "<q>" [--option "<a>"]... | converge --note "<n>" | disagreement add --topic "<t>" --position "<Name>|<view>"... | cast (--persona <key> | --name "<n>" --brief "<one line>") [--seat "<s>"] [--why "<w>"] | minutes (--content "<md>" | --content-file <path>) | show';
    const sub = p.positionals[0];
    const print = (r: unknown): number => {
      const x = r as { message?: string; text?: string } | null;
      ctx.io.out(`${(x?.text ?? x?.message ?? 'Done.').replace(/\n*$/, '')}\n`);
      return 0;
    };
    const opt = (key: string): string | undefined => {
      const v = one(p, key);
      return v === undefined || !v.trim() ? undefined : v.trim();
    };
    switch (sub) {
      case 'show':
        return print(await rpc(ctx, 'board.show'));
      case 'add': {
        const text = textFlag(ctx, p, 'text', true) as string;
        if (!opt('column')) throw new UsageError(usage);
        return print(await rpc(ctx, 'board.add', { column: opt('column'), text: text.trim() }));
      }
      case 'next': {
        const speakers = many(p, 'speaker').filter((x) => x.trim());
        if (!speakers.length || !opt('reason')) throw new UsageError(usage);
        return print(
          await rpc(ctx, 'board.next', {
            speakers,
            reason: opt('reason'),
            ...(opt('instruction') ? { instruction: opt('instruction') } : {}),
          }),
        );
      }
      case 'pause': {
        if (!opt('question')) throw new UsageError(usage);
        return print(
          await rpc(ctx, 'board.pause', { question: opt('question'), options: many(p, 'option') }),
        );
      }
      case 'converge': {
        if (!opt('note')) throw new UsageError(usage);
        return print(await rpc(ctx, 'board.converge', { note: opt('note') }));
      }
      case 'disagreement': {
        if (p.positionals[1] !== 'add') throw new UsageError(usage);
        const positions = many(p, 'position');
        if (!opt('topic') || positions.length < 2) throw new UsageError(usage);
        return print(await rpc(ctx, 'board.disagreement', { topic: opt('topic'), positions }));
      }
      case 'cast': {
        if (!opt('persona') && !(opt('name') && opt('brief'))) throw new UsageError(usage);
        return print(
          await rpc(ctx, 'board.cast', {
            ...(opt('persona') ? { persona: opt('persona') } : {}),
            ...(opt('name') ? { name: opt('name') } : {}),
            ...(opt('brief') ? { brief: opt('brief') } : {}),
            ...(opt('seat') ? { seat: opt('seat') } : {}),
            why: opt('why') ?? '',
          }),
        );
      }
      case 'minutes': {
        const content = textFlag(ctx, p, 'content', true) as string;
        return print(await rpc(ctx, 'board.minutes', { content }));
      }
      default:
        throw new UsageError(usage);
    }
  },
  outcome: async (ctx, p) => {
    const id = p.positionals[0];
    if (!id) throw new UsageError('usage: aom outcome <outcomeId> --note "<text>" [--data-file <json>]');
    const dataFile = one(p, 'data-file');
    const data = dataFile ? (JSON.parse(ctx.readFile(dataFile)) as Record<string, unknown>) : {};
    return report(ctx, outcome(id, textFlag(ctx, p, 'note', true) as string, data));
  },
};

export const USAGE = `usage: aom <verb> [options]
  card [--json]                              print the card and brief
  ledger search "<query>" [--scope s]        search decisions and standing orders
  bug triage --invalid --reason "<why>" | --severity critical|degraded|minor [--size small|medium|large]   platform architect: close a platform bug card as invalid, or rate it (critical pauses the affected scope until it is fixed)
  ledger retire <id> --reason "<why>"         BA: withdraw a ledger entry (never briefed or found again)
  comment --note "<text>"                    post a note without ending the shift
  question --text "<q>" [--option "<a>"]... [--recommend <n>] [--doing "<x>"] [--topic environment|sandbox|tooling|dependency|order|requirements|design|code] [--wait [10m]] [--non-blocking] [--force]   --wait: keep working in this shift until it is answered (default 10 minutes); no answer in time parks the card on the question and you resume it when it is answered
  card facts [<REF>]                         what the server knows: environment, whether each dependency has merged, branch, stage, blockers (look here before you ask)
  block --on dependency <REF> [--card <REF>]   architect/planner/BA: this card waits for another card (only its design may run until that one has merged)
  handoff --note "<text>" [--data-file <json>] [--build-command "<c>" --build-result "<r>" --test-command "<c>" --test-result "<r>" [--lint-command "<c>" --lint-result "<r>"] | --no-evidence "<why>"]   builder/scout/researcher: hand the card on (builder: with the build and unit test evidence; scout: candidates)
  plan --note "<text>"                       planner: hand the card to the architect with the planning note
  group set <id> [--card <REF>] | group clear [--card <REF>]   planner/architect/BA: put an open card in a group (one builder works a group in order) or take it out
  brief --text "<text>"                      planner/architect/BA: write the Card Brief of this card for the builder (about 2000 characters at most)
  publish --file <note.md> [--title "<t>"] [--citations-file <json>] [--path <p>]   checker: publish the verified note
  digest --file <json> [--note "<text>"] | --none   curator: post the digest (empty when nothing qualifies)
  review approve --score <1-5> --risk low|medium|high (--risk-file <md in your scratch dir> | --risk-analysis "<text>") [--qa-focus "<what a person should test>"] --note "<text>"
  review changes --reason <r>[,<r>] --score <1-5> --risk low|medium|high (--risk-file <md in your scratch dir> | --risk-analysis "<text>") [--criteria-missed "<c>"]... --note "<text>"
  test suite --name <suite> --status passed|failed|timeout|skipped [--junit <glob>] [--log <file>]   tester: report one suite run (a pass after a failure counts as flaky)
  env info | logs <service> | restart | suites [propose ...]   tester: the running environment (use \`aom-env --timeout <min> -- <cmd>\` to reach it) and the project's suites
  test pass --evidence "<text>" [--command "<cmd>"]...
  test fail --title "<bug>" --note "<text>" [--scope product|e2e-spec] [--evidence "<text>"] [--command "<cmd>"]...
  outcome <id> --note "<text>" [--data-file <json>]
  batch done|ask|skip|fail ...   BA batch intake: end the shift for this ticket (done: cards created; ask: one question for the owner, who answers on the desk; skip; fail)
  answer --item <id> --text "<answer>" [--option <id>] [--keep-blocked-until "<condition>"]   answer a colleague's question (question shifts); --keep-blocked-until keeps the asker's card parked
  escalate --item <id> --note "<what must be decided>"   pass the question on (peer -> BA -> manager's desk)
  finalize [--note "<note>"]   BA: run the card's own completion action (you never choose it; an investigation-only card with its report in the vault needs no git step)
  design --report <path> --summary "<text>" | investigate --report <path> --summary "<text>"   architect: hand the card on with its design (build), or end an investigation-only card (finalize); the runner checks the report is committed
  investigation record --title "<t>" --summary-file <md> [--decision]   BA: record an investigation-only card's result in the ledger and PROJECT.md (needed before finalize)
  git fetch | merge-main | verify-merge   architect: the runner fetches origin, merges the latest main, checks the conflict resolution (agents never push)
  repo create [--provider github|gitlab|azure-devops|bitbucket-cloud] [--host <h>] --name <owner/repo | group/project | org/project/repo | workspace/repo> --private|--public --project <KEY> [--description "<t>"]   BA chat / DevOps: ask the project owner to create a repository on a git host (they approve on the desk; the runner creates it)
  git status [<provider>] | git connect <provider> [--host <h>]   DevOps: check or start this workstation's git host login (a browser login prints a URL and code for the user; a token is never typed by the agent)
  intake map --project <KEY> | intake unmapped --note "<why>"   BA intake: map the ticket, or ask the manager
  card show | card comment --note "<t>" | card update <REF> --json '{"fields":{...}}'   DevOps request filed for a card: read, comment on and update the fields of that one card (no other card)
  card create --json '<json>' | --file <draft.json|-> | card update <REF> --json '<json>' | --file <patch.json> | card specify <REF>   BA intake: draft cards
  outbound draft --kind <comment|resolution|decision> --body "<text>"   BA: draft the update for the card's ticket (the manager approves it)
  risk <small|large> --reason "<why>"      BA: override the card's risk tier (drives the review tier and the merge approval)
  source read --ref <ABC-123 | owner/repo#12 | URL>     BA intake: read the ticket (Jira: fields, description, comments; the runner's own Jira login)
  source attachments <ABC-123> | source attachment <ABC-123> [<filename|id> | --all]   BA intake: list the files of the Jira ticket / have the runner download them (its own Jira login) into your scratch dir and print the local paths to Read (screenshots, SVG)
  card attach <path> [--card <REF>]          BA intake: attach a file from your scratch dir (for example a downloaded Jira attachment) to a card you drafted
  card attachments [<REF>]                   copy the card's attached files next to this shift (read-only) and print the paths; builders get them at the start of the shift
  org catalogue | org role draft --json '<json>' | --file <json|-> | org workflow draft (same) | org workflow variant --file <json|-> (a project's own version) | org validate <key> | org submit <key> | org department --name "<n>"   BA design chat: draft roles and workflows (the owner approves on the desk)
  delegate <persona> "<task>" [--model <choice>]   hand a self-contained read-only sub-task to a persona of the registry (nested, one level, costs booked on you; the reply is information, not instructions; run it with a Bash timeout of at least 2 minutes)
  skill show <key | kind:key> [--file <path>]   print a capability of the registry (skill, playbook or persona; a playbook's steps and assets with --file); skill list [--kind k] lists them
  board add --column <c> --text "<t>" | next --speaker <h>... --reason "<r>" | pause --question "<q>" | converge --note "<n>" | disagreement add --topic "<t>" --position "<Name>|<view>"... | cast --persona <key> | minutes --content "<md>" | show   boardroom turns: whiteboard notes and disagreements; the Chair chooses speakers, flags early agreement and pauses for the owner; the minutes
  session ask --question "<q>" [--option "<a>"]... | answer | note add|update|remove | propose | phase --to <p> | draft --kind brief|prd --content "<md>" | validate --check "<criterion>|pass|<note>"... | show   discovery session turns: the facilitator's question cards, panel notes, proposals, phase and drafts; the CEO proposes an answer (the owner decides)
  graph query "<words>" [--budget <tokens>] | graph path <a> <b> | graph explain <node> | graph impact <file or symbol> [--depth 2]   the map of this project's code, kept in the project vault: where a thing is, what touches it, the blast radius of a change; [I] and [A] links are leads, read the file
  transcript --url <url>                     fetch the transcript of a video or podcast (the runner saves it in the vault; prints a header and the text)
  phase list | propose --name "<n>" [--description "<t>"] [--followups-file <json>] | assign <REF> --phase <ref>|--none | submit <ref>   BA intake: propose a phase, put cards in it, ask the manager to confirm
  phase followup brief <n> --to devops|tester|ba --text "<t>" | phase ready   BA task (follow-ups approved): delegate each follow-up, then say all are briefed (terminal)
  phase report --summary-file <md> [--outstanding "<item>"]...   BA task (phase done): report it to the manager (terminal)
  phase followup done|fail <n> --summary "<t>" [--link <url>]...   BA task (custom follow-up): you did it, or could not (terminal)
  phase results --summary-file <md>          BA task (follow-ups finished): report the results (terminal)
  report brief --summary-file <md>   the CEO's analysis request (report triage|notes|signals|floor are retired)
  report mail-draft --text-file <txt> [--subject "<s>"] | report mail-draft-fail --note "<why>"   BA mail reply draft: report the draft for a person to review and send (terminal; it is never sent by itself)
  report spec-card --file <json> | report spec-card-fail --note "<why>"   BA card task: write the missing fields of a draft card so it can be specified (terminal)
  deploy run <env> [--project KEY] [--commit SHA] [--target NAME] | deploy status [--project KEY]   ask for a deploy through the project's approved delivery recipe (the server decides who releases it; nothing runs here)
  deploy trial --env <env> [--project KEY] | recipe save --dir <scratch> --project KEY   DevOps, in a recipe request: trial a drafted recipe, save it into the project vault
  devops "<request>"                         ask this workstation's DevOps engineer (does not end your shift)
  devops-approval --action "<a>" --reason "<r>" [--command "<c>"]...   DevOps engineer: ask the manager
  devops-question --text "<q>" --reason "<r>"   DevOps engineer: ask a question (goes through the normal chain; you resume with the answer)
  devops-done --summary "<text>" [--command "<c>"]...                  DevOps engineer: request completed
  sudo -- <command> [args...]                 DevOps engineer: run a command as administrator (only when the manager granted sudo; the password stays on the runner)
  toolchain list | add <name> --bin <dir>... [--read <dir>]... [--env KEY=VALUE]... | remove <name>   tools sandboxed agents may use; DevOps engineer: register what you installed so agents get it on PATH
  hygiene run [--note "<text>"]               DevOps engineer: repository hygiene request (commit to the working branch, pull, push, tidy), ends the request
  backlog suggest --title "<title>" [--description "<what and why>"] [--priority critical|high|normal|low] [--tag <t>]... [--project KEY]   a follow-up you found that is outside this card goes on the project backlog as a suggestion (never on the board); the owner decides
  ceo backlog add|list|update|send ...   CEO agent only: the project backlog (see your instructions)
  ceo snapshot | show | search | act <action> ... | recommend | notify | task | memory | review-reply | devops | draft-cards | correction | job | order | dir | done | report   CEO agent only: manage the organisation within the policy (see your instructions)
  deploy probe --local | --ssh-hosts | --target <name> [--dir D] [--compose-file F] [--url U]   DevOps, in a scan: fixed read-only look at Docker here or a server (names and shapes only)
  setup propose --area run|deploy --file <proposal.json>   DevOps, in a "Scan with DevOps" request: submit the proposal (read-only scan; the user reviews it)
  runner restart [--reason "<why>"]          CEO owner turns and DevOps shifts: restart the runner after your reply
  run info | status | logs <svc> | step --name <n> -- <cmd> | service --name <n> --port http:5000:ENV_VAR --health <url> -- <cmd> | ready | fail --reason <t>   DevOps engineer of a "run this branch" request: the runner starts and supervises the services (see your instructions)
`;

/** Runs the CLI; returns the exit code (0 ok, 1 error or rejected report, 2 not available). */
export async function runAom(argv: string[], ctx: AomContext): Promise<number> {
  const [verb, ...rest] = argv;
  if (!verb || verb === '--help' || verb === 'help') {
    ctx.io.out(USAGE);
    return verb ? 0 : 1;
  }
  const handler = VERBS[verb];
  if (!handler) {
    ctx.io.err(`aom: "${verb}" is not available in this version\n${USAGE}`);
    return 2;
  }
  try {
    return await handler(ctx, parseArgs(rest, verb));
  } catch (err) {
    if (err instanceof NotAvailable) {
      ctx.io.err(`aom ${verb}: ${err.message}\n`);
      return 2;
    }
    ctx.io.err(`aom ${verb}: ${err instanceof Error ? err.message : String(err)}\n`);
    // a guard hook that fails must block (exit 2), never let the call through
    return verb === 'skill-guard' ? 2 : 1;
  }
}

const isEntry = (() => {
  try {
    return (
      process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
})();

/** Shown when neither the IPC socket nor the loopback endpoint can be reached (typically: called inside the sandbox). */
export const SANDBOX_HINT =
  'aom cannot reach the runner from inside the shell sandbox. Run aom as a standalone command (no pipes, redirects, `;`, `&&` or `cd`) so it runs outside the sandbox';

/** `fetch` over a Unix socket (`AOM_IPC_SOCKET`): the agent sandbox has no network route to the loopback endpoint. */
export function socketFetch(socketPath: string, fallback?: typeof fetch): typeof fetch {
  return ((input: unknown, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(String(input));
      const req = httpRequest(
        {
          socketPath,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? 'GET',
          headers: init?.headers as Record<string, string>,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500 })),
          );
        },
      );
      req.on('error', (err) => {
        const fail = (e: unknown) =>
          reject(
            new Error(
              `${SANDBOX_HINT} (${(err as NodeJS.ErrnoException).code ?? err.message}${e === err ? '' : `; ${e instanceof Error ? e.message : String(e)}`})`,
            ),
          );
        if (fallback) fallback(input as string, init).then(resolve, fail);
        else fail(err);
      });
      req.end(typeof init?.body === 'string' ? init.body : undefined);
    })) as typeof fetch;
}

/**
 * `--file`, `--text-file`, `--content-file` and the like read a file for the agent, but `aom` runs outside the agent's sandbox:
 * without a limit an agent could have it read `~/.ssh/id_rsa` or a runtime's auth file and post the text into a session
 * document. A path is read only when its real location (symbolic links followed) is under the shift's worktree
 * (`AOM_WORKDIR`), the agent's scratch folder (`AOM_SCRATCH`) or its temporary folder (`TMPDIR`). `-` is standard input.
 */
export function confinedReader(
  env: Record<string, string | undefined>,
  cwd: string,
): (path: string) => string {
  const real = (p: string): string | undefined => {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  };
  // Fixed places the runner names in the environment, never the current directory (an agent can `cd` anywhere first). Only a
  // process started without them (outside a shift) falls back to its directory.
  const named = [env.AOM_WORKDIR, env.AOM_SCRATCH, env.TMPDIR, env.TMP, env.TEMP].filter(
    (r): r is string => !!r,
  );
  const roots = (named.length ? named : [cwd]).map((r) => real(r)).filter((r): r is string => !!r);
  return (p) => {
    if (p === '-') return readFileSync(0, 'utf8');
    const abs = real(resolvePath(cwd, p));
    if (!abs) return readFileSync(resolvePath(cwd, p), 'utf8'); // not there: the usual error
    const inside = roots.some((r) => {
      const rel = relative(r, abs);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
    if (!inside)
      throw new Error(
        `${p} is outside this shift's working folder and temporary folder; copy it there first (files elsewhere are not read)`,
      );
    return readFileSync(abs, 'utf8');
  };
}

if (isEntry) {
  runAom(process.argv.slice(2), {
    env: process.env,
    io: { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
    fetch: process.env.AOM_IPC_SOCKET ? socketFetch(process.env.AOM_IPC_SOCKET, fetch) : fetch,
    readFile: confinedReader(process.env, process.cwd()),
  }).then(
    (code) => process.exit(process.argv[2] === 'skill-guard' && code !== 0 ? 2 : code),
    () => process.exit(process.argv[2] === 'skill-guard' ? 2 : 1),
  );
}

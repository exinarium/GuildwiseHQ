#!/usr/bin/env node
// The in-session `aom` command (docs/ARCHITECTURE.md section 13.4). Talks to the runner's local IPC server with the
// per-shift token from the environment. Verb table: one line per verb.
import { readFileSync, realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve as resolvePath } from 'node:path';
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
  QA_FOCUS_MAX,
  type QuestionShift,
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
}

interface Parsed {
  flags: Map<string, string[]>;
  positionals: string[];
}

const BOOLEAN_FLAGS = new Set([
  'json',
  'non-blocking',
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
      else if (BOOLEAN_FLAGS.has(key) && !(inlineJson && key === 'json')) value = 'true';
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

const REPORT_USAGE = `usage: aom report triage --file <decisions.json>      # { "decisions": [ { "itemId", "action": "pass|dismiss|merge", "note"?, "into"? } ] }
       aom report notes --file <notes.json>          # { "notes": [ { "itemId", "note", "related"? } ] }
       aom report signals --file <reports.json>     # { "reports": [ { "signalId", "summary", "annotateItemId"? } ] }
       aom report floor --summary-file <report.md>
       aom report brief --summary-file <report.md>
       aom report mail-draft --text-file <reply.txt> [--subject "<subject>"]
       aom report mail-draft-fail --note "<why no reply can be written>"`;

/** `aom report ...`: the BA's reporter tasks (held items, urgent notes, urgent signals, the daily floor report). */
async function reportVerb(ctx: AomContext, p: Parsed): Promise<number> {
  const sub = p.positionals[0];
  const data = (): Record<string, unknown> => {
    const body = jsonBody(ctx, p);
    if (!body) throw new UsageError(REPORT_USAGE);
    return body;
  };
  switch (sub) {
    case 'triage':
      return report(ctx, outcome('triage_done', 'Triage decisions', data()));
    case 'notes':
      return report(ctx, outcome('notes_done', 'Notes on urgent items', data()));
    case 'signals':
      return report(ctx, outcome('signal_report', 'Urgent signal reports', data()));
    case 'floor':
      return report(
        ctx,
        outcome('floor_report', 'Daily floor report', {
          report: textFlag(ctx, p, 'summary', true) as string,
        }),
      );
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

const CEO_USAGE = `usage: aom ceo snapshot [--section <name>] | show card|agent|project|shift|desk-item|workstation <ref> | search desk|cards|memory "<q>" | costs [--days n]
       aom ceo act <action> [--<param> <value>]... --reason "<why>" --confidence 0.0-1.0 [--evidence ledger:<id>|memory:<id>|signal:<id>|hr:<id>]... [--dry-run] [--key <k>]
       aom ceo recommend --item <desk id> [--option <o1>|--text "..."] --reason "..." --confidence 0.0-1.0  |  --action <name> [--<param> <value>]... --reason "..." --confidence ...
       aom ceo notify --kind needs_you|urgent|task_done --text "..." [--title "..."] [--task <id>] [--item <id>]
       aom ceo task create --title "..." [--request "..."] [--due <iso>] | task update --id <id> [--status s] [--note "..."] [--watch card:<id>]... | task list
       aom ceo memory propose --text "..." --source owner_chat|desk:<item id> [--kind rule|preference|fact] [--quote "..."]
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
  card: async (ctx, p) => {
    const sub = p.positionals[0];
    if (sub === 'create' || sub === 'update' || sub === 'specify') return cardDraft(ctx, p, sub);
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
    return report(ctx, {
      kind: 'question',
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
    });
  },
  handoff: async (ctx, p) => {
    const dataFile = one(p, 'data-file');
    const data = dataFile ? (JSON.parse(ctx.readFile(dataFile)) as Record<string, unknown>) : {};
    return report(ctx, outcome('handoff', textFlag(ctx, p, 'note', true) as string, data));
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
      return report(
        ctx,
        outcome('fail', note, {
          title,
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
      throw new UsageError('usage: aom answer --item <id> --text "<answer>" [--option <option id>]');
    const optionId = one(p, 'option');
    return report(ctx, {
      kind: 'answer',
      itemId,
      text: textFlag(ctx, p, 'text', true) as string,
      ...(optionId ? { optionId } : {}),
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
  ledger retire <id> --reason "<why>"         BA: withdraw a ledger entry (never briefed or found again)
  comment --note "<text>"                    post a note without ending the shift
  question --text "<q>" [--option "<a>"]... [--recommend <n>] [--doing "<x>"] [--non-blocking] [--force]
  handoff --note "<text>" [--data-file <json>]   builder/scout/researcher: hand the card on (scout: candidates)
  publish --file <note.md> [--title "<t>"] [--citations-file <json>] [--path <p>]   checker: publish the verified note
  digest --file <json> [--note "<text>"] | --none   curator: post the digest (empty when nothing qualifies)
  review approve --score <1-5> --risk low|medium|high (--risk-file <md in your scratch dir> | --risk-analysis "<text>") [--qa-focus "<what a person should test>"] --note "<text>"
  review changes --reason <r>[,<r>] --score <1-5> --risk low|medium|high (--risk-file <md in your scratch dir> | --risk-analysis "<text>") [--criteria-missed "<c>"]... --note "<text>"
  test suite --name <suite> --status passed|failed|timeout|skipped [--junit <glob>] [--log <file>]   tester: report one suite run (a pass after a failure counts as flaky)
  env info | logs <service> | restart | suites [propose ...]   tester: the running environment (use \`aom-env --timeout <min> -- <cmd>\` to reach it) and the project's suites
  test pass --evidence "<text>" [--command "<cmd>"]...
  test fail --title "<bug>" --note "<text>" [--evidence "<text>"] [--command "<cmd>"]...
  outcome <id> --note "<text>" [--data-file <json>]
  batch done|ask|skip|fail ...   BA batch intake: end the shift for this ticket (done: cards created; ask: one question for the owner, who answers on the desk; skip; fail)
  answer --item <id> --text "<answer>" [--option <id>]   answer a colleague's question (question shifts)
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
  transcript --url <url>                     fetch the transcript of a video or podcast (the runner saves it in the vault; prints a header and the text)
  phase list | propose --name "<n>" [--description "<t>"] [--followups-file <json>] | assign <REF> --phase <ref>|--none | submit <ref>   BA intake: propose a phase, put cards in it, ask the manager to confirm
  phase followup brief <n> --to devops|tester|ba --text "<t>" | phase ready   BA task (follow-ups approved): delegate each follow-up, then say all are briefed (terminal)
  phase report --summary-file <md> [--outstanding "<item>"]...   BA task (phase done): report it to the manager (terminal)
  phase followup done|fail <n> --summary "<t>" [--link <url>]...   BA task (custom follow-up): you did it, or could not (terminal)
  phase results --summary-file <md>          BA task (follow-ups finished): report the results (terminal)
  report triage|notes|signals --file <json> | report floor --summary-file <md>   BA reporter task (held items, urgent notes, urgent signals, the daily floor report): report to the manager (terminal)
  report mail-draft --text-file <txt> [--subject "<s>"] | report mail-draft-fail --note "<why>"   BA mail reply draft: report the draft for a person to review and send (terminal; it is never sent by itself)
  devops "<request>"                         ask this workstation's DevOps engineer (does not end your shift)
  devops-approval --action "<a>" --reason "<r>" [--command "<c>"]...   DevOps engineer: ask the manager
  devops-done --summary "<text>" [--command "<c>"]...                  DevOps engineer: request completed
  sudo -- <command> [args...]                 DevOps engineer: run a command as administrator (only when the manager granted sudo; the password stays on the runner)
  toolchain list | add <name> --bin <dir>... [--read <dir>]... [--env KEY=VALUE]... | remove <name>   tools sandboxed agents may use; DevOps engineer: register what you installed so agents get it on PATH
  hygiene run [--note "<text>"]               DevOps engineer: repository hygiene request (commit to the working branch, pull, push, tidy), ends the request
  ceo snapshot | show | search | act <action> ... | recommend | notify | task | memory | done | report   CEO agent only: manage the organisation within the policy (see your instructions)
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
    return 1;
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

if (isEntry) {
  runAom(process.argv.slice(2), {
    env: process.env,
    io: { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
    fetch: process.env.AOM_IPC_SOCKET ? socketFetch(process.env.AOM_IPC_SOCKET, fetch) : fetch,
    readFile: (p) => readFileSync(p === '-' ? 0 : p, 'utf8'),
  }).then((code) => process.exit(code));
}

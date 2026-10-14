#!/usr/bin/env node
// The in-session `aom` command (docs/ARCHITECTURE.md section 13.4). Talks to the runner's local IPC server with the
// per-shift token from the environment. Verb table: one line per verb.
import { readFileSync, realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type BaTaskShift,
  type DevopsShift,
  formatLedgerMatches,
  IPC_REPORT_PATH,
  IPC_RPC_PATH,
  type IpcReportResponse,
  type IpcRpcResponse,
  type LedgerMatch,
  type QuestionShift,
  renderBaTaskPrompt,
  renderDevopsPrompt,
  renderQuestionPrompt,
  renderShiftPrompt,
  type ShiftBrief,
  type ShiftReport,
} from '@aom/shared';
import type { ChangeStateLookup } from '../devops/branch-cleanup.ts';
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
]);

/** Verbs whose JSON body can be passed inline (`--json '<json>'`): there `--json` takes a value instead of being a switch. */
const takesInlineJson = (verb: string | undefined, argv: string[]): boolean =>
  (verb === 'card' && (argv[0] === 'create' || argv[0] === 'update')) || verb === 'org';

export function parseArgs(argv: string[], verb?: string): Parsed {
  // `aom sudo -- <command> [args...]`: everything after the verb is the command, flags included.
  if (verb === 'sudo') return { flags: new Map(), positionals: argv[0] === '--' ? argv.slice(1) : argv };
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
       aom report brief --summary-file <report.md>`;

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

/** `aom design` / `aom investigate`: the architect's terminal report (the runner checks and commits the report file). */
async function investigationReport(
  ctx: AomContext,
  p: Parsed,
  outcomeId: 'handoff' | 'report',
  verb: 'design' | 'investigate',
): Promise<number> {
  const reportFile = one(p, 'report');
  if (!reportFile?.trim())
    throw new UsageError(
      `usage: aom ${verb} --report <report path> --summary "<${verb === 'design' ? '3-6 lines for the builder' : 'what you found and recommend'}>" | --summary-file <md>`,
    );
  const summary = (textFlag(ctx, p, 'summary', true) as string).trim();
  // `location` is decided by the runner from the brief; the schema needs a value.
  return report(
    ctx,
    outcome(outcomeId, summary.slice(0, 20000), {
      reportPath: reportFile.trim(),
      summary: summary.slice(0, 2000),
      location: 'repo',
    }),
  );
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
    if (sub === 'approve') return report(ctx, outcome('approve', note, { score: score(p) }));
    if (sub === 'changes') {
      const reasons = many(p, 'reason')
        .flatMap((r) => r.split(','))
        .map((r) => r.trim())
        .filter(Boolean);
      if (reasons.length === 0) throw new UsageError('--reason <reason>[,<reason>] is required');
      return report(
        ctx,
        outcome('changes', note, { score: score(p), reasons, criteriaMissed: many(p, 'criteria-missed') }),
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
    throw new UsageError('usage: aom test pass|fail ...');
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
      'usage: aom git status [<provider>] [--host <host>] | aom git connect <github|gitlab|azure-devops|bitbucket-cloud> [--host <host>]\n       aom git push | fetch | merge-main | verify-merge   (the architect: the runner pushes the card branch, fetches origin, merges the latest main, checks a conflict resolution)';
    const sub = p.positionals[0];
    const host = one(p, 'host');
    // The architect's git is run by the runner (the agent's own shell cannot push or fetch): the card branch only.
    if (sub === 'push' || sub === 'fetch' || sub === 'merge-main' || sub === 'verify-merge') {
      const method = `git.${sub.replace('-', '_')}`;
      const r = (await rpc(
        ctx,
        method,
        sub === 'push' && p.positionals[1] ? { branch: p.positionals[1] } : {},
      )) as {
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
    const action = one(p, 'action');
    if (action !== 'pr' && action !== 'push_branch' && action !== 'merge' && action !== 'none')
      throw new UsageError(
        'usage: aom finalize --action <pr|push_branch|merge|none> --note "<why this action>"   (none: only an investigation-only card whose report is in the vault)',
      );
    const note = textFlag(ctx, p, 'note', false)?.trim() || `Finalize with ${action}`;
    return report(ctx, outcome('finalized', note, { action }));
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
  comment --note "<text>"                    post a note without ending the shift
  question --text "<q>" [--option "<a>"]... [--recommend <n>] [--doing "<x>"] [--non-blocking] [--force]
  handoff --note "<text>" [--data-file <json>]   builder/scout/researcher: hand the card on (scout: candidates)
  publish --file <note.md> [--title "<t>"] [--citations-file <json>] [--path <p>]   checker: publish the verified note
  digest --file <json> [--note "<text>"] | --none   curator: post the digest (empty when nothing qualifies)
  review approve --score <1-5> --note "<text>"
  review changes --reason <r>[,<r>] --score <1-5> [--criteria-missed "<c>"]... --note "<text>"
  test pass --evidence "<text>" [--command "<cmd>"]...
  test fail --title "<bug>" --note "<text>" [--evidence "<text>"] [--command "<cmd>"]...
  outcome <id> --note "<text>" [--data-file <json>]
  answer --item <id> --text "<answer>" [--option <id>]   answer a colleague's question (question shifts)
  escalate --item <id> --note "<what must be decided>"   pass the question on (peer -> BA -> manager's desk)
  finalize --action <pr|push_branch|merge|none> [--note "<why>"]   BA: run the completion action (revise it with a different action; none: investigation-only card, report in the vault)
  design --report <path> --summary "<text>" | investigate --report <path> --summary "<text>"   architect: hand the card on with its design (build), or end an investigation-only card (finalize); the runner checks the report is committed
  investigation record --title "<t>" --summary-file <md> [--decision]   BA: record an investigation-only card's result in the ledger and PROJECT.md (needed before finalize)
  git push | fetch | merge-main | verify-merge   architect: the runner pushes the card branch, fetches origin, merges the latest main, checks the conflict resolution
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
  devops "<request>"                         ask this workstation's DevOps engineer (does not end your shift)
  devops-approval --action "<a>" --reason "<r>" [--command "<c>"]...   DevOps engineer: ask the manager
  devops-done --summary "<text>" [--command "<c>"]...                  DevOps engineer: request completed
  sudo -- <command> [args...]                 DevOps engineer: run a command as administrator (only when the manager granted sudo; the password stays on the runner)
  toolchain list | add <name> --bin <dir>... [--read <dir>]... [--env KEY=VALUE]... | remove <name>   tools sandboxed agents may use; DevOps engineer: register what you installed so agents get it on PATH
  hygiene run [--note "<text>"]               DevOps engineer: repository hygiene request (commit to the working branch, pull, push, tidy), ends the request
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

#!/usr/bin/env node
// The in-session `aom` command (docs/ARCHITECTURE.md section 13.4). Talks to the runner's local IPC server with the
// per-shift token from the environment. Verb table: one line per verb.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  type DevopsShift,
  formatLedgerMatches,
  IPC_REPORT_PATH,
  IPC_RPC_PATH,
  type IpcReportResponse,
  type IpcRpcResponse,
  type LedgerMatch,
  renderDevopsPrompt,
  renderShiftPrompt,
  type ShiftBrief,
  type ShiftReport,
} from '@aom/shared';

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

const BOOLEAN_FLAGS = new Set(['json', 'non-blocking', 'force', 'help', 'none']);

export function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let value: string;
      if (eq !== -1) value = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(key)) value = 'true';
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

const VERBS: Record<string, Verb> = {
  card: async (ctx, p) => {
    const brief = (await rpc(ctx, 'card.get')) as ShiftBrief & { devops?: DevopsShift };
    if (has(p, 'json')) ctx.io.out(`${JSON.stringify(brief, null, 2)}\n`);
    else ctx.io.out(`${brief.devops ? renderDevopsPrompt(brief.devops) : renderShiftPrompt(brief)}\n`);
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
  devops "<request>"                         ask this workstation's DevOps engineer (does not end your shift)
  devops-approval --action "<a>" --reason "<r>" [--command "<c>"]...   DevOps engineer: ask the manager
  devops-done --summary "<text>" [--command "<c>"]...                  DevOps engineer: request completed
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
    return await handler(ctx, parseArgs(rest));
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

if (isEntry) {
  runAom(process.argv.slice(2), {
    env: process.env,
    io: { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
    fetch,
    readFile: (p) => readFileSync(p, 'utf8'),
  }).then((code) => process.exit(code));
}

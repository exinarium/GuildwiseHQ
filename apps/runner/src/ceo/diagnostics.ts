import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  DIAGNOSTICS_MAX_CHARS,
  type RunnerDiagnosticsRequest,
  RunnerDiagnosticsRequestSchema,
  type RunnerDiagnosticsResult,
} from '@aom/shared';
import type { RunnerPaths } from '../paths.ts';
import { redactSecrets } from '../secrets/redact.ts';

/**
 * What the CEO's full-power owner turn can read about this workstation (docs/investigations/ceo-full-power.md): the runner's
 * status, its log, the service manager's journal and the shift, environment and audit logs. The deny floor keeps a shell from
 * opening the runner's data folder, because those files can hold tokens; this is the way in, and everything it returns has
 * been through `redactSecrets` and is cut to a size the model can read. Read-only: it starts nothing and changes nothing.
 */

const TAIL_BYTES = 2_000_000;
const MAX_LINE_CHARS = 2000;
const LIST_LIMIT = 40;

export type RunExec = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;

export const defaultExec: RunExec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 8_000_000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || stderr || (err ? String(err.message) : '')) }),
    );
  });

export interface DiagnosticsDeps {
  paths: RunnerPaths;
  version: string;
  /** What the running runner knows about itself (connection, pairing, capacity); merged into `status`. */
  status?: () => Record<string, unknown>;
  exec?: RunExec;
  platform?: NodeJS.Platform;
}

/** The last `maxBytes` of a file as text (a partial first line is dropped). */
export function tailFile(path: string, maxBytes = TAIL_BYTES): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/** The last `lines` lines that contain `grep` (case-insensitive plain text), each cut to a readable length. */
export function selectLines(text: string, lines: number, grep?: string): string {
  const needle = grep?.toLowerCase();
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  const kept = needle ? all.filter((l) => l.toLowerCase().includes(needle)) : all;
  return kept
    .slice(-lines)
    .map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l))
    .join('\n');
}

/** Masks secrets, then keeps the tail when the text is longer than one answer. */
export function finish(text: string): { text: string; truncated: boolean } {
  const masked = redactSecrets(text);
  return masked.length > DIAGNOSTICS_MAX_CHARS
    ? { text: `…\n${masked.slice(-DIAGNOSTICS_MAX_CHARS)}`, truncated: true }
    : { text: masked, truncated: false };
}

function listDir(dir: string, label: string): string {
  if (!existsSync(dir)) return `${label}: no such folder on this workstation.`;
  const files = readdirSync(dir)
    .map((name) => {
      try {
        const s = statSync(join(dir, name));
        return s.isFile() ? { name, size: s.size, at: s.mtime } : null;
      } catch {
        return null;
      }
    })
    .filter((f): f is { name: string; size: number; at: Date } => f !== null)
    .sort((a, b) => +b.at - +a.at)
    .slice(0, LIST_LIMIT);
  if (!files.length) return `${label}: no files.`;
  return [
    `${label}: the newest ${files.length} files (newest first). Read one with --name <file>.`,
    ...files.map((f) => `${f.at.toISOString()}  ${String(f.size).padStart(10)}  ${f.name}`),
  ].join('\n');
}

/** One file of a log folder by bare name; a name that tries to leave the folder is refused. */
function readNamed(dir: string, name: string, req: RunnerDiagnosticsRequest): string {
  if (name !== basename(name) || name.startsWith('.')) return `Not a log file name: ${name}.`;
  const file = join(dir, name);
  if (!existsSync(file) || !statSync(file).isFile()) return `No file ${name} in that folder.`;
  return selectLines(tailFile(file), req.lines, req.grep);
}

async function serviceUnits(exec: RunExec): Promise<string[]> {
  const r = await exec('systemctl', [
    '--user',
    'list-units',
    '--type=service',
    '--all',
    '--plain',
    '--no-legend',
    'aom-runner*',
    'guildwise-runner*',
  ]);
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((u) => /^[A-Za-z0-9@_.-]+\.service$/.test(u));
}

async function statusText(deps: DiagnosticsDeps, exec: RunExec): Promise<string> {
  const out: Record<string, unknown> = { runnerVersion: deps.version, dataFolder: basename(deps.paths.root) };
  try {
    out.statusFile = JSON.parse(readFileSync(deps.paths.status, 'utf8'));
  } catch {
    out.statusFile = null;
  }
  Object.assign(out, deps.status?.() ?? {});
  const platform = deps.platform ?? process.platform;
  if (platform === 'linux') {
    const units = await serviceUnits(exec);
    const state: Record<string, string> = {};
    for (const u of units) {
      const r = await exec('systemctl', [
        '--user',
        'show',
        u,
        '-p',
        'ActiveState,SubState,MainPID,NRestarts,ActiveEnterTimestamp',
        '--no-pager',
      ]);
      state[u] = r.stdout.trim().split('\n').join(', ');
    }
    out.services = units.length ? state : 'no aom-runner service unit found for this user';
  }
  return JSON.stringify(out, null, 2);
}

/** Answers one diagnostics request. Never throws: a problem is the text of the answer. */
export async function runnerDiagnostics(
  rawRequest: unknown,
  deps: DiagnosticsDeps,
): Promise<RunnerDiagnosticsResult> {
  const parsed = RunnerDiagnosticsRequestSchema.safeParse(rawRequest ?? {});
  if (!parsed.success)
    return {
      kind: 'runner',
      text: `Not a valid request: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      truncated: false,
      runnerVersion: deps.version,
    };
  const req = parsed.data;
  const exec = deps.exec ?? defaultExec;
  let text: string;
  try {
    switch (req.kind) {
      case 'status':
        text = await statusText(deps, exec);
        break;
      case 'runner': {
        const file = [deps.paths.runnerLog, join(deps.paths.logs, 'service.log')].find((f) => existsSync(f));
        text = file
          ? selectLines(tailFile(file), req.lines, req.grep)
          : 'The runner has no log file in its data folder yet. `--kind service` shows the service manager journal.';
        break;
      }
      case 'service': {
        const platform = deps.platform ?? process.platform;
        const units = platform === 'linux' ? await serviceUnits(exec) : [];
        if (!units.length) {
          const f = join(deps.paths.logs, 'service.log');
          text = existsSync(f)
            ? selectLines(tailFile(f), req.lines, req.grep)
            : 'No systemd user unit for the runner on this workstation, and no service.log: the runner was started some other way.';
          break;
        }
        const r = await exec('journalctl', [
          '--user',
          ...units.flatMap((u) => ['-u', u]),
          '-n',
          String(Math.min(req.lines * 4, 8000)),
          '--no-pager',
          ...(req.since ? ['--since', req.since] : []),
        ]);
        text = r.ok
          ? selectLines(r.stdout, req.lines, req.grep)
          : `journalctl failed: ${r.stdout.slice(0, 500)}`;
        break;
      }
      case 'shifts':
        text = req.name
          ? readNamed(deps.paths.shiftLogs, req.name, req)
          : listDir(deps.paths.shiftLogs, 'Shift and chat logs');
        break;
      case 'env':
        text = req.name
          ? readNamed(deps.paths.envLogs, req.name, req)
          : listDir(deps.paths.envLogs, 'Environment logs');
        break;
      case 'audit': {
        const dir = join(deps.paths.logs, 'ceo-turns');
        text = req.name
          ? req.name === 'devops-audit.jsonl'
            ? readNamed(deps.paths.logs, req.name, req)
            : readNamed(dir, req.name, req)
          : `${listDir(dir, 'Commands the CEO ran in full-power turns')}\n(also devops-audit.jsonl)`;
        break;
      }
    }
  } catch (err) {
    text = `Could not read it: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { kind: req.kind, ...finish(text), runnerVersion: deps.version };
}

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import type { IpcServer, ShiftIpcHandler } from '../ipc/server.ts';

/**
 * Since Claude Code 2.1.251 the subprocess environment scrub strips credential-named variables (AOM_SHIFT_TOKEN) from
 * every Bash child. Each session that gets a shift token therefore also gets a runner-private file holding the shift
 * variables, and a pointer variable naming it. `aom` fills what is missing from that file.
 */

/** The variable that names the session's env file. No TOKEN/SECRET/KEY/PASSWORD/CREDENTIAL/AUTH in it (the scrub keeps it). */
export const SHIFT_ENV_POINTER = 'AOM_SHIFT_ENV_FILE';
/** What the file holds and what `aom` may fill from it. */
export const SHIFT_ENV_KEYS = [
  'AOM_IPC_URL',
  'AOM_IPC_SOCKET',
  'AOM_SHIFT_TOKEN',
  'AOM_SHIFT_ID',
  'AOM_CEO_TURN_DIR',
] as const;
export type ShiftEnvKey = (typeof SHIFT_ENV_KEYS)[number];
/** `<runnerRoot>/session-env` (0700). */
export const SESSION_ENV_DIR = 'session-env';
/** `<runnerRoot>/session-env/<id>/env.json` (0600). */
export const SESSION_ENV_FILE = 'env.json';
/** Legacy name written into CEO turn dirs by older runners; read only (fallback c). Remove one release after this. */
export const LEGACY_SHIFT_ENV_FILE = 'shift-env.json';
export const SHIFT_ENV_MAX_BYTES = 8 * 1024;

export const sessionEnvRoot = (runnerRoot: string): string => join(runnerRoot, SESSION_ENV_DIR);

/**
 * `<root>/session-env/<id>` when `file` is exactly `<root>/session-env/<one segment>/env.json`, else undefined. The
 * strict shape keeps a wrong value from ever widening a sandbox read rule to anything else.
 */
export function sessionEnvDirOf(file: string | undefined, runnerRoot: string): string | undefined {
  if (!file || !isAbsolute(file) || !isAbsolute(runnerRoot)) return undefined;
  if (file.split(/[\\/]/).includes('..')) return undefined;
  if (normalize(file) !== file) return undefined;
  if (basename(file) !== SESSION_ENV_FILE) return undefined;
  const dir = dirname(file);
  const seg = basename(dir);
  if (!seg || seg === '.' || !/^[A-Za-z0-9_.-]+$/.test(seg)) return undefined;
  if (dirname(dir) !== resolve(sessionEnvRoot(runnerRoot))) return undefined;
  return dir;
}

export interface IssuedShiftCredential {
  token: string;
  /** AOM_IPC_URL, AOM_IPC_SOCKET (unless socket:false or none), AOM_SHIFT_TOKEN, AOM_SHIFT_ID, AOM_SHIFT_ENV_FILE, ...extra */
  env: Record<string, string>;
  /** Absolute path of env.json; undefined when writing failed (the session then runs as it did before the file existed). */
  file?: string;
  /** Revokes the token and removes the session dir. Idempotent, never throws. */
  revoke(): void;
}

export interface ShiftCredentialDeps {
  ipc: Pick<IpcServer, 'url' | 'socketPath' | 'registerShift' | 'revoke'>;
  runnerRoot: string;
  log?: { warn(msg: string): void };
}

export interface ShiftCredentialInput {
  /** shiftId / chatId / delegate id / smoke id */
  sessionId: string;
  handler: ShiftIpcHandler;
  /** Extra shift variables that belong in the file too (the owner turn's AOM_CEO_TURN_DIR). */
  extra?: Partial<Record<ShiftEnvKey, string>>;
  /** false: no AOM_IPC_SOCKET (the direct-model chat never had one). Default true. */
  socket?: boolean;
}

const safeSegment = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'session';

const errCode = (err: unknown): string => {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
  return typeof code === 'string' && code ? code : 'error';
};

const chmodQuiet = (path: string, mode: number): void => {
  try {
    chmodSync(path, mode);
  } catch {
    // not supported on every platform
  }
};

/** Registers a shift token, writes its env file and returns the session variables plus a `revoke()` for the `finally`. */
export function issueShiftCredential(
  deps: ShiftCredentialDeps,
  i: ShiftCredentialInput,
): IssuedShiftCredential {
  const token = deps.ipc.registerShift(i.handler);
  const shiftEnv: Record<string, string> = {
    AOM_IPC_URL: deps.ipc.url,
    ...(i.socket !== false && deps.ipc.socketPath ? { AOM_IPC_SOCKET: deps.ipc.socketPath } : {}),
    AOM_SHIFT_TOKEN: token,
    AOM_SHIFT_ID: i.sessionId,
  };
  for (const [k, v] of Object.entries(i.extra ?? {})) if (typeof v === 'string') shiftEnv[k] = v;

  // 8 hex characters only: a long random segment would make the path look like a credential value to the scrub.
  const dir = join(
    sessionEnvRoot(deps.runnerRoot),
    `${safeSegment(i.sessionId)}.${randomBytes(4).toString('hex')}`,
  );
  let file: string | undefined;
  try {
    file = writeSessionEnvFile(dir, shiftEnv);
  } catch (err) {
    deps.log?.warn(`could not write the session env file ${join(dir, SESSION_ENV_FILE)}: ${errCode(err)}`);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // nothing more to do
    }
  }

  let done = false;
  return {
    token,
    env: file ? { ...shiftEnv, [SHIFT_ENV_POINTER]: file } : shiftEnv,
    ...(file ? { file } : {}),
    revoke() {
      if (done) return;
      done = true;
      try {
        deps.ipc.revoke(token);
      } catch {
        // never throws
      }
      if (!file) return;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        deps.log?.warn(`could not remove the session env dir ${dir}: ${errCode(err)}`);
      }
    },
  };
}

/**
 * Writes `<dir>/env.json` atomically (temp file in the same 0700 dir, then rename) with mode 0600, holding the
 * SHIFT_ENV_KEYS present in `env`. Creates the session-env root and `dir` with mode 0700. Returns the file path.
 */
export function writeSessionEnvFile(dir: string, env: Record<string, string>): string {
  const root = dirname(dir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodQuiet(root, 0o700);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodQuiet(dir, 0o700);
  const out: Record<string, string> = {};
  for (const k of SHIFT_ENV_KEYS) {
    const v = env[k];
    if (typeof v === 'string') out[k] = v;
  }
  const file = join(dir, SESSION_ENV_FILE);
  const tmp = join(dir, `.${SESSION_ENV_FILE}.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, JSON.stringify(out), { mode: 0o600, flag: 'wx' });
    chmodQuiet(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}

/**
 * Removes every entry of `<root>/session-env` whose name `isLive` does not accept, and (re)creates the root with 0700.
 * Returns how many entries were removed. At runner start no token is live (the IPC registry is in memory), so every
 * leftover entry is an orphan of a crashed session.
 */
export function sweepSessionEnvFiles(
  runnerRoot: string,
  isLive: (dirName: string) => boolean = () => false,
): number {
  const root = sessionEnvRoot(runnerRoot);
  if (existsSync(root) && !statSync(root).isDirectory()) rmSync(root, { force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodQuiet(root, 0o700);
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (isLive(name)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed++;
    } catch {
      // try again at the next sweep
    }
  }
  return removed;
}

export type ShiftEnvProblem =
  | 'not_absolute'
  | 'missing'
  | 'unreadable'
  | 'too_large'
  | 'invalid'
  | 'no_token';

export interface ShiftEnvAttempt {
  source: 'pointer' | 'legacy';
  path: string;
  problem?: ShiftEnvProblem;
}

/** Reads one env file into `env` (missing keys only). Never throws; never returns file content in a problem. */
function fillFrom(
  env: NodeJS.ProcessEnv,
  path: string,
  read: (path: string) => string,
): { env: NodeJS.ProcessEnv; problem?: ShiftEnvProblem } {
  if (!isAbsolute(path)) return { env, problem: 'not_absolute' };
  let text: string;
  try {
    text = read(path);
  } catch (err) {
    return { env, problem: errCode(err) === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (text.length > SHIFT_ENV_MAX_BYTES) return { env, problem: 'too_large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { env, problem: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { env, problem: 'invalid' };
  const filled: NodeJS.ProcessEnv = { ...env };
  for (const k of SHIFT_ENV_KEYS) {
    const v = (parsed as Record<string, unknown>)[k];
    if (!filled[k] && typeof v === 'string' && v) filled[k] = v;
  }
  if (!filled.AOM_SHIFT_TOKEN) return { env: filled, problem: 'no_token' };
  return { env: filled };
}

/**
 * The env `aom` works with, and what it tried:
 *  (a) AOM_SHIFT_TOKEN in env: env returned as is, nothing read (attempts: []).
 *  (b) else AOM_SHIFT_ENV_FILE: fill MISSING SHIFT_ENV_KEYS from it; env values always win.
 *  (c) else, or when (b) gave no token, AOM_CEO_TURN_DIR/shift-env.json (legacy, one release).
 * Never throws; never puts file content into an error or a log line.
 */
export function resolveShiftEnv(
  env: NodeJS.ProcessEnv,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): { env: NodeJS.ProcessEnv; attempts: ShiftEnvAttempt[] } {
  if (env.AOM_SHIFT_TOKEN) return { env, attempts: [] };
  const attempts: ShiftEnvAttempt[] = [];
  let current = env;
  const pointer = env[SHIFT_ENV_POINTER];
  if (pointer) {
    const r = fillFrom(current, pointer, read);
    attempts.push({ source: 'pointer', path: pointer, ...(r.problem ? { problem: r.problem } : {}) });
    if (!r.problem) return { env: r.env, attempts };
    if (r.problem === 'no_token') current = r.env;
  }
  const turnDir = env.AOM_CEO_TURN_DIR;
  if (turnDir && isAbsolute(turnDir)) {
    const path = join(turnDir, LEGACY_SHIFT_ENV_FILE);
    const r = fillFrom(current, path, read);
    attempts.push({ source: 'legacy', path, ...(r.problem ? { problem: r.problem } : {}) });
    if (!r.problem || r.problem === 'no_token') current = r.env;
  }
  return { env: current, attempts };
}

const REASONS: Record<ShiftEnvProblem, string> = {
  not_absolute: 'the path is not absolute',
  missing: 'the file does not exist (the session may have ended)',
  unreadable: 'the file cannot be read',
  too_large: 'the file is larger than 8 KiB',
  invalid: 'the file is not valid JSON',
  no_token: 'the file holds no AOM_SHIFT_TOKEN',
};

/** The error `aom` shows when no shift token was found. Names the pointer variable and every path tried, never content. */
export function missingTokenMessage(env: NodeJS.ProcessEnv, attempts: ShiftEnvAttempt[] = []): string {
  const pointer = env[SHIFT_ENV_POINTER];
  const ptr = attempts.find((a) => a.source === 'pointer');
  const legacy = attempts.find((a) => a.source === 'legacy');
  const also = legacy ? `; also tried ${legacy.path}` : '';
  if (pointer) {
    const reason = ptr?.problem ? REASONS[ptr.problem] : REASONS.no_token;
    return `AOM_SHIFT_TOKEN is not in the environment and ${SHIFT_ENV_POINTER} (${pointer}) gave no token: ${reason}${also}`;
  }
  return `AOM_SHIFT_TOKEN and ${SHIFT_ENV_POINTER} are not set: \`aom\` only works inside an agent shift${also}`;
}

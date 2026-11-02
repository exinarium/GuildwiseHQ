import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * The shift variables every CEO owner turn (auto and bypass) hands to `aom`. A bypass turn runs Claude Code with its
 * subprocess environment scrub on, which strips credential-named variables (AOM_SHIFT_TOKEN) from every Bash child. So the
 * same values are also written to `<turnDir>/shift-env.json` (0600), and the `aom` entry fills in what is missing from it.
 */
export const OWNER_SHIFT_KEYS = [
  'AOM_IPC_URL',
  'AOM_IPC_SOCKET',
  'AOM_SHIFT_TOKEN',
  'AOM_SHIFT_ID',
  'AOM_CEO_TURN_DIR',
] as const;

export const SHIFT_ENV_FILE = 'shift-env.json';
const MAX_BYTES = 8 * 1024;

export interface OwnerShiftInput {
  ipcUrl: string;
  socketPath?: string | undefined;
  token: string;
  chatId: string;
  turnDir: string;
}

/** The one step that builds the shift variables, for both permission modes. */
export function ownerTurnShiftEnv(i: OwnerShiftInput): Record<string, string> {
  return {
    AOM_IPC_URL: i.ipcUrl,
    ...(i.socketPath ? { AOM_IPC_SOCKET: i.socketPath } : {}),
    AOM_SHIFT_TOKEN: i.token,
    AOM_SHIFT_ID: i.chatId,
    AOM_CEO_TURN_DIR: i.turnDir,
  };
}

/** Writes the shift variables for the `aom` entry to read back (owner-only file). */
export function writeShiftEnvFile(turnDir: string, env: Record<string, string>): void {
  const out: Record<string, string> = {};
  for (const k of OWNER_SHIFT_KEYS) {
    const v = env[k];
    if (typeof v === 'string') out[k] = v;
  }
  const file = join(turnDir, SHIFT_ENV_FILE);
  writeFileSync(file, JSON.stringify(out), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // not supported on every platform
  }
}

/**
 * Returns `env` with any MISSING shift variable filled from `<AOM_CEO_TURN_DIR>/shift-env.json`. Values already in the
 * environment always win. Does nothing when the token and the URL are both present, or when the turn dir is not absolute.
 */
export function resolveShiftEnv(
  env: NodeJS.ProcessEnv,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): NodeJS.ProcessEnv {
  if (env.AOM_SHIFT_TOKEN && env.AOM_IPC_URL) return env;
  const dir = env.AOM_CEO_TURN_DIR;
  if (!dir || !isAbsolute(dir)) return env;
  try {
    const text = read(join(dir, SHIFT_ENV_FILE));
    if (text.length > MAX_BYTES) return env;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return env;
    const filled: NodeJS.ProcessEnv = { ...env };
    for (const k of OWNER_SHIFT_KEYS) {
      const v = (parsed as Record<string, unknown>)[k];
      if (!filled[k] && typeof v === 'string' && v) filled[k] = v;
    }
    return filled;
  } catch {
    return env;
  }
}

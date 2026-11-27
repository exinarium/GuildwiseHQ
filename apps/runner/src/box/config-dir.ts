import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * quiet-approvals phase B, S9: a fresh Claude config dir per box level and request, `<agent dir>/config/<level>/<id>`,
 * reset to an allowlist at every start: the runner's own `settings.json` and `mcp.json`, and the transcript of the session
 * being resumed (for this request and level only). Everything else (`CLAUDE.md`, `agents/`, `commands/`, `skills/`,
 * `plugins/`, `hooks/`, any other file) is deleted first, so an inner-box shift (no click) cannot leave instructions for the
 * next approved outer session.
 */

export type BoxLevel = 'inner' | 'outer';

const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;

export function boxConfigDir(agentDir: string, level: BoxLevel, requestId: string): string {
  if (!SAFE_ID.test(requestId)) throw new Error(`not a request id: ${requestId}`);
  return join(agentDir, 'config', level, requestId);
}

export interface ConfigReset {
  settings: unknown;
  mcp: unknown;
  /** The instructions file the runner writes itself (CLAUDE.md), from the brief: the only one the session reads. */
  instructions?: string;
  /** The session to resume: its transcript stays (under `projects/`), every other transcript goes. */
  keepSession?: string;
}

/**
 * Resets the dir to the allowlist and writes the runner's files. Returns the dir. A transcript is kept only when its file
 * name is the resumed session id (`projects/<cwd-key>/<sessionId>.jsonl`).
 */
export function resetBoxConfigDir(dir: string, r: ConfigReset): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const keep = r.keepSession && SAFE_ID.test(r.keepSession) ? `${r.keepSession}.jsonl` : null;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split(sep);
      if (rel[0] === 'projects') {
        if (e.isDirectory() && !e.isSymbolicLink()) {
          walk(p);
          if (readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
          continue;
        }
        if (e.isFile() && keep && rel.length === 3 && e.name === keep) continue;
      }
      rmSync(p, { recursive: true, force: true });
    }
  };
  walk(dir);
  writeBoxSettings(dir, r.settings);
  writeFileSync(join(dir, 'mcp.json'), `${JSON.stringify(r.mcp, null, 2)}\n`, { mode: 0o600 });
  if (r.instructions !== undefined) writeFileSync(join(dir, 'CLAUDE.md'), r.instructions, { mode: 0o600 });
  return dir;
}

/** (Re)writes the settings file of a reset config dir (devops-box-access: the final settings, once the box plan is built). */
export function writeBoxSettings(dir: string, settings: unknown): void {
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/** What is left in a reset dir (for tests and the doctor). */
export function boxConfigEntries(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

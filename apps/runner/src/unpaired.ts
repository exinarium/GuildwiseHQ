import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runnerPaths } from './paths.ts';
import { DEVOPS_MARKER, wipeAgentSync } from './sandbox/sandbox.ts';

/**
 * A pairing that was unpaired (or is re-paired to another workstation) must not carry the old workstation's work:
 * persisted active shifts, the outbox and the DevOps engineers' directories (marked with `.devops`) are removed.
 * Other agents' directories stay: those agents are still active on the server.
 */
export function clearUnpairedState(dir: string): void {
  const paths = runnerPaths(dir);
  rmSync(paths.activeShifts, { recursive: true, force: true });
  rmSync(paths.outbox, { recursive: true, force: true });
  if (!existsSync(paths.agents)) return;
  for (const name of readdirSync(paths.agents)) {
    const d = join(paths.agents, name);
    try {
      const st = lstatSync(d);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (!existsSync(join(d, DEVOPS_MARKER))) continue;
      wipeAgentSync(paths, name);
    } catch {
      // best effort
    }
  }
}

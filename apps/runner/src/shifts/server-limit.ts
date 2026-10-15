import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ShiftLimitSettingSchema } from '@aom/shared';
import { z } from 'zod';

/**
 * The shift limit the workstation's owner chose on the Workstations page (backlog #76), kept next to the runner's data so
 * it applies again after a restart before the server has said anything. `config.json`'s `maxConcurrentShifts` stays the
 * fallback: when the owner chose nothing, or the server is an older one that does not send a choice.
 */
const FileSchema = z.object({
  /** The owner's choice: a number or `unlimited` (null is never stored, it removes the file). */
  shiftLimit: ShiftLimitSettingSchema,
  /** What the server enforced when it was saved (the choice under the platform ceiling). */
  maxConcurrentShifts: z.number().int().positive(),
  savedAt: z.string(),
});
export type ServerShiftLimit = z.infer<typeof FileSchema>;

export function loadServerLimit(file: string): ServerShiftLimit | null {
  try {
    if (!existsSync(file)) return null;
    const p = FileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return p.success && p.data.shiftLimit !== null ? p.data : null;
  } catch {
    return null;
  }
}

export function saveServerLimit(
  file: string,
  limit: Omit<ServerShiftLimit, 'savedAt'>,
  now = new Date(),
): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...limit, savedAt: now.toISOString() }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, file);
}

export function clearServerLimit(file: string): void {
  rmSync(file, { force: true });
}

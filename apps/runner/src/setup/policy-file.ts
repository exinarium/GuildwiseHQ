import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_POLICY,
  POLICY_FILE,
  POLICY_FILE_MODE,
  type Policy,
  PolicySchema,
} from '../policy/schema.ts';

/** `~/.config/aom-runner/policy.json` of the account the runner runs as (R18-S). */
export function policyPath(home: string): string {
  return join(home, '.config', 'aom-runner', POLICY_FILE);
}

/** The local policy, or the safe default when the file does not exist yet. Throws on a damaged file. */
export function readPolicy(file: string): Policy {
  if (!existsSync(file)) return structuredClone(DEFAULT_POLICY);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON: fix or remove it, then run setup again`);
  }
  const r = PolicySchema.safeParse(raw);
  if (!r.success)
    throw new Error(
      `${file} is not a valid policy (${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`,
    );
  return r.data;
}

/** Writes the policy atomically, mode 600 in a 700 folder. Validates it first, so an invalid policy is never written. */
export function writePolicy(file: string, policy: Policy): Policy {
  const valid = PolicySchema.parse(policy);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(file), 0o700);
  } catch {
    // Windows
  }
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { mode: POLICY_FILE_MODE, flag: 'wx' });
  try {
    chmodSync(tmp, POLICY_FILE_MODE);
  } catch {
    // Windows
  }
  renameSync(tmp, file);
  return valid;
}

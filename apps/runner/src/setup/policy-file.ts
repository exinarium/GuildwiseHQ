import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertNotAgentSession, checkSeal, keyLost, readPolicyKey, seal } from '../policy/integrity.ts';
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
export function readPolicy(file: string, sealMarker?: string): Policy {
  if (!existsSync(file)) return structuredClone(DEFAULT_POLICY);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON: fix or remove it, then run setup again`);
  }
  // runner-authority-fixes T2: with a key on this machine the file must carry its seal (setup never launders an edit)
  const { check, body } = checkSeal(dirname(file), raw);
  // Rework 1 (S1): the store's keyless rule. A key that went missing on a policy that was sealed before (toolchain pins, or
  // the adoption marker) is tampering, never a fresh start that setup may seal again with a new key
  const sealedBefore =
    check === 'no_key' &&
    ((!!body && 'toolchainPins' in body) ||
      (raw !== null && typeof raw === 'object' && 'integrity' in raw) ||
      (!!sealMarker && existsSync(sealMarker)) ||
      // quiet-approvals S3: a key was used here before and is gone now
      keyLost(dirname(file)));
  if (check === 'bad' || check === 'unsealed' || sealedBefore)
    throw new Error(
      `${file} was changed outside the runner (its seal does not match): check it, then run \`guildwise-runner policy accept\` and setup again`,
    );
  const r = PolicySchema.safeParse(body);
  if (!r.success)
    throw new Error(
      `${file} is not a valid policy (${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`,
    );
  return r.data;
}

/** Writes the policy atomically, mode 600 in a 700 folder. Validates it first, so an invalid policy is never written. */
export function writePolicy(file: string, policy: Policy): Policy {
  assertNotAgentSession();
  const valid = PolicySchema.parse(policy);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(file), 0o700);
  } catch {
    // Windows
  }
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  // T2: sealed with the runner's key when it exists; before the runner's first start it stays unsealed (and without the
  // empty toolchain pins) so the runner adopts it once (Rework 1, S1)
  const key = readPolicyKey(dirname(file));
  const { toolchainPins, ...legacy } = valid;
  const out = key ? seal(key, valid) : toolchainPins.length ? valid : legacy;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: POLICY_FILE_MODE, flag: 'wx' });
  try {
    chmodSync(tmp, POLICY_FILE_MODE);
  } catch {
    // Windows
  }
  renameSync(tmp, file);
  return valid;
}

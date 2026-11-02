import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OWNER_SHIFT_KEYS,
  ownerTurnShiftEnv,
  resolveShiftEnv,
  SHIFT_ENV_FILE,
  writeShiftEnvFile,
} from '../src/ceo/shift-env.ts';
import { writeTurnFiles } from '../src/ceo/turn-files.ts';

const base = (dir: string) =>
  ownerTurnShiftEnv({
    ipcUrl: 'http://127.0.0.1:1',
    socketPath: '/s/ipc.sock',
    token: 'tok-1',
    chatId: 'chat-1',
    turnDir: dir,
  });

/** What Claude Code's subprocess scrub does to a Bash child: credential-named variables are gone. */
const scrub = (env: Record<string, string>): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of Object.keys(out)) if (/TOKEN|SECRET|KEY|PASSWORD/i.test(k)) delete out[k];
  return out;
};

describe('owner turn shift environment', () => {
  it('carries every shift variable, with the turn values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-shift-'));
    const env = base(dir);
    for (const k of OWNER_SHIFT_KEYS) expect(env[k], k).toBeTruthy();
    expect(env.AOM_SHIFT_ID).toBe('chat-1');
    expect(env.AOM_CEO_TURN_DIR).toBe(dir);
  });

  it.each(['owner', 'order'] as const)('writeTurnFiles writes an owner-only shift-env.json (%s)', (mode) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'aom-shift-')), 't');
    const env = base(dir);
    writeTurnFiles({
      turnDir: dir,
      brief: 'b',
      mode,
      shiftEnv: env,
      runnerRoots: ['/h/.r'],
      pid: 1,
      clones: [],
      home: '/h',
    });
    expect(statSync(join(dir, SHIFT_ENV_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, SHIFT_ENV_FILE), 'utf8'))).toEqual(env);
  });

  it('after the scrub, aom still resolves all variables from the turn dir (bypass)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'aom-shift-')), 't');
    const env = base(dir);
    writeTurnFiles({
      turnDir: dir,
      brief: 'b',
      mode: 'owner',
      shiftEnv: env,
      runnerRoots: ['/h/.r'],
      pid: 1,
      clones: [],
      home: '/h',
    });
    const scrubbed = scrub(env);
    expect(scrubbed.AOM_SHIFT_TOKEN).toBeUndefined();
    const resolved = resolveShiftEnv(scrubbed);
    for (const k of OWNER_SHIFT_KEYS) expect(resolved[k], k).toBe(env[k]);
  });

  it('never overrides a present variable and ignores a relative or missing turn dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-shift-'));
    writeShiftEnvFile(dir, base(dir));
    expect(resolveShiftEnv({ AOM_CEO_TURN_DIR: dir, AOM_SHIFT_TOKEN: 'mine' }).AOM_SHIFT_TOKEN).toBe('mine');
    const full = { AOM_CEO_TURN_DIR: dir, AOM_SHIFT_TOKEN: 'a', AOM_IPC_URL: 'u' };
    expect(resolveShiftEnv(full)).toBe(full);
    const rel = { AOM_CEO_TURN_DIR: 'rel' };
    expect(resolveShiftEnv(rel)).toBe(rel);
    expect(resolveShiftEnv({ AOM_CEO_TURN_DIR: join(dir, 'nope') }).AOM_SHIFT_TOKEN).toBeUndefined();
  });

  it('ignores a malformed, oversized or non-string file', () => {
    const e = { AOM_CEO_TURN_DIR: '/x' };
    expect(resolveShiftEnv(e, () => 'not json')).toBe(e);
    expect(resolveShiftEnv(e, () => 'x'.repeat(9000))).toBe(e);
    expect(resolveShiftEnv(e, () => '{"AOM_SHIFT_TOKEN":5}').AOM_SHIFT_TOKEN).toBeUndefined();
  });
});

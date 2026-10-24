import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexRolloutFile, readCodexRollout } from '../src/sessions/codex-rollout.ts';
import { SessionRegistry } from '../src/sessions/registry.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/** R3c: a shift may continue a Codex thread; the supervisor reads Codex's own rollout like it reads Claude transcripts. */
const ID = '01a16eb6-49ce-7c71-871e-176f261c7714';
const rollout = (id: string, cwd: string, tokens: number[]): string =>
  [
    JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-10-24T16:20:02.643Z' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    ...tokens.map((n) =>
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: n }, total_token_usage: {} },
        },
      }),
    ),
    '{"type":"event_msg","payload":{"type":"token_count","info":{"last_tok', // a half-written last line
  ].join('\n');

function agentDirs() {
  const root = tmp('aom-codex-resume-');
  const configDir = join(root, 'agents', 'ag1', 'claude');
  const codexHome = join(root, 'agents', 'ag1', 'codex');
  mkdirSync(configDir, { recursive: true });
  return { root, configDir, codexHome };
}
function writeRollout(codexHome: string, id: string, cwd: string, tokens: number[], day = '2026/10/24') {
  const dir = join(codexHome, 'sessions', day);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-10-24T18-20-02-${id}.jsonl`);
  writeFileSync(file, rollout(id, cwd, tokens));
  return file;
}

describe('the Codex rollout reader', () => {
  it('finds a thread by its id in any day folder and reads its id, folder and context size', () => {
    const { codexHome } = agentDirs();
    const file = writeRollout(codexHome, ID, '/work/wt', [100, 4200, 5300], '2026/09/30');
    expect(codexRolloutFile(codexHome, ID)).toBe(file);
    expect(readCodexRollout(file)).toEqual({ id: ID, cwd: '/work/wt', contextTokens: 5300, calls: 3 });
  });

  it('knows nothing of a missing thread, a foreign file or an id that is not a thread id', () => {
    const { codexHome, root } = agentDirs();
    expect(codexRolloutFile(codexHome, ID)).toBeUndefined();
    expect(codexRolloutFile(codexHome, '../../etc/passwd')).toBeUndefined();
    const f = join(root, 'junk.jsonl');
    writeFileSync(f, 'not json\n');
    expect(readCodexRollout(f)).toBeUndefined();
    expect(readCodexRollout(join(root, 'absent.jsonl'))).toBeUndefined();
  });
});

describe('resuming a Codex session', () => {
  const rec = (reg: SessionRegistry, over: Record<string, unknown> = {}) =>
    reg.record({ sessionId: ID, agentId: 'ag1', cwd: '/work/wt', runtime: 'codex', ...over });

  it('resumes a Codex thread whose rollout is in the agent’s Codex home (there is no Claude transcript for it)', () => {
    const { root, configDir, codexHome } = agentDirs();
    const reg = new SessionRegistry(join(root, 's.json'));
    writeRollout(codexHome, ID, '/work/wt', [900]);
    rec(reg, { contextTokens: 900 });
    expect(reg.decide(ID, 'ag1', configDir)).toEqual({ state: 'resumed' });
    // a Claude session with the same id and no transcript is still not resumable
    const reg2 = new SessionRegistry(join(root, 's2.json'));
    reg2.record({ sessionId: ID, agentId: 'ag1', cwd: '/work/wt' });
    expect(reg2.decide(ID, 'ag1', configDir).state).toBe('fresh_transcript_missing');
  });

  it('starts fresh when the rollout is gone, belongs to another agent, is over the size limit or too old', () => {
    const { root, configDir, codexHome } = agentDirs();
    let now = Date.parse('2026-10-24T10:00:00Z');
    const reg = new SessionRegistry(join(root, 's.json'), () => now);
    rec(reg, { contextTokens: 100 });
    expect(reg.decide(ID, 'ag1', configDir).state).toBe('fresh_transcript_missing');
    writeRollout(codexHome, ID, '/work/wt', [100]);
    expect(reg.decide(ID, 'other', configDir).state).toBe('fresh_other_agent');
    now += 5 * 3600_000;
    expect(reg.decide(ID, 'ag1', configDir).state).toBe('fresh_too_old');
    // the size is read from the rollout too: a record that never got its last update does not hide a big thread
    const big = '01a16eb6-49ce-7c71-871e-176f261c7999';
    const reg3 = new SessionRegistry(join(root, 's3.json'));
    writeRollout(codexHome, big, '/work/wt', [150_000]);
    reg3.record({ sessionId: big, agentId: 'ag1', cwd: '/work/wt', runtime: 'codex' });
    expect(reg3.decide(big, 'ag1', configDir).state).toBe('fresh_too_large');
  });

  it('keeps the runtime in the record and only for runtimes other than Claude Code', () => {
    const { root } = agentDirs();
    const file = join(root, 's.json');
    const reg = new SessionRegistry(file);
    rec(reg);
    reg.record({ sessionId: 'c1', agentId: 'ag1', cwd: '/w', runtime: 'claude-code' });
    expect(new SessionRegistry(file).get(ID)?.runtime).toBe('codex');
    expect(new SessionRegistry(file).get('c1')?.runtime).toBeUndefined();
  });
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapters/codex.ts';
import type { RuntimeEvent, ShiftStartInput } from '../src/adapters/types.ts';

/**
 * Opt-in: runs the REAL `codex` binary (AOM_CODEX_REAL_BIN=/path/to/codex) against a fake Responses API on localhost, so the
 * sandbox profile, the shell environment policy, skills discovery and the JSONL parser are checked against what Codex really
 * does (codex-cli 0.163.0). It spends no tokens and needs no login. Skipped otherwise.
 */
const BIN = process.env.AOM_CODEX_REAL_BIN;
const root = mkdtempSync(join(userInfo().homedir, '.aom-codex-real-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeApi(script: string, bodies: string[]): { server: Server; port: Promise<number> } {
  let calls = 0;
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
    });
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      calls++;
      bodies.push(b);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (t: string, d: object) =>
        res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev('response.created', { response: { id: `resp_${calls}` } });
      if (calls === 1)
        ev('response.output_item.done', {
          item: { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: script },
        });
      else
        ev('response.output_item.done', {
          item: {
            type: 'message',
            role: 'assistant',
            id: 'm1',
            content: [{ type: 'output_text', text: 'done' }],
          },
        });
      ev('response.completed', {
        response: {
          id: `resp_${calls}`,
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens: 10,
            output_tokens_details: { reasoning_tokens: 2 },
            total_tokens: 110,
          },
        },
      });
      res.end();
    });
  });
  const port = new Promise<number>((r) =>
    server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)),
  );
  return { server, port };
}

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

describe.skipIf(!BIN)('codex adapter against the real codex binary', () => {
  it('confines the shell, filters its env, finds the granted skill, and parses the real events', async () => {
    const dir = join(root, 'a');
    const sandbox = {
      home: join(dir, 'agent', 'home'),
      configDir: join(dir, 'agent', 'claude'),
      scratch: join(dir, 'agent', 'scratch'),
      tmp: join(dir, 'agent', 'tmp'),
    };
    for (const d of [sandbox.home, sandbox.configDir, sandbox.scratch, sandbox.tmp])
      mkdirSync(d, { recursive: true });
    // a repository with a linked worktree, as a card has
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    sh(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'hi');
    sh(repo, 'add', '.');
    sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    const wt = join(dir, 'wt');
    sh(repo, 'worktree', 'add', '-q', '-b', 'card', wt);
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET');
    const loginDir = join(dir, 'login');
    mkdirSync(loginDir);
    writeFileSync(
      join(loginDir, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-real-login', last_refresh: '2026-01-01T00:00:00Z' }),
    );
    const sockDir = join(dir, 'sockdir');
    mkdirSync(sockDir);
    const sock = join(sockDir, 'ipc.sock');
    const netServer = createNetServer((c) => c.end('pong')).listen(sock);
    const nodeBin = dirname(realpathSync(process.execPath));
    // a stand-in for the aom shim: connects to the runner's Unix socket
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, 'aom'),
      `#!${join(nodeBin, 'node')}\nrequire('net').connect(process.env.AOM_IPC_SOCKET).on('data', d => console.log('AOM:' + String(d))).on('error', e => console.log('AOMERR:' + e.code));\n`,
      { mode: 0o755 },
    );
    const lines = [
      'echo "ENV=$(env | grep -v "^CODEX_\\|^PATH=\\|^_=" | sort | tr "\\n" " ")"',
      `echo "SECRET=$(cat ${outside}/secret.txt >/dev/null 2>&1 && echo readable || echo hidden)"`,
      `echo "LOGIN=$(cat ${loginDir}/auth.json >/dev/null 2>&1 && echo readable || echo hidden)"`,
      `echo "AUTHJSON=$(cat ${dir}/agent/codex/auth.json >/dev/null 2>&1 && echo readable || echo hidden)"`,
      'echo "WRITE_WT=$(echo x > ./made 2>&1 && echo ok)"',
      `echo "WRITE_OUT=$(echo x > ${outside}/made 2>&1 && echo ok)"`,
      'echo "NET=$(curl -s -m 3 -o /dev/null https://example.com && echo yes || echo no)"',
      `echo "SOCK=$(node -e "require('net').connect(process.env.AOM_IPC_SOCKET).on('data',d=>console.log(String(d)))" 2>&1 | grep -o "Error: [A-Z]* *[a-z ]*\\|pong" | head -1)"`,
      'echo "SKILLS=$(ls $HOME/.agents/skills 2>&1 | head -c 60)"',
      // git prints a harmless "Unable to create packed-refs.lock" while it clears MERGE_AUTOSTASH: the commit itself succeeds
      'echo "COMMIT=$(git add made && git -c user.name=t -c user.email=t@t commit -qm card >/dev/null 2>&1 && echo ok)"',
      'echo "PUSH=$(git push 2>&1 | head -c 80)"',
      `echo "CONFIG=$(echo x >> ${repo}/.git/config 2>&1 && echo ok)"`,
      'echo "END"',
    ];
    const sandboxCmd = lines.join('\n');
    const script = [
      `const r = await tools.exec_command({cmd: ${JSON.stringify(sandboxCmd)}, login: false});`,
      "text(typeof r === 'string' ? r : JSON.stringify(r));",
      "const a = await tools.exec_command({cmd: 'aom report', login: false});",
      "text('AOMCALL=' + (typeof a === 'string' ? a : JSON.stringify(a)));",
      // the model asks for an unsandboxed run: with approval_policy never it must not happen
      `const e = await tools.exec_command({cmd: ${JSON.stringify(`echo x > ${outside}/escaped && echo ESCAPED`)}, login: false, sandbox_permissions: 'require_escalated', justification: 'please'});`,
      "text('ESC=' + (typeof e === 'string' ? e : JSON.stringify(e)));",
    ].join('\n');
    const bodies: string[] = [];
    const api = fakeApi(script, bodies);
    const port = await api.port;
    const adapter = new CodexAdapter(
      {
        enabled: true,
        bin: BIN as string,
        authMode: 'login',
        loginDir,
        toolchainPaths: [],
        sandbox: 'native',
      },
      undefined,
      {
        extraArgs: ['-c', `openai_base_url="http://127.0.0.1:${port}/v1"`],
        parent: { PATH: process.env.PATH ?? '', RUNNER_SECRET: 'leak-me' },
      },
    );
    const input = {
      shiftId: 's1',
      prompt: 'do it',
      instructionsMarkdown: '# role',
      cwd: wt,
      sandbox,
      agent: {
        agentId: 'a1',
        name: 'x',
        roleKey: 'builder',
        seniority: 'senior',
        runtime: 'codex',
        model: 'gpt-6-sol',
        skills: [],
        permissions: {
          allowedTools: ['read', 'edit', 'shell'],
          deniedShellPatterns: ['git push*'],
          writableGlobs: null,
          mayCommit: true,
          browser: false,
          riskTiers: ['small'],
          readOrgRepos: false,
          repoIds: null,
        },
      },
      env: {
        HOME: sandbox.home,
        PATH: `${binDir}:${nodeBin}:/usr/bin:/bin`,
        AOM_SHIFT_TOKEN: 'tok-123',
        AOM_IPC_SOCKET: sock,
        CLAUDE_CONFIG_DIR: sandbox.configDir,
      },
      addDirs: [],
      maxShiftMinutes: 5,
      logFile: join(dir, 'shift.jsonl'),
      grantedSkills: [
        {
          name: 'demo-skill',
          files: { 'SKILL.md': '---\nname: demo-skill\ndescription: use the demo flavour\n---\nbody' },
        },
      ],
    } as unknown as ShiftStartInput;
    await adapter.writeInstructions(sandbox, '# Instructions\nbe good');
    const session = await adapter.start(input);
    const events: RuntimeEvent[] = [];
    for await (const e of session.events()) events.push(e);
    netServer.close();
    api.server.close();
    const raw = readFileSync(join(dir, 'shift.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; item?: { type: string; aggregated_output?: string } });
    const outputs = raw
      .filter((e) => e.type === 'item.completed' && e.item?.type === 'command_execution')
      .map((e) => e.item?.aggregated_output ?? '');
    const probe = outputs[0] ?? '';
    const field = (name: string): string => new RegExp(`^${name}=(.*)$`, 'm').exec(probe)?.[1] ?? '';
    expect(events.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    // the shell's environment: the session variables only
    expect(field('ENV')).toContain(`AOM_SHIFT_TOKEN=tok-123`);
    expect(field('ENV')).toContain(`AOM_IPC_SOCKET=${sock}`);
    expect(field('ENV')).not.toMatch(/leak-me|RUNNER_SECRET|CLAUDE_CONFIG_DIR|API_KEY|sk-real/);
    // files outside the allow-list do not exist for the shell, auth.json included
    expect(field('SECRET')).toBe('hidden');
    expect(field('LOGIN')).toBe('hidden');
    expect(field('AUTHJSON')).toBe('hidden');
    expect(field('WRITE_WT')).toBe('ok');
    expect(field('WRITE_OUT')).not.toBe('ok');
    expect(field('NET')).toBe('no');
    expect(field('SOCK')).not.toBe('pong'); // no socket from inside the sandbox
    expect(outputs.join('\n')).toContain('AOM:pong'); // the aom CLI runs outside it
    expect(field('SKILLS')).toBe('demo-skill');
    expect(field('COMMIT')).toBe('ok');
    expect(sh(wt, 'log', '--format=%s', '-1')).toBe('card');
    // git push: the rule forbids it, and without a network it could not work anyway
    expect(field('PUSH')).not.toMatch(/^$/);
    expect(field('CONFIG')).not.toBe('ok');
    // the model's request for an unsandboxed run was not honoured
    expect(outputs.join('\n')).not.toContain('ESCAPED');
    expect(() => readFileSync(join(outside, 'escaped'))).toThrow();
    // Codex read the agent's AGENTS.md and found the granted skill; the runner's environment did not travel
    const sent = bodies.join('\n');
    expect(sent).toContain('be good');
    expect(sent).toContain('demo-skill');
    expect(sent).not.toContain('leak-me');
    // the real events, parsed
    expect(events.find((e) => e.kind === 'session')).toBeDefined();
    expect(events.filter((e) => e.kind === 'tool').length).toBeGreaterThanOrEqual(1);
    expect(events.find((e) => e.kind === 'usage')).toMatchObject({
      usage: { inputTokens: 120, cacheReadTokens: 80, outputTokens: 20, model: 'codex:gpt-6-sol' },
    });
    expect(events.find((e) => e.kind === 'final')).toMatchObject({ text: 'done' });
  }, 120_000);
});

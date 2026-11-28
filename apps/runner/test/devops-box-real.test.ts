import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { sessionEnv } from '../src/adapters/claude-code.ts';
import { buildDevopsBoxSettings, forRunnerBox } from '../src/adapters/claude-policy.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox, sandboxEnv } from '../src/sandbox/sandbox.ts';
import { cleanupTmp } from './helpers.ts';
import { policyCtx } from './policy-fixtures.ts';

cleanupTmp();

/**
 * quiet-approvals [B2], the real sandbox test (Linux): the REAL Claude Code binary runs a DevOps shift inside the box
 * with the settings the runner generates, against a local fake Anthropic API that asks for a list of tool calls. No
 * tokens are spent and nothing leaves the machine. A box shift cannot write the project's package files, `.npmrc`, the
 * clone's `.git/hooks` and `config`, the toolchains folder, or read the policy folder and its key, through Bash AND
 * through Claude's own Write and Read tools; it can write its own folder. Skipped without `claude` and bubblewrap.
 */
const CLAUDE = [process.env.AOM_CLAUDE_BIN, join(userInfo().homedir, '.local', 'bin', 'claude')].find(
  (p): p is string => !!p && existsSync(p),
);
const bwrapOk =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], { encoding: 'utf8' }).status === 0;
const enabled = CLAUDE !== undefined && bwrapOk;

const HOME_BASE = join(userInfo().homedir, '.aom-real-box-test');
const servers: Server[] = [];
afterAll(() => {
  rmSync(HOME_BASE, { recursive: true, force: true });
  for (const s of servers) s.close();
});

type Call = { name: string; input: Record<string, unknown> };

/** A fake /v1/messages that asks for `calls` one after the other and records every tool result, in order. */
async function fakeToolApi(calls: Call[]): Promise<{ url: string; results: string[] }> {
  const results: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {}
      if (!req.url?.startsWith('/v1/messages') || !body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'x',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
        return;
      }
      const toolResults = (body.messages ?? [])
        .flatMap((m: any) => (Array.isArray(m?.content) ? m.content : []))
        .filter((b: any) => b.type === 'tool_result');
      for (const r of toolResults.slice(results.length))
        results.push(typeof r.content === 'string' ? r.content : JSON.stringify(r.content));
      const next = calls[toolResults.length];
      const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const base = { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model ?? 'x' };
      let out = sse('message_start', {
        type: 'message_start',
        message: {
          ...base,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      if (next) {
        out += sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: `toolu_${toolResults.length}`, name: next.name, input: {} },
        });
        out += sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(next.input) },
        });
        out += sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        out += sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 5 },
        });
      } else {
        out += sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        out += sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'done' },
        });
        out += sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        out += sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        });
      }
      out += sse('message_stop', { type: 'message_stop' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(out);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, results };
}

async function runBox(
  calls: (w: World) => Call[],
  /**
   * gate-fixes-1 F1: the settings of the box the RUNNER builds (Claude's own sandbox off: the box fences the shell).
   * `fixed`: as the runner writes them now (`forRunnerBox`, the file-tool block in a `--settings` launch file); `old`: as
   * cfbc8864 wrote them (only the sandbox block removed, `blockReadsOutsideWorkingDirectories` kept).
   */
  runnerBuilt?: 'fixed' | 'old',
): Promise<{ results: string[]; world: World; stderr: string }> {
  mkdirSync(HOME_BASE, { recursive: true });
  const root = realpathSync(mkdtempSync(join(HOME_BASE, 'r-')));
  const paths = runnerPaths(root);
  const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
  const sb = await ensureSandbox(paths, A, 'Forge');
  const cwd = join(sb.root, 'devops', '019e3f6a-7b1c-7a2d-8c3e-0123456789b2');
  mkdirSync(cwd, { recursive: true });
  // the project's clone (read-only in the box) and the runner's private folders
  const clone = join(root, 'code', 'toy');
  mkdirSync(join(clone, 'src'), { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', clone]);
  writeFileSync(join(clone, 'package.json'), '{"name":"toy"}\n');
  // the runner's own CLI (readable to the box's shell, never to Claude's file tools)
  mkdirSync(paths.bin, { recursive: true });
  writeFileSync(join(paths.bin, 'aom'), '#!/bin/sh\necho AOM-SHIM-CONTENT\n');
  writeFileSync(join(clone, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  const policyDir = join(root, 'policy');
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(join(policyDir, 'policy.key'), 'k'.repeat(32));
  writeFileSync(join(policyDir, 'policy.json'), '{}');
  const toolchains = join(root, 'toolchains');
  mkdirSync(toolchains, { recursive: true });
  const world: World = { root, cwd, clone, policyDir, toolchains };
  const p = BUILTIN_ROLES.find((r) => r.key === 'devops')?.permissions;
  if (!p) throw new Error('no devops role');
  const settings = buildDevopsBoxSettings(
    p,
    policyCtx({
      runnerRoot: root,
      agentDir: paths.agentDir(A),
      cwd,
      readDirs: [clone],
      aomReadPaths: [paths.bin],
      realHome: userInfo().homedir,
      sharedCacheDir: sb.cacheRoot,
      policyDir,
    }),
    sb,
  );
  mkdirSync(sb.configDir, { recursive: true });
  const launchFile = `${sb.configDir}.launch.json`;
  let written: unknown = settings;
  if (runnerBuilt === 'fixed') {
    const rb = forRunnerBox(settings, 'inner');
    written = rb.settings;
    writeFileSync(launchFile, JSON.stringify(rb.launch));
  } else if (runnerBuilt === 'old') {
    const { sandbox: _sb, ...rest } = settings;
    written = rest;
  }
  writeFileSync(join(sb.configDir, 'settings.json'), JSON.stringify(written, null, 2));
  writeFileSync(join(sb.configDir, 'mcp.json'), '{"mcpServers":{}}');
  const api = await fakeToolApi(calls(world));
  const env = {
    ...sessionEnv(
      { env: sandboxEnv(sb), sandbox: sb, agent: { isDevops: true }, devopsBox: true },
      { bin: CLAUDE, authMode: 'default', sandbox: 'required', scrubSubprocessEnv: true } as never,
      { PATH: process.env.PATH ?? '', SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? '/tmp/none' },
    ),
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'sk-ant-fake-fake-fake',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  const child = spawn(
    CLAUDE as string,
    [
      '-p',
      'run the probe',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-opus-5-5',
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      'user',
      ...(runnerBuilt === 'fixed' ? ['--settings', launchFile] : []),
      '--strict-mcp-config',
      '--mcp-config',
      join(sb.configDir, 'mcp.json'),
      '--add-dir',
      clone,
    ],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  child.stdout.on('data', () => undefined);
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  await new Promise((r) => child.on('close', r));
  clearTimeout(timer);
  return { results: api.results, world, stderr };
}

interface World {
  root: string;
  cwd: string;
  clone: string;
  policyDir: string;
  toolchains: string;
}

describe.skipIf(!enabled)(
  'the DevOps box with the real Claude Code sandbox (skipped without claude + bwrap)',
  () => {
    it('Bash: the clone, its git admin, the toolchains and the policy are out of reach; its own folder works', async () => {
      const bash = (w: World) =>
        [
          `echo OWN > ${w.cwd}/own.txt && echo OWN-OK`,
          `echo x >> ${w.clone}/package.json && echo PKG-WRITTEN`,
          `echo x >> ${w.clone}/.npmrc && echo NPMRC-WRITTEN`,
          `echo x > ${w.clone}/.git/hooks/pre-commit && echo HOOK-WRITTEN`,
          `echo x >> ${w.clone}/.git/config && echo GITCONFIG-WRITTEN`,
          `touch ${w.toolchains}/evil && echo TOOLCHAIN-WRITTEN`,
          `cat ${w.policyDir}/policy.key && echo KEY-READ`,
          `echo SSH=$SSH_AUTH_SOCK HOME=$HOME`,
        ].join('; ');
      const { results, world, stderr } = await runBox((w) => [
        { name: 'Bash', input: { command: bash(w), description: 'probe' } },
      ]);
      const out = results.join('\n');
      expect(out, stderr).toContain('OWN-OK');
      expect(readFileSync(join(world.cwd, 'own.txt'), 'utf8')).toBe('OWN\n');
      for (const bad of [
        'PKG-WRITTEN',
        'NPMRC-WRITTEN',
        'HOOK-WRITTEN',
        'GITCONFIG-WRITTEN',
        'TOOLCHAIN-WRITTEN',
        'KEY-READ',
      ])
        expect(out, bad).not.toContain(bad);
      expect(out).toContain('SSH= ');
      expect(readFileSync(join(world.clone, 'package.json'), 'utf8')).toBe('{"name":"toy"}\n');
      expect(existsSync(join(world.toolchains, 'evil'))).toBe(false);
    }, 180_000);

    it("Claude's own Write and Read tools: refused outside its folder, allowed inside", async () => {
      const { results, world } = await runBox((w) => [
        { name: 'Write', input: { file_path: join(w.clone, 'package.json'), content: '{"pwned":1}\n' } },
        {
          name: 'Write',
          input: { file_path: join(w.clone, '.git', 'hooks', 'post-checkout'), content: 'x' },
        },
        { name: 'Write', input: { file_path: join(w.toolchains, 'evil'), content: 'x' } },
        { name: 'Read', input: { file_path: join(w.policyDir, 'policy.key') } },
        { name: 'Write', input: { file_path: join(w.cwd, 'notes.md'), content: 'mine\n' } },
      ]);
      expect(results).toHaveLength(5);
      expect(readFileSync(join(world.clone, 'package.json'), 'utf8')).toBe('{"name":"toy"}\n');
      expect(existsSync(join(world.clone, '.git', 'hooks', 'post-checkout'))).toBe(false);
      expect(existsSync(join(world.toolchains, 'evil'))).toBe(false);
      expect(results[3]).not.toContain('kkkkkkkk');
      expect(readFileSync(join(world.cwd, 'notes.md'), 'utf8')).toBe('mine\n');
    }, 180_000);
  },
);

describe.skipIf(!enabled)(
  'gate-fixes-1 F1: the runner-built inner box settings with the real Claude Code (skipped without claude + bwrap)',
  () => {
    // the scratch clone of a conflict request sits in the request folder (the cwd); the gate's shift ran `cd <clone> && git`
    const calls = (w: World): Call[] => [
      { name: 'Bash', input: { command: 'git init -q -b main clone && echo MADE', description: 'probe' } },
      { name: 'Bash', input: { command: 'cd clone && git status | head -3', description: 'probe' } },
      { name: 'Bash', input: { command: 'cd /tmp && git --version', description: 'probe' } },
      { name: 'Bash', input: { command: 'git -C clone status | head -1', description: 'probe' } },
      { name: 'Read', input: { file_path: join(w.root, 'bin', 'aom') } },
      { name: 'Read', input: { file_path: join(w.clone, 'package.json') } },
    ];

    it('fixed: `cd <clone> && git status` runs; the Read tool still refuses the runner bin outside the working dirs', async () => {
      const { results, stderr } = await runBox(calls, 'fixed');
      expect(results, stderr).toHaveLength(6);
      expect(results[0]).toContain('MADE');
      expect(results[1]).toContain('On branch main');
      expect(results[2]).toContain('git version');
      expect(results[3]).toContain('On branch main');
      expect(results[4]).not.toContain('AOM-SHIM-CONTENT');
      expect(results[5]).toContain('"name":"toy"');
    }, 180_000);

    it('old (cfbc8864): the same compound `cd` plus `git` is denied (gate items 7 and 8)', async () => {
      const { results, stderr } = await runBox(calls, 'old');
      expect(results, stderr).toHaveLength(6);
      expect(results[1]).not.toContain('On branch main');
      expect(results[1]).toContain('blockReadsOutsideWorkingDirectories');
      expect(results[2]).toContain('blockReadsOutsideWorkingDirectories');
      expect(results[3]).toContain('On branch main');
    }, 180_000);
  },
);

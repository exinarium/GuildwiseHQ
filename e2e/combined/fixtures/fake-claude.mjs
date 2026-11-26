// runner-bare-bin [A11]: a stand-in for Claude Code inside the runner-built DevOps box. It is started by its real path (the
// box binds only the real install folder), by the runner's own Node, and does what Claude Code does that matters here:
// - prints stream-json (`system` init, `assistant` messages, a `result` line) on stdout for the runner's parser;
// - talks to the model only through ANTHROPIC_BASE_URL (the runner's model route) with the box's stand-in key;
// - runs every Bash `tool_use` the model asks for: first the PreToolUse hooks of its settings (`$CLAUDE_CONFIG_DIR/settings.json`;
//   exit 2 blocks), then the command, exactly as Claude Code's env scrub would: wrapped in `bwrap --unshare-pid` when
//   CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 (that nested sandbox fails with ENOSPC under the box's --disable-userns), else `/bin/sh -c`;
// - sends each result back as a `tool_result`, until the model answers with text.
// No dependencies: it must run from the read-only install folder with nothing else mounted.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const args = process.argv.slice(2);
// the runner's capability check (`claude --version`)
if (args.includes('--version')) {
  process.stdout.write('2.1.332 (Claude Code)\n');
  process.exit(0);
}
const pi = args.indexOf('-p');
let prompt = pi >= 0 && args[pi + 1] && !args[pi + 1].startsWith('--') ? args[pi + 1] : '';
if (!prompt) {
  try {
    prompt = readFileSync(0, 'utf8');
  } catch {
    prompt = '';
  }
}
const mi = args.indexOf('--model');
const model = mi >= 0 ? args[mi + 1] : 'claude-opus-5-5';
const configDir = process.env.CLAUDE_CONFIG_DIR ?? '';
const read = (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
const settings = (() => {
  try {
    return JSON.parse(read(join(configDir, 'settings.json')));
  } catch {
    return {};
  }
})();
const instructions = read(join(configDir, 'CLAUDE.md'));
const sessionId = `fake-${process.pid}-${Date.now()}`;
const base = (process.env.ANTHROPIC_BASE_URL ?? '').replace(/\/+$/, '');
const key = process.env.ANTHROPIC_API_KEY;
const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;

out({ type: 'system', subtype: 'init', session_id: sessionId, model, tools: ['Bash'], cwd: process.cwd() });

function hooksFor(event, tool) {
  const list = settings.hooks?.[event] ?? [];
  return list
    .filter((h) => !h.matcher || h.matcher === tool || new RegExp(`^(${h.matcher})$`).test(tool))
    .flatMap((h) => h.hooks ?? [])
    .filter((h) => h.type === 'command');
}

function runHooks(event, command) {
  for (const h of hooksFor(event, 'Bash')) {
    const r = spawnSync('/bin/sh', ['-c', h.command], {
      input: JSON.stringify({
        session_id: sessionId,
        transcript_path: '',
        cwd: process.cwd(),
        hook_event_name: event,
        tool_name: 'Bash',
        tool_input: { command },
      }),
      encoding: 'utf8',
      timeout: (h.timeout ?? 60) * 1000,
      env: process.env,
    });
    if (event === 'PreToolUse' && r.status === 2)
      return { blocked: (r.stderr || 'blocked by a hook').trim() };
  }
  return {};
}

function runCommand(command) {
  const scrub = process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === '1';
  const r = scrub
    ? spawnSync(
        'bwrap',
        [
          '--unshare-pid',
          '--bind',
          '/',
          '/',
          '--proc',
          '/proc',
          '--dev',
          '/dev',
          '--',
          '/bin/sh',
          '-c',
          command,
        ],
        {
          encoding: 'utf8',
          timeout: 120_000,
        },
      )
    : spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 120_000 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.slice(-4000);
  return { text: text || `(exit ${r.status})`, error: r.status !== 0 };
}

async function call(messages) {
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'user-agent': 'fake-claude/1',
  };
  if (key) headers['x-api-key'] = key;
  else if (oauth) headers.authorization = `Bearer ${oauth}`;
  const res = await fetch(`${base}/v1/messages?beta=true`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      stream: true,
      system: [{ type: 'text', text: 'You are a stand-in.' }],
      metadata: { user_id: sessionId },
      tools: [
        {
          name: 'Bash',
          description: 'Run a command',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      ],
      messages,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`API Error: ${res.status} ${body.slice(0, 300)}`);
  const blocks = [];
  let usage = { input_tokens: 0, output_tokens: 0 };
  let msgId = '';
  for (const chunk of body.split('\n\n')) {
    const data = chunk
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (!data) continue;
    const e = JSON.parse(data);
    if (e.type === 'message_start') {
      msgId = e.message.id;
      usage = { ...usage, ...e.message.usage };
    } else if (e.type === 'content_block_start') blocks[e.index] = { ...e.content_block, _json: '' };
    else if (e.type === 'content_block_delta') {
      const b = blocks[e.index];
      if (e.delta.type === 'text_delta') b.text = (b.text ?? '') + e.delta.text;
      if (e.delta.type === 'input_json_delta') b._json += e.delta.partial_json;
    } else if (e.type === 'message_delta' && e.usage) usage = { ...usage, ...e.usage };
  }
  const content = blocks.map(({ _json, ...b }) =>
    b.type === 'tool_use' ? { ...b, input: JSON.parse(_json || '{}') } : b,
  );
  return { id: msgId, content, usage };
}

const total = { input_tokens: 0, output_tokens: 0 };
const messages = [{ role: 'user', content: [{ type: 'text', text: `${instructions}\n\n${prompt}` }] }];
let final = '';
try {
  for (let turn = 0; turn < 40; turn++) {
    const r = await call(messages);
    total.input_tokens += r.usage.input_tokens ?? 0;
    total.output_tokens += r.usage.output_tokens ?? 0;
    out({
      type: 'assistant',
      message: { id: r.id, role: 'assistant', model, content: r.content, usage: r.usage },
      session_id: sessionId,
    });
    messages.push({ role: 'assistant', content: r.content });
    const uses = r.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) {
      final = r.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      break;
    }
    const results = [];
    for (const u of uses) {
      const command = String(u.input?.command ?? '');
      const pre = runHooks('PreToolUse', command);
      if (pre.blocked) {
        results.push({ type: 'tool_result', tool_use_id: u.id, content: pre.blocked, is_error: true });
        continue;
      }
      const res = runCommand(command);
      runHooks('PostToolUse', command);
      out({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: u.id, content: res.text }] },
        session_id: sessionId,
      });
      results.push({
        type: 'tool_result',
        tool_use_id: u.id,
        content: res.text,
        ...(res.error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: final,
    session_id: sessionId,
    num_turns: messages.length,
    usage: { ...total, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  process.exit(0);
} catch (err) {
  out({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: String(err),
    session_id: sessionId,
  });
  process.exit(1);
}

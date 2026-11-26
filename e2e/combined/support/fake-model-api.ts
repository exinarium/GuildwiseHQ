import { createServer, type Server } from 'node:http';

/**
 * runner-bare-bin [A11] / [A11-L2]: a scripted Anthropic Messages API on 127.0.0.1 (no tokens, nothing leaves the machine). The
 * boxes' model route (the runner's proxy, outside the box) forwards to it through the adapter's constructor test hook. It
 * answers each request with the next Bash `tool_use` of a command list, chosen from the conversation itself (the number of
 * `tool_result`s so far), and finally with plain text. Every answer carries a usage block; the totals are kept so a spec can
 * compare them with what the runner reported.
 */

export interface FakeApi {
  url: string;
  /** Usage the API returned so far (input, output), all requests. */
  totals(): { input: number; output: number; requests: number };
  /** The most requests the API had open at the same time. */
  maxInFlight(): number;
  /** Every request body seen (parsed), in order. */
  bodies: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface FakeApiScript {
  /** The commands of a conversation, given its whole text (markers in the prompt or the instructions choose the list). */
  commands(text: string): string[];
  /** A conversation the box started itself (a direct call through the route): answered with this one command. */
  direct?: { marker: string; command: string };
}

const USAGE_IN = 11;
const USAGE_OUT = 7;

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

export async function startFakeApi(script: FakeApiScript): Promise<FakeApi> {
  let input = 0;
  let output = 0;
  let requests = 0;
  let n = 0;
  const bodies: Array<Record<string, unknown>> = [];
  let active = 0;
  let maxActive = 0;
  const server: Server = createServer((req, res) => {
    active++;
    maxActive = Math.max(maxActive, active);
    res.on('close', () => {
      active--;
    });
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"no"}}');
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        res.writeHead(400);
        res.end('{}');
        return;
      }
      bodies.push(body);
      if (req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":10}');
        return;
      }
      requests++;
      input += USAGE_IN;
      output += USAGE_OUT;
      const text = JSON.stringify(body);
      const messages = (body.messages ?? []) as Array<{ content?: unknown }>;
      const results = messages
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type?: string }>) : []))
        .filter((b) => b.type === 'tool_result').length;
      let command: string | undefined;
      // a direct call is a one-message conversation whose message is exactly the marker (a later turn of the agent's own
      // conversation quotes the marker in its tool history and must not match)
      const first = messages.length === 1 ? (messages[0] as { content?: unknown }).content : undefined;
      if (script.direct && first === script.direct.marker) command = script.direct.command;
      else command = script.commands(text)[results];
      const id = `msg_fake_${++n}`;
      const toolId = `toolu_fake_${n}`;
      const model = typeof body.model === 'string' ? body.model : 'claude-opus-5-5';
      const usage = {
        input_tokens: USAGE_IN,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
      const content = command
        ? [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command, description: 'run it' } }]
        : [{ type: 'text', text: 'All done.' }];
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id,
            type: 'message',
            role: 'assistant',
            model,
            content,
            stop_reason: command ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: { ...usage, output_tokens: USAGE_OUT },
          }),
        );
        return;
      }
      const events: Array<Record<string, unknown>> = [
        {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage,
          },
        },
      ];
      if (command) {
        const json = JSON.stringify({ command, description: 'run it' });
        events.push(
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: json.slice(5) },
          },
          { type: 'content_block_stop', index: 0 },
        );
      } else
        events.push(
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'All done.' } },
          { type: 'content_block_stop', index: 0 },
        );
      events.push(
        {
          type: 'message_delta',
          delta: { stop_reason: command ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: { output_tokens: USAGE_OUT },
        },
        { type: 'message_stop' },
      );
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(events));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    totals: () => ({ input, output, requests }),
    maxInFlight: () => maxActive,
    bodies,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

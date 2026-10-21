import { createServer, type Server } from 'node:http';

export const fakeServers: Server[] = [];

/** A fake /v1/messages: the first turn calls Bash with `command`, the next turn (after the tool result) just ends. */
export async function fakeApi(command: string): Promise<{ url: string; results: string[] }> {
  const results: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {}
      const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      if (!req.url?.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const msgs: any[] = body.messages ?? [];
      const toolResult = msgs
        .flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
        .find((b: any) => b.type === 'tool_result');
      const hasBash = (body.tools ?? []).some((t: any) => t.name === 'Bash');
      if (toolResult && !results.length) {
        results.push(
          typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content),
        );
      }
      const base = { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model ?? 'x' };
      const usage = { input_tokens: 1, output_tokens: 1 };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ...base,
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage,
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const callBash = hasBash && !toolResult && msgs.length >= 1 && !results.length && !fired.v;
      let out = sse('message_start', {
        type: 'message_start',
        message: { ...base, content: [], stop_reason: null, stop_sequence: null, usage },
      });
      if (callBash) {
        fired.v = true;
        out += sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_fake1', name: 'Bash', input: {} },
        });
        out += sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ command, description: 'probe' }),
          },
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
          usage: { output_tokens: 5 },
        });
      }
      out += sse('message_stop', { type: 'message_stop' });
      res.end(out);
    });
  });
  const fired = { v: false };
  fakeServers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, results };
}

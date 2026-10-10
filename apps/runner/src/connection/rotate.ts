import { makeEnvelope, RUNNER_SUBPROTOCOL, ServerToRunnerSchema, WS_CLOSE } from '@aom/shared';
import WebSocket from 'ws';

/**
 * `aom-runner rotate-token`: asks the server for a new runner token over an authenticated socket
 * (docs/ARCHITECTURE.md section 18). The old token keeps working until the new one connects, so a failed save
 * never locks the workstation out. The caller stores the returned token.
 */
export function requestRotatedToken(opts: {
  url: string;
  token: string;
  timeoutMs?: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.url, RUNNER_SUBPROTOCOL, {
      headers: { Authorization: `Bearer ${opts.token}` },
      handshakeTimeout: opts.timeoutMs ?? 15_000,
    });
    let settled = false;
    const done = (err: Error | null, token?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close(1000);
      } catch {
        // already closed
      }
      if (err) reject(err);
      else resolve(token as string);
    };
    const timer = setTimeout(
      () => done(new Error('the server did not answer in time')),
      opts.timeoutMs ?? 15_000,
    );
    ws.on('open', () => ws.send(JSON.stringify(makeEnvelope('token.rotate', {}))));
    ws.on('message', (data) => {
      try {
        const parsed = ServerToRunnerSchema.safeParse(JSON.parse(data.toString()));
        if (parsed.success && parsed.data.type === 'token.rotated') done(null, parsed.data.token);
      } catch {
        // ignore noise
      }
    });
    ws.on('unexpected-response', (_req, res) =>
      done(new Error(`the server rejected the runner token (HTTP ${res.statusCode})`)),
    );
    ws.on('error', (err) => done(err));
    ws.on('close', (code) =>
      done(
        new Error(
          code === WS_CLOSE.unauthorized || code === WS_CLOSE.forbidden
            ? 'the server rejected the runner token'
            : `connection closed (${code}) before a new token arrived`,
        ),
      ),
    );
  });
}

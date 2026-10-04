import WebSocket from 'ws';
import { ORIGIN } from './app.ts';
import { until } from './world.ts';

/** A browser session on `/api/ws` (cookie + Origin), collecting every server message. */
export class Browser {
  msgs: any[] = [];
  closed: { code: number } | null = null;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString())));
    ws.on('close', (code) => {
      this.closed = { code };
    });
    ws.on('error', () => {});
  }
  static async open(
    baseUrl: string,
    cookie: string | null,
    origin: string | null = ORIGIN,
  ): Promise<Browser> {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/ws`, { headers });
    const b = new Browser(ws);
    await new Promise<void>((res) => {
      ws.once('open', () => res());
      ws.once('close', () => res());
      ws.once('error', () => res());
    });
    return b;
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  of(type: string) {
    return this.msgs.filter((m) => m.type === type);
  }
  async until(fn: () => boolean, ms = 30_000) {
    await until(async () => fn(), ms, 'browser message');
  }
  /** Resolves once the server has handled every message sent before (it handles one socket's messages in order). */
  async barrier() {
    const seen = this.of('pong').length;
    this.send({ type: 'ping' });
    await this.until(() => this.of('pong').length > seen, 30_000);
  }
  async hello(lastSeq?: number) {
    this.send({ type: 'hello', ...(lastSeq !== undefined ? { lastSeq } : {}) });
    await this.until(() => this.of('ready').length > 0);
  }
  close() {
    this.ws.close();
  }
}

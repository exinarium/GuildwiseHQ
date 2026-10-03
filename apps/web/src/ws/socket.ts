import {
  type BrowserToServer,
  type ProgressItem,
  RESYNC_THRESHOLD,
  type ServerToBrowser,
  ServerToBrowserSchema,
} from '@aom/shared';
import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { invalidateForEvent } from './invalidate.ts';

export type SocketState = 'connecting' | 'open' | 'closed';

type ProgressListener = (items: ProgressItem[], cardId: string | null) => void;

/** Single browser WebSocket to `/api/ws` with reconnect, `hello {lastSeq}` resume and shift watch bookkeeping. */
export class LiveSocket {
  private ws: WebSocket | null = null;
  private lastSeq: number | undefined;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = true;
  private mocked = false;
  private state: SocketState = 'closed';
  private stateListeners = new Set<() => void>();
  private watchers = new Map<string, Set<ProgressListener>>();

  constructor(
    private readonly qc: QueryClient,
    private readonly url: () => string = defaultUrl,
  ) {}

  getState = (): SocketState => this.state;
  subscribeState = (cb: () => void) => {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  };

  private setState(s: SocketState) {
    this.state = s;
    for (const cb of this.stateListeners) cb();
  }

  /** MSW dev mode: no real socket; the mock layer feeds messages through `handle`. */
  enableMockTransport(): void {
    this.mocked = true;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.mocked) {
      this.setState('open');
      return;
    }
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    this.setState('closed');
  }

  private open() {
    this.setState('connecting');
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.send({ type: 'hello', ...(this.lastSeq !== undefined ? { lastSeq: this.lastSeq } : {}) });
      for (const shiftId of this.watchers.keys()) this.send({ type: 'shift.watch', shiftId });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 25_000);
    };
    ws.onmessage = (e) => {
      try {
        this.handle(JSON.parse(String(e.data)));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      this.ws = null;
      this.setState('closed');
      if (this.stopped) return;
      const delay = Math.min(15_000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => ws.close();
  }

  send(msg: BrowserToServer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Feeds a server message in (also used by the MSW mock transport). */
  handle(raw: unknown): void {
    const parsed = ServerToBrowserSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg: ServerToBrowser = parsed.data;
    switch (msg.type) {
      case 'ready':
        this.setState('open');
        if (this.lastSeq === undefined || msg.seq - this.lastSeq > RESYNC_THRESHOLD)
          void this.qc.invalidateQueries();
        this.lastSeq = msg.seq;
        break;
      case 'event':
        this.lastSeq = Math.max(this.lastSeq ?? 0, msg.event.seq);
        invalidateForEvent(this.qc, msg.event);
        break;
      case 'resync':
        void this.qc.invalidateQueries();
        break;
      case 'presence':
        void this.qc.invalidateQueries({ queryKey: ['workstations'] });
        void this.qc.invalidateQueries({ queryKey: ['admin', 'workstations'] });
        break;
      case 'shift.progress':
        for (const cb of this.watchers.get(msg.shiftId) ?? []) cb(msg.items, msg.cardId);
        break;
      default:
        break;
    }
  }

  /** Live shift log: sends `shift.watch` and returns an unsubscribe that sends `shift.unwatch`. */
  watchShift(shiftId: string, cb: ProgressListener): () => void {
    let set = this.watchers.get(shiftId);
    if (!set) {
      set = new Set();
      this.watchers.set(shiftId, set);
      this.send({ type: 'shift.watch', shiftId });
    }
    set.add(cb);
    return () => {
      const s = this.watchers.get(shiftId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        this.watchers.delete(shiftId);
        this.send({ type: 'shift.unwatch', shiftId });
      }
    };
  }
}

function defaultUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/ws`;
}

let instance: LiveSocket | null = null;
export function initSocket(qc: QueryClient): LiveSocket {
  instance ??= new LiveSocket(qc);
  return instance;
}
export function getSocket(): LiveSocket | null {
  return instance;
}

export function useSocketState(): SocketState {
  return useSyncExternalStore(
    (cb) => instance?.subscribeState(cb) ?? (() => {}),
    () => instance?.getState() ?? 'closed',
  );
}

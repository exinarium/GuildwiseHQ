import {
  type BrowserToServer,
  type ProgressItem,
  RESYNC_THRESHOLD,
  type ServerToBrowser,
  ServerToBrowserSchema,
} from '@aom/shared';
import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { getActiveOrgId } from '../lib/activeOrg.ts';
import { invalidateForEvent } from './invalidate.ts';

export type SocketState = 'connecting' | 'open' | 'closed';

type ProgressListener = (items: ProgressItem[], cardId: string | null) => void;

/** What a chat panel hears about its conversation (docs/ARCHITECTURE.md section 20). */
export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: string }
  | { type: 'error'; reason: string };
type ChatListener = (ev: ChatEvent) => void;

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
  private chatListeners = new Map<string, Set<ChatListener>>();

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

  /** The tab switched organization: drop the connection and open a new one for it (no resume across organizations). */
  restart(): void {
    this.lastSeq = undefined;
    this.stop();
    this.start();
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
        void this.qc.invalidateQueries({ queryKey: ['chats'] });
        break;
      case 'shift.progress':
        for (const cb of this.watchers.get(msg.shiftId) ?? []) cb(msg.items, msg.cardId);
        break;
      case 'chat.delta':
        this.emitChat(msg.threadId, { type: 'delta', text: msg.text });
        break;
      case 'chat.done':
        this.emitChat(msg.threadId, { type: 'done', messageId: msg.messageId });
        break;
      case 'chat.error':
        this.emitChat(msg.threadId, { type: 'error', reason: msg.reason });
        break;
      default:
        break;
    }
  }

  private emitChat(threadId: string, ev: ChatEvent): void {
    for (const cb of this.chatListeners.get(threadId) ?? []) cb(ev);
  }

  /** Streaming chat: replies and errors of one conversation. Returns an unsubscribe. */
  listenChat(threadId: string, cb: ChatListener): () => void {
    let set = this.chatListeners.get(threadId);
    if (!set) {
      set = new Set();
      this.chatListeners.set(threadId, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.chatListeners.delete(threadId);
    };
  }

  /** Sends a chat message; false when the socket is not open (the panel then says the chat is unavailable). */
  sendChat(threadId: string, body: string, clientMsgId: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN && !this.mocked) return false;
    this.send({ type: 'chat.send', threadId, body, clientMsgId });
    return true;
  }

  cancelChat(threadId: string): void {
    this.send({ type: 'chat.cancel', threadId });
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
  const org = getActiveOrgId();
  return `${proto}//${location.host}/api/ws${org ? `?org=${encodeURIComponent(org)}` : ''}`;
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

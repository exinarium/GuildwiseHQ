import {
  type BrowserToServer,
  type ModelChoice,
  type ProgressItem,
  RESYNC_THRESHOLD,
  type ServerToBrowser,
  ServerToBrowserSchema,
  type ThreadMessageDto,
} from '@aom/shared';
import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { getActiveOrgId } from '../lib/activeOrg.ts';
import { type ChatActivityMessage, parseActivity } from '../lib/chatSegments.ts';
import { InvalidationBatcher } from './invalidate.ts';

export type SocketState = 'connecting' | 'open' | 'closed';

type ProgressListener = (items: ProgressItem[], cardId: string | null) => void;

/** Log lines of a run environment (`history`: the buffered tail sent when following started). */
export type RunLogListener = (service: string, lines: string[], history: boolean) => void;

/** What a chat panel hears about its conversation (docs/ARCHITECTURE.md section 20). */
export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: string; message?: ThreadMessageDto }
  | { type: 'activity'; activity: ChatActivityMessage }
  | { type: 'queued'; clientMsgId?: string; workstationName?: string }
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
  private runWatchers = new Map<string, Set<RunLogListener>>();
  private chatListeners = new Map<string, Set<ChatListener>>();
  private readonly batcher: InvalidationBatcher;

  constructor(
    private readonly qc: QueryClient,
    private readonly url: () => string = defaultUrl,
  ) {
    this.batcher = new InvalidationBatcher(qc);
  }

  /** Invalidates everything now (a resync) and forgets what was waiting for the batch. */
  private invalidateAll(): void {
    this.batcher.clear();
    void this.qc.invalidateQueries();
  }

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
    this.batcher.clear();
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
      for (const envId of this.runWatchers.keys()) this.send({ type: 'run.watch', envId });
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
    // `chat.activity` (tool use, thinking) is newer than the shared schema: parse it on its own so it is not dropped.
    const activity = parseActivity(raw);
    if (activity) {
      this.emitChat(activity.threadId, { type: 'activity', activity });
      return;
    }
    const parsed = ServerToBrowserSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg: ServerToBrowser = parsed.data;
    switch (msg.type) {
      case 'ready':
        this.setState('open');
        // The first `ready` (nothing seen yet) is just the page loading: its queries are fetching already, so
        // invalidating all of them fetched everything twice. Only a reconnect that missed a lot refetches everything.
        if (this.lastSeq !== undefined && msg.seq - this.lastSeq > RESYNC_THRESHOLD) this.invalidateAll();
        this.lastSeq = msg.seq;
        break;
      case 'event':
        this.lastSeq = Math.max(this.lastSeq ?? 0, msg.event.seq);
        this.batcher.add(msg.event);
        break;
      case 'resync':
        this.invalidateAll();
        break;
      case 'presence':
        void this.qc.invalidateQueries({ queryKey: ['workstations'] });
        void this.qc.invalidateQueries({ queryKey: ['admin', 'workstations'] });
        void this.qc.invalidateQueries({ queryKey: ['chats'] });
        break;
      case 'shift.progress':
        for (const cb of this.watchers.get(msg.shiftId) ?? []) cb(msg.items, msg.cardId);
        break;
      case 'run.changed':
        void this.qc.invalidateQueries({ queryKey: ['runs'] });
        break;
      case 'run.log':
        for (const cb of this.runWatchers.get(msg.envId) ?? [])
          cb(msg.service, msg.lines, msg.history === true);
        break;
      case 'chat.delta':
        this.emitChat(msg.threadId, { type: 'delta', text: msg.text });
        break;
      case 'chat.done':
        this.emitChat(msg.threadId, {
          type: 'done',
          messageId: msg.messageId,
          ...doneMessage(raw),
        });
        break;
      case 'chat.queued':
        void this.qc.invalidateQueries({ queryKey: ['ceo'] });
        void this.qc.invalidateQueries({ queryKey: ['thread', msg.threadId] });
        this.emitChat(msg.threadId, {
          type: 'queued',
          ...(msg.clientMsgId ? { clientMsgId: msg.clientMsgId } : {}),
          ...(msg.workstationName ? { workstationName: msg.workstationName } : {}),
        });
        break;
      case 'chat.error':
        this.emitChat(msg.threadId, { type: 'error', reason: msg.reason });
        break;
      default:
        break;
    }
  }

  /** Threads whose agent is answering right now (from the live stream, whether or not a panel is open). */
  private working: ReadonlySet<string> = new Set();
  private workingListeners = new Set<() => void>();
  getWorking = (): ReadonlySet<string> => this.working;
  subscribeWorking = (cb: () => void) => {
    this.workingListeners.add(cb);
    return () => this.workingListeners.delete(cb);
  };
  private setWorking(threadId: string, on: boolean): void {
    if (this.working.has(threadId) === on) return;
    const next = new Set(this.working);
    if (on) next.add(threadId);
    else next.delete(threadId);
    this.working = next;
    for (const cb of this.workingListeners) cb();
  }

  private emitChat(threadId: string, ev: ChatEvent): void {
    this.setWorking(threadId, ev.type === 'delta' || ev.type === 'activity');
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
  sendChat(
    threadId: string,
    body: string,
    clientMsgId: string,
    model?: { choice: ModelChoice; scope: 'message' | 'thread' },
  ): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN && !this.mocked) return false;
    this.send({
      type: 'chat.send',
      threadId,
      body,
      clientMsgId,
      ...(model ? { model: model.choice, modelScope: model.scope } : {}),
    });
    return true;
  }

  cancelChat(threadId: string): void {
    this.send({ type: 'chat.cancel', threadId });
  }

  /** Live log of a run environment: sends `run.watch` (the runner then streams) and returns an unsubscribe. */
  watchRun(envId: string, cb: RunLogListener): () => void {
    let set = this.runWatchers.get(envId);
    if (!set) {
      set = new Set();
      this.runWatchers.set(envId, set);
      this.send({ type: 'run.watch', envId });
    }
    set.add(cb);
    return () => {
      const s = this.runWatchers.get(envId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        this.runWatchers.delete(envId);
        this.send({ type: 'run.unwatch', envId });
      }
    };
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

/** The stored agent message a newer server sends with `chat.done` (so the streamed bubble can be swapped without a gap). */
function doneMessage(raw: unknown): { message?: ThreadMessageDto } {
  const m = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).message : undefined;
  if (!m || typeof m !== 'object') return {};
  const r = m as Record<string, unknown>;
  const ok =
    typeof r.id === 'string' &&
    typeof r.threadId === 'string' &&
    typeof r.body === 'string' &&
    typeof r.createdAt === 'string' &&
    (r.authorKind === 'user' || r.authorKind === 'agent' || r.authorKind === 'system');
  if (!ok) return {};
  return {
    message: {
      authorUserId: null,
      authorAgentId: null,
      authorName: null,
      kind: 'comment',
      data: {},
      ...r,
    } as unknown as ThreadMessageDto,
  };
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

const NO_THREADS: ReadonlySet<string> = new Set();
/** The chats whose agent is answering right now. */
export function useWorkingThreads(): ReadonlySet<string> {
  return useSyncExternalStore(
    (cb) => instance?.subscribeWorking(cb) ?? (() => {}),
    () => instance?.getWorking() ?? NO_THREADS,
  );
}

export function useSocketState(): SocketState {
  return useSyncExternalStore(
    (cb) => instance?.subscribeState(cb) ?? (() => {}),
    () => instance?.getState() ?? 'closed',
  );
}

import type { FastifyBaseLogger } from 'fastify';
import type { BillingRuntime } from './billing/runtime.ts';
import type { SocialClient } from './blog/social-client.ts';
import type { WriterClient } from './blog/writer/client.ts';
import type { BrowserGateway } from './browser-gateway/gateway.ts';
import type { SignalSweep } from './ceo/signals.ts';
import type { ChatRelay } from './chat/relay.ts';
import type { Clock } from './clock.ts';
import type { CloudServices } from './cloud/service.ts';
import type { Config } from './config.ts';
import type { Pool } from './db/pool.ts';
import type { Dispatcher } from './dispatcher/dispatcher.ts';
import type { Reaper } from './dispatcher/reaper.ts';
import type { Notifier } from './eventstore/notifier.ts';
import type { PgEventStore } from './eventstore/pg-event-store.ts';
import type { Mailer } from './mail/mailer.ts';
import type { PushService } from './push/notifier.ts';
import type { RunnerGateway } from './runner-gateway/gateway.ts';
import type { RunnerRegistry } from './runner-gateway/registry.ts';
import type { Scheduler } from './scheduler/scheduler.ts';
import type { BoardService } from './sessions/board.ts';
import type { DiscoveryService } from './sessions/discovery.ts';
import type { SessionTurns } from './sessions/turns.ts';

/** Everything a command, route or gateway needs. Built once in `createApp` (app.ts). */
export interface Ctx {
  config: Config;
  clock: Clock;
  pool: Pool;
  store: PgEventStore;
  notifier: Notifier;
  mailer: Mailer;
  /** Facebook and LinkedIn (a fake in tests; nothing else reaches those networks). */
  social: SocialClient;
  /** The Anthropic client of the blog writer (platform key; a fake in tests, null without a key). */
  blogWriter: WriterClient | null;
  log: FastifyBaseLogger;
  /** Late-bound long-lived services (assigned by createApp before any request is served). */
  services: Services;
}

/** The simulated workstation of simulation organizations (src/simulation). Absent when simulation hosting is off. */
export interface SimulationHost {
  /** Starts or stops the org's simulated workstation to match its simulation flag (fire and forget). */
  reconcile(orgId: string): void;
  /** Stops the org's simulated runner and deletes its files (the wipe). */
  dispose(orgId: string): Promise<void>;
  /** A local throwaway origin for a repository added in a simulation organization; resolves to its path. */
  createOrigin(orgId: string, name: string): Promise<string>;
  /** Resolves when the queued start or stop of the org's simulated workstation is done. */
  ready(orgId: string): Promise<void>;
  /** The state of the org's simulated runner process. */
  status(orgId: string): { state: 'running' | 'starting' | 'stopped' | 'unavailable'; detail: string };
}

export interface Services {
  simulation?: SimulationHost;
  runners: RunnerRegistry;
  gateway: RunnerGateway;
  dispatcher: Dispatcher;
  reaper: Reaper;
  scheduler: Scheduler;
  signals: SignalSweep;
  browser: BrowserGateway;
  chat: ChatRelay;
  /** Durable turns of discovery and boardroom sessions. */
  sessions: SessionTurns;
  /** The Discovery Studio orchestrator: the facilitated session state machine. */
  discovery: DiscoveryService;
  /** The Boardroom orchestrator: rounds, speaker choice, decision points, whiteboard and minutes. */
  board: BoardService;
  cloud: CloudServices;
  billing: BillingRuntime;
  /** Web Push notifier (only when VAPID is configured). */
  push?: PushService;
}

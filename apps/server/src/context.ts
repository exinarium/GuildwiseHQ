import type { FastifyBaseLogger } from 'fastify';
import type { SocialClient } from './blog/social-client.ts';
import type { BrowserGateway } from './browser-gateway/gateway.ts';
import type { ChatRelay } from './chat/relay.ts';
import type { BillingRuntime } from './billing/runtime.ts';
import type { Clock } from './clock.ts';
import type { CloudServices } from './cloud/service.ts';
import type { Config } from './config.ts';
import type { Pool } from './db/pool.ts';
import type { Dispatcher } from './dispatcher/dispatcher.ts';
import type { Reaper } from './dispatcher/reaper.ts';
import type { Notifier } from './eventstore/notifier.ts';
import type { PgEventStore } from './eventstore/pg-event-store.ts';
import type { Mailer } from './mail/mailer.ts';
import type { Reporter } from './reporter/reporter.ts';
import type { RunnerGateway } from './runner-gateway/gateway.ts';
import type { RunnerRegistry } from './runner-gateway/registry.ts';
import type { Scheduler } from './scheduler/scheduler.ts';

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
  log: FastifyBaseLogger;
  /** Late-bound long-lived services (assigned by createApp before any request is served). */
  services: Services;
}

export interface Services {
  runners: RunnerRegistry;
  gateway: RunnerGateway;
  dispatcher: Dispatcher;
  reaper: Reaper;
  scheduler: Scheduler;
  reporter: Reporter;
  browser: BrowserGateway;
  chat: ChatRelay;
  cloud: CloudServices;
  billing: BillingRuntime;
}

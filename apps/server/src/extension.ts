import type { ActiveOrg, OrgLimits, OrgRole } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import type { OrgRow } from './auth/org-context.ts';
import type { Config } from './config.ts';
import type { Ctx } from './context.ts';
import type { Queryable } from './db/sql.ts';
import type { Tx } from './db/tx.ts';
import type { IngestOutcome } from './mail/inbound/ingest.ts';
import type { NormalizedInbound } from './mail/inbound/types.ts';

/**
 * Server extension points. The open-source server is complete on its own: every organization is unlimited, there is no
 * billing and the platform super-user can invite organizations. A hosting business adds what it needs by passing
 * `ServerExtension`s to `startServer` / `createApp`; everything here defaults to a no-op, and the core never imports
 * from an extension (scripts/check-no-cloud-imports.sh enforces it).
 */

/** Decides how much an organization may use. The default provider says "unlimited". */
export interface PlanLimitsProvider {
  /** The limits shown for the organization (null = unlimited). */
  limits(db: Queryable, orgId: string): Promise<OrgLimits>;
  /**
   * Throws a 409 `limit_reached` when adding `delta` of `kind` would exceed the organization's limit. Called inside the
   * command's append transaction.
   */
  assertWithin(
    tx: Queryable,
    orgId: string,
    kind: 'members' | 'projects' | 'workstations' | 'agents',
    delta: number,
  ): Promise<void>;
}

/** A periodic background job (billing renewals, trial expiry, ...). Runs serialized with the scheduler's other jobs. */
export interface ExtensionTicker {
  name: string;
  everyMs: number;
  /** A long job (minutes): run outside the scheduler's chain, one at a time, so it never holds up the schedules. */
  detached?: boolean;
  /** Also run once right after the scheduler starts. */
  runOnBoot?: boolean;
  /** Return false to switch the timer off (the job can still be run by hand with `scheduler.runTicker`). */
  enabled?(ctx: Ctx): boolean;
  run(ctx: Ctx): Promise<unknown>;
}

/** Operational tables that reference projection tables: saved before a projection rebuild and restored afterwards. */
export interface PreservedTable {
  table: string;
  restoreWhere: string;
}

export interface ServerExtension {
  name: string;
  /** Directories with extra SQL migrations; applied after the core's, in the order given. Filenames are the ids. */
  migrationDirs?: string[];
  /** Called once while the app is built, before routes are registered: create the extension's runtime services. */
  setup?(ctx: Ctx): void | Promise<void>;
  /** Extra Fastify route plugins (HTTP routes, webhooks), registered after the core's. */
  routes?: Array<(ctx: Ctx) => (app: FastifyInstance) => Promise<void> | void>;
  /** Request paths whose raw JSON body is kept on `req.rawBody` (webhook signatures). */
  rawBodyPaths?: string[];
  /** Path prefixes that are machine endpoints without an Origin header (the CSRF Origin check skips them). */
  originExemptPrefixes?: string[];
  /** Exact paths that accept a form post instead of JSON. */
  formPostPaths?: string[];
  /** Extra hosts the browser may post forms to (CSP `form-action`). */
  cspFormActions?: string[];
  /**
   * Public pages built into the web dist as static files (prerendered marketing pages): `route` is a fastify route
   * (`/pricing`, `/license/:id`), `file` the file under the web dist. Served to everyone; without the file the app shell.
   */
  publicPages?: Array<{
    route: string;
    file: string /** List the route in sitemap.xml. */;
    sitemap?: boolean;
  }>;
  /** Replaces the default (unlimited) plan-limits provider. */
  planLimits?: PlanLimitsProvider;
  /** Background jobs. */
  tickers?: ExtensionTicker[];
  /** Replaces inbound mail routing; call `next` for the core's own routing (organization inboxes). */
  dispatchInbound?(
    ctx: Ctx,
    message: NormalizedInbound,
    next: (message: NormalizedInbound) => Promise<IngestOutcome[]>,
  ): Promise<IngestOutcome[]>;
  /** Adds to or changes the `activeOrg` block (plan name, banners, billing gate, trial dates). */
  decorateActiveOrg?(ctx: Ctx, org: OrgRow, role: OrgRole, dto: ActiveOrg): Promise<void>;
  /**
   * Called inside the transaction that switches an organization to simulation. Throw to refuse (the organization is
   * not empty), or clean up the extension's own per-organization state.
   */
  simulation?: {
    assertCanEnable?(tx: Queryable, orgId: string, state: { hasProjects: boolean }): Promise<void>;
    onEnabled?(
      ctx: Ctx,
      tx: Tx,
      orgId: string,
      adminUserId: string,
      meta?: { ip?: string; userAgent?: string },
    ): Promise<void>;
  };
  /** Operational tables to save and restore around a projection rebuild. */
  preservedTables?: PreservedTable[];
  /** Printed at boot when set. */
  startupWarning?(config: Config): string | undefined;
}

/** What `ctx.ext` holds: the registered extensions and a bag for their runtime services. */
export interface ExtensionHost {
  list: readonly ServerExtension[];
  /** Runtime services, keyed by extension name (set in `setup`). */
  state: Record<string, unknown>;
  planLimits: PlanLimitsProvider;
}

export const unlimitedLimits = (): OrgLimits => ({
  maxMembers: null,
  maxWorkstations: null,
  maxAgents: null,
  maxProjects: null,
});

/** The core's provider: no limits for anyone. */
export const UNLIMITED_PROVIDER: PlanLimitsProvider = {
  async limits() {
    return unlimitedLimits();
  },
  async assertWithin() {},
};

export function createExtensionHost(extensions: readonly ServerExtension[] = []): ExtensionHost {
  const names = new Set<string>();
  for (const e of extensions) {
    if (names.has(e.name)) throw new Error(`duplicate server extension "${e.name}"`);
    names.add(e.name);
  }
  const providers = extensions.filter((e) => e.planLimits);
  if (providers.length > 1) throw new Error('only one server extension may provide plan limits');
  return {
    list: extensions,
    state: {},
    planLimits: providers[0]?.planLimits ?? UNLIMITED_PROVIDER,
  };
}

/** Directories of extra migrations contributed by the extensions, in registration order. */
export const extensionMigrationDirs = (extensions: readonly ServerExtension[] = []): string[] =>
  extensions.flatMap((e) => e.migrationDirs ?? []);

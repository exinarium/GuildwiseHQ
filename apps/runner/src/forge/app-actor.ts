import {
  APP_ERROR_TEXT,
  type ForgeKind,
  normalizeRemoteUrl,
  type PostAsAppIdentity,
  type PostAsPlan,
  postAsFor,
} from '@aom/shared';
import { type AccessCheckBroker, appAccessToken } from '../apps/access-check.ts';
import { AppIdentityError, appIdentityWire, appReason, repoNameOf } from '../git/identity.ts';
import type { AppRepoRoot } from './app-repos.ts';
import { isHttps } from './http.ts';
import { gitAuthFor } from './index.ts';
import type { AppActor, ForgeEnv, GitAuth } from './types.ts';

export type { AppActor } from './types.ts';

/** The part of this runner's broker an actor needs (`AppTokenBroker` satisfies it). */
export type AppTokenSource = AccessCheckBroker;

/**
 * The credentials one payload or shift acts with. Without an app plan this is exactly today's: the base forge env and
 * `gitAuthFor`. With one, every repository whose plan entry has `source: 'app'` pushes, fetches and calls `gh` with a
 * fresh installation token per process; any other repository keeps today's credentials.
 */
export interface ActorScope {
  forgeEnv: ForgeEnv;
  auth: (url: string, forge?: ForgeKind | null) => Promise<GitAuth>;
  /** The actor for one remote URL (null = today's credentials). */
  actorFor(url: string): AppActor | null;
}

const SSH_REASON = (host: string, repo: string): string =>
  `The repository's origin uses SSH; an app can push over HTTPS only. Change the remote to https://${host}/${repo}.git.`;

function actorOf(
  app: PostAsAppIdentity,
  remoteUrlNormalized: string,
  broker: AppTokenSource | null,
): AppActor {
  const repoName = repoNameOf(remoteUrlNormalized).toLowerCase();
  return {
    app,
    repoName,
    token: async () => {
      if (!broker) throw new AppIdentityError(app, APP_ERROR_TEXT.installation_not_found);
      try {
        return await appAccessToken(broker, app, repoName);
      } catch (err) {
        throw new AppIdentityError(app, appReason(err));
      }
    },
  };
}

export function actorScope(
  base: ForgeEnv,
  broker: AppTokenSource | null,
  plan?: PostAsPlan | null,
  tripwire?: AppRepoRoot | null,
): ActorScope {
  if (tripwire && plan)
    for (const e of plan.repos)
      tripwire.set(
        e.remoteUrlNormalized,
        e.source === 'app' && e.app ? { integrationId: e.app.integrationId, label: e.app.label } : null,
      );
  const appEntries = plan?.repos.filter((e) => e.source === 'app') ?? [];
  if (!plan || appEntries.length === 0)
    return { forgeEnv: base, auth: (u, f) => gitAuthFor(base, u, f), actorFor: () => null };

  const byNormalized = (normalized: string): AppActor | null => {
    const e = postAsFor(plan, normalized);
    if (e?.source !== 'app') return null;
    if (!e.app)
      return actorOf(
        {
          integrationId: '',
          provider: 'github-app',
          label: 'unknown app',
          botName: '',
          botEmail: '',
          instance: '',
          host: '',
        },
        normalized,
        null,
      );
    return actorOf(e.app, normalized, broker);
  };
  const actorFor = (url: string): AppActor | null => byNormalized(normalizeRemoteUrl(url));
  const forgeEnv: ForgeEnv = {
    ...base,
    app: (host, fullName) => byNormalized(`${host}/${fullName}`.toLowerCase()),
  };
  return {
    forgeEnv,
    actorFor,
    auth: async (url, forge) => {
      const actor = actorFor(url);
      if (actor) assertAppTransport(actor, url);
      return gitAuthFor(forgeEnv, url, forge);
    },
  };
}

/**
 * The repositories a payload acts on (every `remoteUrlNormalized` string in it, a few levels deep). Used only to keep
 * the push tripwire in step with the server's current plan.
 */
export function payloadRepoUrls(payload: unknown, depth = 4): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, d: number): void => {
    if (d < 0 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, d - 1);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'postAs') continue;
      if (k === 'remoteUrlNormalized' && typeof x === 'string' && x) out.add(x.toLowerCase());
      else walk(x, d - 1);
    }
  };
  walk(payload, depth);
  return [...out];
}

/**
 * Drops the tripwire entry of every repository a payload acts on that its plan does not put on an app: the server
 * sends no plan once the owner deselects the app (or the repository is no longer covered), and from then on the
 * runner pushes there with today's credentials, which the tripwire must let through.
 */
export function releaseUncoveredRepos(
  tripwire: AppRepoRoot | null | undefined,
  plan: PostAsPlan | null | undefined,
  urls: ReadonlyArray<string>,
): void {
  if (!tripwire) return;
  for (const url of urls) {
    const e = postAsFor(plan, url);
    if (e?.source === 'app' && e.app) continue;
    tripwire.set(url, null);
  }
}

/** An app repository whose remote is not https fails closed (a GitHub App has no ssh identity). */
export function assertAppTransport(actor: AppActor | null, url: string): void {
  if (!actor || isHttps(url)) return;
  const host = actor.app.host || normalizeRemoteUrl(url).split('/')[0] || 'github.com';
  throw new AppIdentityError(actor.app, SSH_REASON(host, actor.repoName));
}

/** The ssh check for a clone's origin at shift or command start, before any bot commit is made. */
export function checkAppOrigin(scope: ActorScope, url: string | null | undefined): void {
  if (!url) return;
  assertAppTransport(scope.actorFor(url), url);
}

/** {@link checkAppOrigin} as a wire error (`app_identity_failed: ...`), or null when the origin is fine. */
export function appOriginRefusal(scope: ActorScope, url: string | null | undefined): string | null {
  try {
    checkAppOrigin(scope, url);
    return null;
  } catch (err) {
    if (err instanceof AppIdentityError) return appIdentityWire(err);
    throw err;
  }
}

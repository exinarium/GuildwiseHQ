import { APP_ERROR_TEXT, type TrackerApp } from '@aom/shared';
import type { AppKeyStore } from '../apps/store.ts';
import { type AppAccessScope, AppTokenError } from '../apps/types.ts';
import { appReason } from '../git/identity.ts';

/**
 * GitHub issue traffic (approved posts, the "already posted?" check, issue reads, the integration poller) as the
 * project's selected GitHub App. This is the only file of the external adapters that knows the token broker.
 *
 * - No app, an app on another host than github.com, or a repository the installation does not cover: today's `gh` login.
 * - Any other failure to get a token: fail closed with an error naming the app; nothing runs under another identity.
 */

/** A token for `owner/name`. Throws `AppTokenError`. */
export interface AppTokenSource {
  tokenFor(app: { instance: string; integrationId: string }, repoFullName: string): Promise<string>;
}

/** What `brokerTokenSource` needs from the runner's broker. */
export interface TokenBroker {
  readonly store: Pick<AppKeyStore, 'get'>;
  getAccessToken(instance: string, scope?: AppAccessScope): Promise<{ token: string }>;
}

/** The runner's own broker as an `AppTokenSource` (one per runner, wired with `() => this.appBroker()`). */
export function brokerTokenSource(broker: () => TokenBroker): AppTokenSource {
  return {
    tokenFor: async ({ instance, integrationId }, repo) => {
      const b = broker();
      const stored = b.store.get(instance);
      if (!stored) throw new AppTokenError('installation_not_found', APP_ERROR_TEXT.installation_not_found);
      if (!stored.refs.some((r) => r.integrationId === integrationId))
        throw new AppTokenError('app_mismatch', APP_ERROR_TEXT.app_mismatch);
      const [owner, name, ...rest] = repo.split('/');
      // An installation lives on one account and GitHub scopes its tokens by repository name only, so a repository of
      // another owner is never covered (it would get a token for the installation's same-named repository).
      if (!owner || !name || rest.length || owner.toLowerCase() !== stored.identity.account.toLowerCase())
        throw new AppTokenError('repository_not_accessible', APP_ERROR_TEXT.repository_not_accessible);
      return (await b.getAccessToken(instance, { repositories: [name] })).token;
    },
  };
}

/** The selected app could not get a token: the operation is refused, it never falls back to the personal login. */
export class AppCredentialError extends Error {
  constructor(
    readonly app: TrackerApp,
    readonly repo: string,
    readonly reason: string,
  ) {
    super(
      `The GitHub App ${app.label} (${app.botName}) could not get a token for ${repo}: ${reason} ` +
        'Nothing was sent under another identity.',
    );
    this.name = 'AppCredentialError';
  }
}

/**
 * The child environment for `gh` acting as `app` on `repo` (`owner/name`), or undefined for today's `gh` login (no app,
 * another host, or a repository the installation does not cover). Throws `AppCredentialError` for anything else.
 * `GH_HOST` is pinned so an enterprise host in the runner's own environment cannot swap in another login.
 */
export async function ghEnvFor(
  src: AppTokenSource | undefined,
  app: TrackerApp | undefined,
  repo: string,
): Promise<Record<string, string> | undefined> {
  if (!app) return undefined;
  if (app.host.toLowerCase() !== 'github.com') return undefined;
  if (!src) throw new AppCredentialError(app, repo, APP_ERROR_TEXT.runner_too_old);
  try {
    const token = await src.tokenFor(app, repo);
    return { GH_TOKEN: token, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' };
  } catch (err) {
    if (err instanceof AppTokenError && err.code === 'repository_not_accessible') return undefined;
    throw new AppCredentialError(app, repo, appReason(err));
  }
}

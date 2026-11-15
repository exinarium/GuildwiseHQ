import type { AppProviderId } from '@aom/shared';
import { githubAppFactory } from './github-app.ts';
import type { AppProviderFactory } from './types.ts';

/** Every automated app provider this runner can hold. Another provider is one more factory here. */
export const APP_PROVIDERS: Record<AppProviderId, AppProviderFactory> = {
  'github-app': githubAppFactory,
};

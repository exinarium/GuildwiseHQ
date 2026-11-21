import type { PlatformTeamSettings } from '@aom/shared';
import { withConfig } from '../../src/config.ts';
import { platformTeamSettings, syncPlatformTeamDesignation } from '../../src/platform-team/settings.ts';
import type { TestApp } from './app.ts';

/**
 * Designates the platform team the way production does since R17-1: `AOM_PLATFORM_TEAM_ORG_ID` and
 * `AOM_PLATFORM_TEAM_PROJECT_ID` in the server config, copied in by the sync (boot and every scheduler pass).
 */
export async function designatePlatformTeam(
  t: TestApp,
  orgId: string,
  projectId: string,
): Promise<PlatformTeamSettings> {
  t.app.ctx.config = withConfig(t.app.ctx.config, { platformTeam: { orgId, projectId } });
  await syncPlatformTeamDesignation(t.app.ctx);
  return platformTeamSettings(t.app.ctx);
}

/** Unsets the env designation (the sync clears what the env wrote). */
export async function clearPlatformTeam(t: TestApp): Promise<PlatformTeamSettings> {
  t.app.ctx.config = withConfig(t.app.ctx.config, {
    platformTeam: { orgId: undefined, projectId: undefined },
  });
  await syncPlatformTeamDesignation(t.app.ctx);
  return platformTeamSettings(t.app.ctx);
}

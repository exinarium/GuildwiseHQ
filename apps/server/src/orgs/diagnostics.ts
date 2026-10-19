import type { Ctx } from '../context.ts';
import { getPlatformTeam } from '../platform-team/settings.ts';

/**
 * Whether the "Share diagnostic data with Guildwise" consent exists for an organization: always for the platform
 * organization (the owner's own), and for customer organizations only once `AOM_DIAGNOSTICS_CONSENT_CUSTOMERS` is on,
 * which waits for the POPIA review of the consent text.
 */
export async function diagnosticsConsentAvailable(ctx: Ctx, orgId: string): Promise<boolean> {
  if (ctx.config.diagnosticsConsentForCustomers) return true;
  return (await getPlatformTeam(ctx.pool))?.orgId === orgId;
}

import type { LocalAuthority } from '../src/policy/authority.ts';
import { DEFAULT_POLICY, type Policy, PolicySchema } from '../src/policy/schema.ts';

/**
 * A workstation whose owner has set everything up and granted it locally (test double for the R18-S local authority):
 * setup done, sudo and Docker granted, every DevOps agent is granted, CEO owner turns may run with full power,
 * and every held command is approved at once (as if typed yes at the workstation).
 * The behaviour tests written before 1.10.0 run against it; the local-authority tests use the real `FileAuthority`.
 */
export function grantedAuthority(over: Partial<Policy> = {}): LocalAuthority {
  const policy = PolicySchema.parse({
    ...DEFAULT_POLICY,
    setupDone: true,
    // the server's DevOps access (sudo, Docker) applies only where granted locally too, so grant both here
    devops: { agents: {}, sudo: true },
    allowDocker: true,
    devopsRequests: 'ask',
    ceo: { fullPower: true },
    ...over,
  });
  return {
    policy: () => policy,
    devopsGranted: () => true,
    takeOwnerTurn: () => true,
    autoApprove: () => true,
  };
}

/**
 * The only held kinds a passkey assertion may approve (R18-S2, Q12), hard-coded here and nowhere configurable: a deploy
 * whose whole-command pin equals an approved pin except the commit (`deployPinCommit` on), and a recipe write.
 *
 * Never: DevOps grants, DevOps tasks, new or changed deploys, reseals, `vault.configure`,
 * `installScripts`, `acceptRootEquivalent`, owner turns, release signing. Those need the workstation
 * itself, because the server serves the approval page.
 */
export const PASSKEY_KINDS: readonly string[] = Object.freeze([
  'deploy.commit_redeploy',
  'recipe.write',
  // quiet-approvals D9: internet for one exact test-services recipe; held only when the local ceiling allows container egress
  'test.recipe_egress',
]);

export const passkeyMayApprove = (kind: string): boolean => PASSKEY_KINDS.includes(kind);

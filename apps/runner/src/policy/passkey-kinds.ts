/**
 * The only held kinds a passkey assertion may approve (R18-S2, Q12), hard-coded here and nowhere configurable: a deploy
 * whose whole-command pin equals an approved pin except the commit (`deployPinCommit` on), and a recipe write.
 *
 * Never: DevOps or sudo grants, DevOps tasks, `aom sudo`, new or changed deploys, reseals, `vault.configure`,
 * `installScripts`, `acceptRootEquivalent`, `approve-app`, owner turns, release signing. Those need the workstation
 * itself, because the server serves the approval page.
 */
export const PASSKEY_KINDS: readonly string[] = Object.freeze(['deploy.commit_redeploy', 'recipe.write']);

export const passkeyMayApprove = (kind: string): boolean => PASSKEY_KINDS.includes(kind);

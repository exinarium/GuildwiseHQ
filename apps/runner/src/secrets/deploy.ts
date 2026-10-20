import { join } from 'node:path';
import type { RunnerKeys } from './keys.ts';
import { TargetSecrets } from './targets.ts';

/** Names of recipe secrets: environment-variable shaped, UPPER_SNAKE_CASE (the same rule the server enforces). */
export const DEPLOY_SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * The values a delivery recipe names (`secrets: [P5_PROD_DEPLOY_KEY]`), kept ONLY on the workstation:
 * `<data dir>/secrets/deploy.json` (mode 0600), sealed by the browser to the runner key like the test accounts of a target
 * (`targets.json`). The store is the same code, keyed by the project id instead of a deploy target. The server holds names.
 */
export class DeploySecrets extends TargetSecrets {
  constructor(deps: {
    secretsDir: string;
    keys: Pick<RunnerKeys, 'decrypt'> & { publicKey: { keyId: string } };
  }) {
    super({ file: join(deps.secretsDir, 'deploy.json'), keys: deps.keys });
  }

  /** `deploy.secret.set`: one sealed value for a project. */
  setFor(p: { projectId: string; name: string; keyId: string; ciphertext: string }) {
    if (!DEPLOY_SECRET_NAME.test(p.name))
      return { stored: false, error: 'the name must look like MY_DEPLOY_KEY' };
    return this.set({ targetId: p.projectId, name: p.name, keyId: p.keyId, ciphertext: p.ciphertext });
  }

  valuesFor(projectId: string, wanted: readonly string[]) {
    return this.values(projectId, wanted);
  }
}

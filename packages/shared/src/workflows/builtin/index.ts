import { canonicalWorkflowKey } from '../legacy.ts';
import type { WorkflowDefinition } from '../schema.ts';
import { codeWorkflowV1, codeWorkflowV2 } from './code.ts';
import { codeBugfixWorkflowV1 } from './code-bugfix.ts';
import { codeWorkflowV3 } from './code-v3.ts';
import { codeWorkflowV4 } from './code-v4.ts';
import { codeWorkflowV5 } from './code-v5.ts';
import { codeWorkflowV6 } from './code-v6.ts';
import { feedWorkflowV1 } from './feed.ts';
import { researchWorkflowV1 } from './research.ts';

export {
  codeBugfixWorkflowV1,
  codeWorkflowV1,
  codeWorkflowV2,
  codeWorkflowV3,
  codeWorkflowV4,
  codeWorkflowV5,
  codeWorkflowV6,
  feedWorkflowV1,
  researchWorkflowV1,
};

/** Every built-in definition, all versions. Registered at server boot if missing. Old versions are never removed. */
export const BUILTIN_WORKFLOWS: readonly WorkflowDefinition[] = [
  codeWorkflowV1,
  codeWorkflowV2,
  codeWorkflowV3,
  codeWorkflowV4,
  codeWorkflowV5,
  codeWorkflowV6,
  codeBugfixWorkflowV1,
  researchWorkflowV1,
  feedWorkflowV1,
];

export function getBuiltinWorkflow(key: string, version?: number): WorkflowDefinition | undefined {
  const matches = BUILTIN_WORKFLOWS.filter(
    (w) => w.key === canonicalWorkflowKey(key) && (version === undefined || w.version === version),
  );
  return matches.sort((a, b) => b.version - a.version)[0];
}

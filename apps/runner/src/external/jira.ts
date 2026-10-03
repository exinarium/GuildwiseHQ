import {
  type ApprovedDraft,
  type ExternalAdapter,
  type ExternalRef,
  type ExternalSource,
  JIRA_SKILL_PATH,
  NotImplementedError,
  type PostResult,
} from '@aom/shared';
import { SourceReadError } from './github.ts';

/** Thrown when Jira is asked to be read by the runner: the BA reads it itself, with the Jira skill, inside its session. */
export class SkillMediatedError extends SourceReadError {
  constructor(key: string) {
    super(
      `Jira ticket ${key} is read by you, inside this conversation, with the Jira skill (the "Jira skill" section of your instructions; vault file ${JIRA_SKILL_PATH}) and the Jira tool of your runtime. The runner holds no Jira credentials for intake.`,
    );
    this.name = 'SkillMediatedError';
  }
}

/**
 * Jira on the read side is the agent's own skill/MCP (docs/PLAN.md M7): the credentials live in the runtime's tool
 * configuration on this workstation, so the runner has nothing to fetch itself. `readSource` says so; a runtime that
 * can read Jira on the runner's behalf (a later milestone) plugs in as `reader`. `postApproved` (REST with the token in
 * the runner config) is M8.
 */
export class JiraAdapter implements ExternalAdapter {
  readonly system = 'jira' as const;

  constructor(private readonly opts: { reader?: (ref: ExternalRef) => Promise<ExternalSource> } = {}) {}

  readSource(ref: ExternalRef): Promise<ExternalSource> {
    if (this.opts.reader) return this.opts.reader(ref);
    return Promise.reject(new SkillMediatedError(ref.key));
  }

  postApproved(_draft: ApprovedDraft): Promise<PostResult> {
    return Promise.reject(
      new NotImplementedError('posting to Jira (M8: REST with the token in the runner config)'),
    );
  }
}

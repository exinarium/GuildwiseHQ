import type { JourneyIssue } from './validate.ts';
import type { JourneyDefinition, JourneyStep } from './schema.ts';
import { unknownBodyTokens } from './steps-wait.ts';

export interface WaitValidateOptions {
  /** Ids of published forms. Omitted: not checked. */
  publishedFormIds?: ReadonlySet<string> | readonly string[];
}

const has = (s: ReadonlySet<string> | readonly string[], k: string): boolean =>
  s instanceof Set ? s.has(k) : (s as readonly string[]).includes(k);

/** The `on` values that can occur for a step that ended. */
export function allowedOn(kind: JourneyStep['kind']): readonly string[] {
  switch (kind) {
    case 'workflow':
      return ['done', 'cancelled', 'any'];
    case 'wait':
      return ['done', 'any'];
    case 'gate':
      return ['approved', 'rejected', 'done', 'cancelled', 'any'];
    case 'webhook_call':
      return ['done', 'failed', 'cancelled', 'any'];
  }
}

const matchesApprove = (on: string): boolean => on === 'approved' || on === 'done' || on === 'any';
const matchesReject = (on: string): boolean => on === 'rejected' || on === 'cancelled' || on === 'any';

/** Rules for wait, gate and webhook_call steps. Called from validateJourney. */
export function validateJourneyWaitsAndGates(
  def: JourneyDefinition,
  opts: WaitValidateOptions = {},
): { errors: JourneyIssue[]; warnings: JourneyIssue[] } {
  const errors: JourneyIssue[] = [];
  const warnings: JourneyIssue[] = [];
  const ids = new Set(def.steps.map((s) => s.id));
  const kinds = new Map(def.steps.map((s) => [s.id, s.kind] as const));
  const err = (code: string, message: string, stepId: string): void => void errors.push({ code, message, stepId });

  for (const h of def.handoffs) {
    const k = kinds.get(h.from);
    if (k && !allowedOn(k).includes(h.on))
      errors.push({
        code: 'handoff_on_invalid',
        message: `Handoff "${h.id}": a ${k} step never ends "${h.on}".`,
        handoffId: h.id,
      });
  }

  const checkTimeout = (s: JourneyStep, t: { action: string; stepId?: string } | undefined): void => {
    if (t?.action === 'goto') {
      if (!t.stepId || !ids.has(t.stepId) || t.stepId === s.id)
        err('goto_target', `Step "${s.label}": the step to go to on timeout must be another existing step.`, s.id);
    }
  };

  const formWaitWithWebhookSend = new Set<string>();
  for (const s of def.steps) {
    const leaving = def.handoffs.filter((h) => h.from === s.id);
    if (s.kind === 'wait') {
      const w = s.waitFor;
      if (!w) {
        err('no_wait_config', `Step "${s.label}" does not say what it waits for yet.`, s.id);
      } else {
        if (w.kind !== 'date' && !s.duration) err('no_wait_config', `Step "${s.label}" needs a duration.`, s.id);
        if (w.kind === 'form') {
          if (!w.formId) err('no_form', `Step "${s.label}" needs a form.`, s.id);
          else if (opts.publishedFormIds && !has(opts.publishedFormIds, w.formId))
            warnings.push({ code: 'form_not_published', message: `The form of step "${s.label}" is not published.`, stepId: s.id });
          if (w.send.via === 'webhook') formWaitWithWebhookSend.add(s.id);
        }
        if (w.kind === 'webhook' && !w.triggerId)
          err('no_trigger', `Step "${s.label}" needs a webhook trigger.`, s.id);
        const needsTimeout = w.kind === 'form' || w.kind === 'webhook';
        if (needsTimeout && !s.onTimeout) err('no_timeout_action', `Step "${s.label}" needs a timeout action.`, s.id);
        if (!needsTimeout && s.onTimeout)
          err('timeout_not_allowed', `Step "${s.label}" ends by itself; remove the timeout action.`, s.id);
        checkTimeout(s, s.onTimeout);
      }
      if (!leaving.some((h) => h.on === 'done' || h.on === 'any') && leaving.length > 0)
        err('no_done_handoff', `Step "${s.label}" needs a handoff for when the wait ends.`, s.id);
    } else if (s.kind === 'gate') {
      if (!s.approver) err('no_approver', `Step "${s.label}" needs someone to approve.`, s.id);
      if (!s.question?.trim()) err('no_question', `Step "${s.label}" needs a question for the approver.`, s.id);
      if (s.deadline) checkTimeout(s, s.deadline.onTimeout);
      if (!leaving.some((h) => matchesApprove(h.on)) && leaving.length > 0)
        err('no_approve_handoff', `Gate "${s.label}" needs a handoff for approve.`, s.id);
      if (!leaving.some((h) => matchesReject(h.on)))
        warnings.push({
          code: 'no_reject_handoff',
          message: `Gate "${s.label}" has no handoff for reject: a rejection would leave the journey stuck.`,
          stepId: s.id,
        });
    } else if (s.kind === 'webhook_call') {
      if (!s.url.trim()) err('no_url', `Step "${s.label}" needs a URL.`, s.id);
      else if (!/^https?:\/\/[^/\s@]+(\/|$|\?)/i.test(s.url))
        err('url_invalid', `Step "${s.label}": the URL must start with http:// or https:// and carry no user name or password.`, s.id);
      if (!s.workstationId) err('no_workstation', `Step "${s.label}" needs the workstation that sends it.`, s.id);
      for (const t of unknownBodyTokens(s.body))
        err('unknown_token', `Step "${s.label}": {${t}} is not a known value.`, s.id);
      if (!leaving.some((h) => h.on === 'done' || h.on === 'any') && leaving.length > 0)
        err('no_done_handoff', `Step "${s.label}" needs a handoff for when the call worked.`, s.id);
      if (!leaving.some((h) => h.on === 'failed' || h.on === 'cancelled' || h.on === 'any'))
        warnings.push({
          code: 'no_failed_handoff',
          message: `Step "${s.label}" has no handoff for a failed call: a failure would leave the journey stuck.`,
          stepId: s.id,
        });
    }
  }

  // {wait.link} only after a form wait that sends through a webhook step.
  for (const s of def.steps) {
    if (s.kind !== 'webhook_call' || !/\{wait\.link\}/.test(s.body)) continue;
    const seen = new Set<string>();
    const queue = [s.id];
    let ok = false;
    // walk the handoffs backwards
    while (queue.length && !ok) {
      const cur = queue.pop() as string;
      for (const h of def.handoffs)
        if (h.to === cur && !seen.has(h.from)) {
          seen.add(h.from);
          if (formWaitWithWebhookSend.has(h.from)) ok = true;
          queue.push(h.from);
        }
    }
    if (!ok)
      err('wait_link_unavailable', `Step "${s.label}" uses {wait.link} but no earlier form wait sends its link by webhook.`, s.id);
  }
  return { errors, warnings };
}

/** A loop with no workflow step is only allowed when it contains a wait that pauses, or a gate. */
export function serverStepCycle(def: JourneyDefinition): string | null {
  const server = new Set(def.steps.filter((s) => s.kind !== 'workflow').map((s) => s.id));
  const pauses = new Set(
    def.steps
      .filter((s) => s.kind === 'gate' || (s.kind === 'wait' && !!s.waitFor && s.waitFor.kind !== undefined))
      .map((s) => s.id),
  );
  const color = new Map<string, number>();
  let found: string | null = null;
  const path: string[] = [];
  const visit = (id: string): void => {
    color.set(id, 1);
    path.push(id);
    for (const h of def.handoffs) {
      if (h.from !== id || !server.has(h.to) || found) continue;
      const c = color.get(h.to);
      if (c === 1) {
        const loop = path.slice(path.indexOf(h.to));
        if (!loop.some((x) => pauses.has(x))) found = h.to;
      } else if (!c) visit(h.to);
    }
    path.pop();
    color.set(id, 2);
  };
  for (const id of server) if (!color.get(id) && !found) visit(id);
  return found;
}

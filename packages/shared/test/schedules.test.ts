import { describe, expect, it } from 'vitest';
import {
  actionKind,
  actionProjectId,
  actionWorkstationId,
  CreateScheduleRequestSchema,
  DomainEventSchema,
  expandText,
  expandTitle,
  isOrgLevelAction,
  isoWeek,
  isRetryableStatus,
  legacyAction,
  ScheduleActionSchema,
  ScheduleTriggerSchema,
  WEBHOOK_MAX_ATTEMPTS,
  webhookBackoffMs,
  webhookBody,
} from '../src/index.ts';
import { env, U } from './fixtures.ts';

const card = { title: 'Weekly', fields: {} };

describe('schedule actions and triggers', () => {
  it('maps actions to the denormalised kind and project', () => {
    const create = ScheduleActionSchema.parse({ kind: 'create_card', projectId: U.a, template: card });
    expect(actionKind(create)).toBe('card');
    expect(actionProjectId(create)).toBe(U.a);
    const reg = ScheduleActionSchema.parse({ kind: 'regression_run', projectId: U.a, template: card });
    expect(actionKind(reg)).toBe('regression');
    const poll = ScheduleActionSchema.parse({
      kind: 'integration',
      integration: 'github',
      operation: 'issues_poll',
      workstationId: U.b,
      query: 'o/r',
    });
    expect(actionKind(poll)).toBe('integration');
    expect(actionWorkstationId(poll)).toBe(U.b);
  });

  it('organization-level actions are the ones without a project, and hygiene', () => {
    const ba = (projectId: string | null) =>
      ScheduleActionSchema.parse({ kind: 'ba_task', projectId, prompt: 'Summarise' });
    expect(isOrgLevelAction(ba(null))).toBe(true);
    expect(isOrgLevelAction(ba(U.a))).toBe(false);
    expect(
      isOrgLevelAction(
        ScheduleActionSchema.parse({
          kind: 'devops_request',
          workstationId: U.b,
          hygiene: true,
          projectId: U.a,
        }),
      ),
    ).toBe(true);
    expect(
      isOrgLevelAction(
        ScheduleActionSchema.parse({ kind: 'devops_request', workstationId: U.b, text: 'x', projectId: U.a }),
      ),
    ).toBe(false);
    const hook = (projectId?: string) =>
      ScheduleActionSchema.parse({
        kind: 'integration',
        integration: 'webhook',
        url: 'https://x.test/h',
        projectId,
      });
    expect(isOrgLevelAction(hook())).toBe(true);
    expect(isOrgLevelAction(hook(U.a))).toBe(false);
  });

  it('knows the four trigger kinds and refuses an event it does not know', () => {
    expect(ScheduleTriggerSchema.parse({ kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' }).kind).toBe(
      'cron',
    );
    expect(ScheduleTriggerSchema.parse({ kind: 'manual' }).kind).toBe('manual');
    expect(ScheduleTriggerSchema.parse({ kind: 'event', event: 'phase_completed' }).kind).toBe('event');
    expect(ScheduleTriggerSchema.safeParse({ kind: 'event', event: 'nothing' }).success).toBe(false);
    expect(
      ScheduleTriggerSchema.parse({
        kind: 'issue_labelled',
        provider: 'github',
        workstationId: U.b,
        query: 'o/r',
        label: 'aom',
        cron: '*/15 * * * *',
        timezone: 'UTC',
      }).kind,
    ).toBe('issue_labelled');
  });

  it('legacy rows read as create_card or regression_run', () => {
    expect(legacyAction('feed', U.a, card)).toMatchObject({ kind: 'create_card' });
    expect(legacyAction('card', U.a, card)).toMatchObject({ kind: 'create_card' });
    expect(legacyAction('regression', U.a, card)).toMatchObject({ kind: 'regression_run' });
  });

  it('events written before generic schedules still parse', () => {
    const created = DomainEventSchema.parse({
      type: 'ScheduleCreated',
      payload: {
        scheduleId: U.b,
        projectId: U.a,
        name: 'Daily',
        kind: 'feed',
        cron: '0 7 * * *',
        timezone: 'UTC',
        cardTemplate: card,
        enabled: true,
        nextFireAt: null,
      },
    });
    expect(created.type).toBe('ScheduleCreated');
    const fired = DomainEventSchema.parse({
      type: 'ScheduleFired',
      payload: { scheduleId: U.b, cardId: U.c, firedFor: env('x').ts, nextFireAt: null },
    });
    expect(fired.type).toBe('ScheduleFired');
  });

  it('requests: the new shape and the legacy shape', () => {
    expect(
      CreateScheduleRequestSchema.parse({
        name: 'n',
        trigger: { kind: 'manual' },
        action: { kind: 'ba_task', projectId: null, prompt: 'p' },
      }).enabled,
    ).toBe(true);
    expect(
      CreateScheduleRequestSchema.parse({ projectId: U.a, name: 'n', cardTemplate: card }).projectId,
    ).toBe(U.a);
  });
});

describe('text expansion', () => {
  const c = {
    date: '2026-10-07',
    week: isoWeek('2026-10-07'),
    event: 'card finalized',
    ref: 'WEB-3',
    project: 'WEB',
  };
  it('computes ISO weeks', () => {
    expect(isoWeek('2026-10-07')).toBe('2026-W41');
    expect(isoWeek('2026-01-01')).toBe('2026-W01');
    expect(isoWeek('2027-01-01')).toBe('2026-W53');
  });
  it('a title without placeholders gets the date, one with them is expanded', () => {
    expect(expandTitle('Regression', c)).toBe('Regression (2026-10-07)');
    expect(expandTitle('Report {week} for {project}', c)).toBe('Report 2026-W41 for WEB');
  });
  it('expands the issue placeholders', () => {
    expect(
      expandText('{issue.key} / {issue.title} / {issue.url} / {issue}', {
        ...c,
        issue: { key: 'o/r#1', title: 'Bug', url: 'https://x' },
      }),
    ).toBe('o/r#1 / Bug / https://x / o/r#1: Bug');
  });
});

describe('webhook payloads', () => {
  const d = {
    scheduleId: U.a,
    scheduleName: 'Phase done',
    trigger: 'event',
    at: '2026-10-07T10:00:00.000Z',
    text: 'Hello\nWorld',
  };
  it('every format has a text field', () => {
    expect(webhookBody('generic', d)).toMatchObject({
      event: 'schedule.run',
      text: 'Hello\nWorld',
      schedule: { name: 'Phase done' },
    });
    expect(webhookBody('slack', d)).toEqual({ text: 'Hello\nWorld', mrkdwn: true });
    expect(webhookBody('teams', d)).toMatchObject({
      '@type': 'MessageCard',
      title: 'Phase done',
      text: 'Hello\n\nWorld',
    });
  });
  it('retries server errors and rate limits with growing pauses, up to five tries', () => {
    expect([500, 502, 429, 408].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 404, 302].some(isRetryableStatus)).toBe(false);
    expect([1, 2, 3, 4, 9].map(webhookBackoffMs)).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 7_200_000]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(5);
  });
});

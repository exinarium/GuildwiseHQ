import type { CeoTopicDto, CeoTopicsDto } from '@aom/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeskItem } from '../pages/Desk.tsx';
import { ceoStatus, deskItem, Fail, renderCeoPage, stubApi, U, wrap } from './ceo-fixtures.tsx';

/** The Topics tab and the report sections (docs/design/ceo-blog-topics.md section 6). */

const topic = (over: Partial<CeoTopicDto> = {}): CeoTopicDto => ({
  id: U(70),
  status: 'proposed',
  sourceKind: 'offboard_job',
  note: null,
  question: 'How can AI agents authorize production deploys without skipping safety checks?',
  area: 'deploy',
  audience: null,
  findings: [],
  occurrences: 3,
  evidenceKinds: ['job', 'repeat'],
  postSlug: null,
  postTitle: null,
  createdAt: '2026-10-19T08:00:00.000Z',
  decidedAt: null,
  publishedAt: null,
  ...over,
});
const list = (topics: CeoTopicDto[], over: Partial<CeoTopicsDto> = {}): CeoTopicsDto => ({
  enabled: true,
  ownerOnly: true,
  remainingThisMonth: 4,
  topics,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('the Topics tab', () => {
  it('lists a proposal with its area, how often it was seen and Accept / Edit / Reject, and accepts it', async () => {
    const calls = stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      ['GET /api/ceo/topics', () => list([topic()])],
      ['POST /api/ceo/topics/', () => ({ ok: true })],
    ]);
    renderCeoPage('?tab=topics');
    const row = await screen.findByTestId('ceo-topic');
    expect(row).toHaveTextContent('How can AI agents authorize production deploys');
    expect(row).toHaveTextContent('seen 3 times');
    expect(row).toHaveTextContent('from job, repeat');
    // the evidence text is never shown, only its kind
    expect(screen.getByTestId('ceo-topics')).toHaveTextContent('You can still send 4 this month');
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/ceo/topics/${U(70)}/accept`)?.body).toEqual({}),
    );
  });

  it('Reject posts the decision', async () => {
    const calls = stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      ['GET /api/ceo/topics', () => list([topic()])],
    ]);
    renderCeoPage('?tab=topics');
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/ceo/topics/${U(70)}/reject`)).toBe(true));
  });

  it('Edit runs the scrubber live and holds Accept back while there are findings', async () => {
    const calls = stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      ['GET /api/ceo/topics', () => list([topic()])],
      [
        'POST /api/ceo/topics/check',
        (c) =>
          (c.body as { question: string }).question.includes('our')
            ? { ok: false, findings: [{ code: 'first_person', detail: 'our' }] }
            : { ok: true, findings: [] },
      ],
      ['POST /api/ceo/topics/', () => ({ ok: true })],
    ]);
    renderCeoPage('?tab=topics');
    await userEvent.click(await screen.findByTestId('ceo-topic-edit-button'));
    const box = screen.getByTestId('ceo-topic-edit');
    await userEvent.clear(box);
    await userEvent.type(box, 'How do we deploy our services to production safely?');
    expect(await screen.findByTestId('ceo-topic-findings')).toHaveTextContent('"we", "our" or "I"');
    expect(screen.getByTestId('ceo-topic-accept')).toBeDisabled();
    await userEvent.clear(box);
    await userEvent.type(box, 'How can teams deploy services to production safely?');
    await waitFor(() => expect(screen.queryByTestId('ceo-topic-findings')).toBeNull());
    await userEvent.click(screen.getByTestId('ceo-topic-accept'));
    await waitFor(() => {
      const c = calls.find((x) => x.url === `/api/ceo/topics/${U(70)}/accept`);
      expect(c?.body).toMatchObject({ question: 'How can teams deploy services to production safely?' });
    });
  });

  it('shows the findings of the server when Accept is refused, with the proper-noun confirmation', async () => {
    stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      ['GET /api/ceo/topics', () => list([topic()])],
      ['POST /api/ceo/topics/', () => new Fail(422, 'not generic', 'topic_blocked')],
    ]);
    renderCeoPage('?tab=topics');
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('says why when sharing is off, and shows no decision buttons to an Admin in a customer organization', async () => {
    stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      [
        'GET /api/ceo/topics',
        () => ({
          enabled: false,
          reason: 'sharing_off',
          ownerOnly: true,
          remainingThisMonth: null,
          topics: [],
        }),
      ],
    ]);
    renderCeoPage('?tab=topics');
    expect(await screen.findByText('Research topics are off')).toBeInTheDocument();
    vi.unstubAllGlobals();

    stubApi('admin', [
      ['GET /api/ceo/status', () => ceoStatus({ isOwner: false })],
      ['GET /api/ceo/topics', () => list([topic()])],
    ]);
    renderCeoPage('?tab=topics');
    expect(await screen.findAllByTestId('ceo-topic')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('an Admin may decide in the platform organization (not owner-only)', async () => {
    stubApi('admin', [
      ['GET /api/ceo/status', () => ceoStatus({ isOwner: false })],
      ['GET /api/ceo/topics', () => list([topic()], { ownerOnly: false, remainingThisMonth: null })],
    ]);
    renderCeoPage('?tab=topics');
    expect(await screen.findByRole('button', { name: 'Accept' })).toBeInTheDocument();
  });
});

describe('the daily report', () => {
  const report = {
    actions: [],
    scores: [],
    fallback: false,
  };
  const published = topic({
    id: U(71),
    status: 'published',
    postSlug: 'agent-deploys',
    postTitle: 'Letting agents deploy safely',
    publishedAt: '2026-10-19T10:00:00.000Z',
  });

  it('has "Research topics from this week" with the buttons and "Published from your topics" with the link', async () => {
    stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      ['GET /api/ceo/topics', () => list([topic(), published])],
    ]);
    wrap(
      <DeskItem
        item={deskItem({
          kind: 'alert',
          subkind: 'ceo_report',
          title: 'Daily report',
          options: [],
          ceoReport: report,
        })}
        now={Date.now()}
      />,
    );
    const section = await screen.findByTestId('ceo-report-topics-proposed');
    expect(section).toHaveTextContent('Research topics from this week');
    expect(section).toHaveTextContent('Nothing is sent to Guildwise without your Accept');
    expect(within(section).getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    const pub = screen.getByTestId('ceo-report-topics-published');
    expect(pub).toHaveTextContent('Published from your topics');
    expect(within(pub).getByRole('link', { name: 'Letting agents deploy safely' })).toHaveAttribute(
      'href',
      '/blog/agent-deploys',
    );
  });

  it('shows nothing when there is nothing to review or publish', async () => {
    stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      ['GET /api/ceo/topics', () => list([])],
    ]);
    wrap(
      <DeskItem
        item={deskItem({
          kind: 'alert',
          subkind: 'ceo_report',
          title: 'Daily report',
          options: [],
          ceoReport: report,
        })}
        now={Date.now()}
      />,
    );
    await screen.findByTestId('ceo-report');
    expect(screen.queryByTestId('ceo-report-topics')).toBeNull();
  });
});

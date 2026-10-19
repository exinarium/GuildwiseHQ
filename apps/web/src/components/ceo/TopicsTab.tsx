import type { CeoTopicDto, CeoTopicStatus } from '@aom/shared';
import { Lightbulb } from 'lucide-react';
import { useCeoTopics } from '../../api/queries/ceo-topics.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Callout, EmptyState, ErrorBox, ListSkeleton, Panel } from '../ui.tsx';
import { ProposedTopic, useCanDecideTopics } from './TopicReview.tsx';

const LABEL: Partial<Record<CeoTopicStatus, string>> = {
  accepted: 'Accepted, about to be sent',
  queued: 'Sent, waiting for the writer',
  published: 'Published',
  declined: 'Not used',
  duplicate: 'Already covered',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  blocked: 'Held back by the checks',
};
const TONE: Partial<Record<CeoTopicStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = {
  accepted: 'info',
  queued: 'info',
  published: 'success',
  declined: 'neutral',
  duplicate: 'neutral',
  rejected: 'neutral',
  withdrawn: 'warning',
  blocked: 'danger',
};

function Row({ t }: { t: CeoTopicDto }) {
  return (
    <li
      className="flex flex-wrap items-start justify-between gap-2 py-2"
      data-testid="ceo-topic"
      data-status={t.status}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg">{t.question}</p>
        <p className="text-xs text-muted">
          {t.area} · {formatDateTime(t.publishedAt ?? t.decidedAt ?? t.createdAt)}
          {t.postSlug && (
            <>
              {' · '}
              <a href={`/blog/${t.postSlug}`} className="text-brand-text hover:underline">
                {t.postTitle ?? 'Read the article'}
              </a>
            </>
          )}
        </p>
      </div>
      <Badge tone={TONE[t.status] ?? 'neutral'}>{LABEL[t.status] ?? t.status}</Badge>
    </li>
  );
}

/**
 * `/ceo` > Topics: the research questions the CEO proposes for the Guildwise blog (docs/design/ceo-blog-topics.md). Only the
 * question and its area are ever sent, never the problem behind it, and nothing is sent without an Accept.
 */
export function TopicsTab() {
  const q = useCeoTopics();
  const canDecide = useCanDecideTopics(q.data);
  if (q.isPending) return <ListSkeleton label="Loading topics" rows={3} />;
  if (!q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  if (!d.enabled)
    return (
      <EmptyState
        icon={Lightbulb}
        title="Research topics are off"
        description={
          d.reason === 'sharing_off'
            ? 'The CEO collects problems and suggests blog research topics only while "Share diagnostic data with Guildwise" is on (the Owner switches it on under Settings > General).'
            : 'The CEO is not set up yet.'
        }
      />
    );
  const proposed = d.topics.filter((t) => t.status === 'proposed');
  const rest = d.topics.filter((t) => t.status !== 'proposed');
  return (
    <div className="flex flex-col gap-4" data-testid="ceo-topics">
      <Callout tone="info">
        {d.ownerOnly
          ? 'The CEO turns problems it notices into general questions that might make good blog articles for the community. Only you can decide what is sent to Guildwise, and only the question goes: no names, no source material.'
          : 'The CEO turns problems it notices into general questions for the Guildwise blog. An Owner or Admin accepts what is sent.'}
        {d.remainingThisMonth !== null && ` You can still send ${d.remainingThisMonth} this month.`}
      </Callout>
      <Panel>
        <h2 className="text-base font-semibold text-fg">Waiting for your decision</h2>
        {proposed.length === 0 ? (
          <p className="mt-1 text-sm text-muted">Nothing right now.</p>
        ) : (
          <ul className="mt-1 divide-y divide-line">
            {proposed.map((t) => (
              <ProposedTopic key={t.id} topic={t} canDecide={canDecide} />
            ))}
          </ul>
        )}
      </Panel>
      {rest.length > 0 && (
        <Panel>
          <h2 className="text-base font-semibold text-fg">What happened to the others</h2>
          <ul className="mt-1 divide-y divide-line">
            {rest.map((t) => (
              <Row key={t.id} t={t} />
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

import type { ProjectSkillDto } from '@aom/shared';
import { useProjectSkills, useReviewProjectSkill } from '../../api/queries/capabilities.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Button, Callout, EmptyState, ErrorBox, ListSkeleton } from '../ui.tsx';

const TONE = { unreviewed: 'neutral', reviewed: 'success', changed: 'warning', blocked: 'danger' } as const;
const LABEL = {
  unreviewed: 'Not reviewed',
  reviewed: 'Reviewed',
  changed: 'Changed since review',
  blocked: 'Blocked',
} as const;

function Row({ item }: { item: ProjectSkillDto }) {
  const review = useReviewProjectSkill();
  const act = (status: 'reviewed' | 'blocked' | 'unreviewed') =>
    review.mutate({
      projectId: item.projectId,
      kind: item.kind,
      key: item.key,
      hash: item.hash,
      status,
    });
  return (
    <li
      className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3"
      data-testid="project-skill"
      data-status={item.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{item.name}</span>
        <code className="text-xs text-muted">{item.key}</code>
        <Badge>{item.kind}</Badge>
        <Badge tone={TONE[item.status]} data-testid="skill-status">
          {LABEL[item.status]}
        </Badge>
      </div>
      {item.description && <p className="text-sm text-muted [overflow-wrap:anywhere]">{item.description}</p>}
      <p className="text-xs text-subtle [overflow-wrap:anywhere]">
        {item.projectKey}
        {item.repo ? ` · ${item.repo}` : ''}
        {item.path ? ` · ${item.path}` : ''} · hash <code>{item.hash.slice(0, 12)}</code>
        {item.reviewedAt && item.reviewedBy
          ? ` · ${item.status === 'blocked' ? 'blocked' : 'reviewed'} by ${item.reviewedBy}, ${formatDateTime(item.reviewedAt)}`
          : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        {item.status !== 'reviewed' && item.status !== 'blocked' && (
          <Button size="sm" variant="primary" loading={review.isPending} onClick={() => act('reviewed')}>
            Mark reviewed
          </Button>
        )}
        {item.status !== 'blocked' && (
          <Button size="sm" variant="danger-ghost" loading={review.isPending} onClick={() => act('blocked')}>
            Block
          </Button>
        )}
        {(item.status === 'blocked' || item.status === 'reviewed') && (
          <Button size="sm" loading={review.isPending} onClick={() => act('unreviewed')}>
            {item.status === 'blocked' ? 'Unblock' : 'Clear review'}
          </Button>
        )}
      </div>
      <ErrorBox error={review.error} />
    </li>
  );
}

/** Skills, personas and playbooks found in project repositories: anyone with push access can add them, so the owner reviews them. */
export function ProjectSkillsTab() {
  const q = useProjectSkills();
  const items = q.data ?? [];
  return (
    <div className="flex flex-col gap-3" data-testid="project-skills-tab">
      <Callout tone="info">
        These come from the repositories of your projects (.claude/skills, .agents/skills, .claude/agents).
        Review what they contain; a blocked one is not offered to any agent. Unreviewed ones stay usable.
      </Callout>
      {q.isPending && <ListSkeleton rows={3} />}
      <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      {q.data && items.length === 0 && (
        <EmptyState
          tone="neutral"
          title="Nothing found in project repositories"
          description="When a project's repository carries skills or agents, they are listed here for review."
        />
      )}
      <ul className="flex flex-col gap-2" aria-label="Project repository capabilities">
        {items.map((i) => (
          <Row key={`${i.projectId}:${i.kind}:${i.key}`} item={i} />
        ))}
      </ul>
    </div>
  );
}

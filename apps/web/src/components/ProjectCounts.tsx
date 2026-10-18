import type { ProjectDto } from '@aom/shared';
import { Badge } from './ui.tsx';

/** Open and blocked card counts of a project (phone project lists; the desktop rows stay as they were). */
export function ProjectCounts({ project, className = '' }: { project: ProjectDto; className?: string }) {
  const c = project.cardCounts;
  if (!c) return null;
  return (
    <p
      data-testid={`project-counts-${project.key}`}
      className={`flex flex-wrap items-center gap-1.5 text-xs text-muted ${className}`}
    >
      <span className="tnum">{c.open} open</span>
      {c.blocked > 0 && <Badge tone="red">{c.blocked} blocked</Badge>}
    </p>
  );
}

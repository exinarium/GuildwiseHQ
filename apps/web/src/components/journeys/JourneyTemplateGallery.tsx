import type { JourneyTemplate } from '@aom/shared';
import { Button } from '../ui.tsx';

/** The journey templates to start from (same layout idea as the workflow template gallery). */
export function JourneyTemplateGallery({
  templates,
  busy,
  onPick,
}: {
  templates: JourneyTemplate[];
  busy?: boolean;
  onPick: (t: JourneyTemplate) => void;
}) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2" data-testid="journey-templates">
      {templates.map((t) => (
        <li key={t.id} className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
          <h3 className="text-base font-semibold text-fg">{t.name}</h3>
          <p className="text-sm text-muted">{t.description}</p>
          <p className="text-xs text-subtle">
            {t.definition.steps.length} steps · for a {t.definition.recordType}
          </p>
          <Button className="mt-auto self-start" loading={busy} onClick={() => onPick(t)}>
            Use this template
          </Button>
        </li>
      ))}
    </ul>
  );
}

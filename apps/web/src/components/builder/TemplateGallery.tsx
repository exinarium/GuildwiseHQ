import { BUILTIN_WORKFLOWS, WORKFLOW_TEMPLATES } from '@aom/shared';
import { useState } from 'react';
import { Button, Callout, Panel, Select } from '../ui.tsx';

const COPYABLE = ['code', 'research'];

/** Where a new workflow starts: a template, or a copy of a built-in workflow (with the notice of what is lost). */
export function TemplateGallery({
  onTemplate,
  onCopy,
}: {
  onTemplate: (id: string) => void;
  onCopy: (builtinKey: string) => void;
}) {
  const builtins = BUILTIN_WORKFLOWS.filter((w) => COPYABLE.includes(w.key));
  const [copyKey, setCopyKey] = useState(builtins[0]?.key ?? '');
  return (
    <div className="flex flex-col gap-6" data-testid="template-gallery">
      <section aria-labelledby="templates-title">
        <h2 id="templates-title" className="mb-1 text-lg font-semibold">
          Start from a template
        </h2>
        <p className="mb-3 text-sm text-muted">
          Pick the closest one. You can add, remove and rename steps afterwards. Or describe what you need to
          the BA in a design chat on the Organization page.
        </p>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {WORKFLOW_TEMPLATES.map((t) => {
            const steps = t.definition.stages.map((s) => s.label).join(' → ');
            return (
              <li key={t.id} data-testid={`template-${t.id}`}>
                <Panel className="flex h-full flex-col gap-2">
                  <h3 className="font-semibold">{t.name}</h3>
                  <p className="text-sm text-muted">{t.description}</p>
                  <p className="text-xs text-subtle">{steps}</p>
                  <div className="mt-auto pt-1">
                    <Button
                      variant="primary"
                      aria-label={`Use the ${t.name} template`}
                      onClick={() => onTemplate(t.id)}
                    >
                      Use this template
                    </Button>
                  </div>
                </Panel>
              </li>
            );
          })}
        </ul>
      </section>
      {builtins.length > 0 && (
        <section aria-labelledby="copy-title" className="max-w-xl">
          <h2 id="copy-title" className="mb-1 text-lg font-semibold">
            Or copy a built-in workflow
          </h2>
          <Callout tone="warning" role="note" className="mb-3">
            A copy is a custom workflow. The special behaviour of the built-in one does not carry over: for
            example, testing that opens bug cards, or research that gets published. After copying you see what
            was left out. To extend the Code workflow and keep its behaviour, add steps to it in a project's
            settings instead.
          </Callout>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Select label="Built-in workflow" value={copyKey} onChange={(e) => setCopyKey(e.target.value)}>
                {builtins.map((w) => (
                  <option key={w.key} value={w.key}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button disabled={!copyKey} onClick={() => onCopy(copyKey)}>
              Copy it
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

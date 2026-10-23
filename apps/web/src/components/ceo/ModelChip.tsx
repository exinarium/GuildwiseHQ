import {
  type CeoChatStateDto,
  DIRECT_RUNTIME,
  findModelOption,
  MODEL_CHOICES,
  type ModelChoice,
  modelChoiceLabel,
  modelChoicesFor,
} from '@aom/shared';
import { Cpu } from 'lucide-react';
import { useState } from 'react';
import { useSetThreadModel } from '../../api/queries/ceo-chat.ts';
import { Button, Dialog, ErrorBox, Segmented, Select } from '../ui.tsx';

/** The model's own name without the effort ("Sonnet"). */
const modelName = (c: ModelChoice, providers?: CeoChatStateDto['model']['providers']): string =>
  findModelOption(c, providers)?.label ?? c.model;

/**
 * The model chip of the CEO composer (docs/design/ceo-front-door.md section 5.4): "Default (Sonnet)", and a persistent chip
 * while a conversation or message override is set. The menu is provider neutral: it groups the registry by runtime and shows
 * only the runtimes the workstation reports.
 */
export function ModelChip({
  model,
  messageChoice,
  onMessageChoice,
}: {
  model: CeoChatStateDto['model'];
  /** A choice that applies to the next message only. */
  messageChoice: ModelChoice | null;
  onMessageChoice: (c: ModelChoice | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const setThread = useSetThreadModel();
  const groups = modelChoicesFor(model.runtimes.length > 0 ? model.runtimes : undefined, model.providers);
  const start = messageChoice ?? model.thread ?? model.default;
  const [pick, setPick] = useState(`${start.runtime}/${start.model}`);
  const [effort, setEffort] = useState(start.effort ?? '');
  const [scope, setScope] = useState<'message' | 'thread'>('thread');

  const label = messageChoice
    ? `This message: ${modelChoiceLabel(messageChoice, model.providers)}`
    : model.thread
      ? `This conversation: ${modelChoiceLabel(model.thread, model.providers)}`
      : `Default (${modelName(model.default, model.providers)})`;
  const overridden = !!messageChoice || !!model.thread;

  const [runtime = '', modelId = ''] = pick.split('/');
  const effortLevels = MODEL_CHOICES[runtime]?.find((m) => m.id === modelId)?.effortLevels ?? [];
  const choice: ModelChoice = {
    runtime,
    model: modelId,
    ...(effort && effortLevels.includes(effort) ? { effort } : {}),
  };

  const apply = () => {
    if (scope === 'message') {
      onMessageChoice(choice);
      setOpen(false);
    } else {
      setThread.mutate(choice, {
        onSuccess: () => {
          onMessageChoice(null);
          setOpen(false);
        },
      });
    }
  };
  const reset = () => {
    onMessageChoice(null);
    if (model.thread) setThread.mutate(null, { onSuccess: () => setOpen(false) });
    else setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        data-testid="model-chip"
        data-overridden={overridden}
        aria-label={`Model: ${label}`}
        onClick={() => setOpen(true)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium ${
          overridden
            ? 'border-brand bg-brand-soft text-brand-soft-fg'
            : 'border-control bg-surface text-muted hover:bg-sunken hover:text-fg'
        }`}
      >
        <Cpu aria-hidden="true" className="size-3.5" />
        {label}
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Model for this chat"
        description={`The default is ${modelChoiceLabel(model.default, model.providers)}. Pick another for one message or for the whole conversation.`}
        footer={
          <>
            {overridden && (
              <Button onClick={reset} data-testid="model-default" loading={setThread.isPending}>
                Back to default
              </Button>
            )}
            <Button variant="primary" onClick={apply} data-testid="model-apply" loading={setThread.isPending}>
              Use it
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <fieldset key={`${g.runtime}/${g.provider ?? ''}`} className="flex flex-col gap-1">
              <legend className="text-sm font-semibold text-fg">{g.label}</legend>
              {g.runtime === DIRECT_RUNTIME && (
                <p className="text-xs text-subtle" data-testid="direct-note">
                  Conversation only: no tools, cannot take actions.
                </p>
              )}
              {g.models.map((m) => (
                <label key={m.id} className="flex min-h-9 items-center gap-2 text-sm text-fg">
                  <input
                    type="radio"
                    name="ceo-model"
                    className="size-4"
                    value={`${g.runtime}/${m.id}`}
                    checked={pick === `${g.runtime}/${m.id}`}
                    onChange={() => {
                      setPick(`${g.runtime}/${m.id}`);
                      setEffort('');
                    }}
                  />
                  {m.label}
                </label>
              ))}
            </fieldset>
          ))}
          {effortLevels.length > 0 && (
            <Select label="Effort" value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="">Default effort</option>
              {effortLevels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          )}
          <Segmented
            label="Applies to"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'message', label: 'This message' },
              { value: 'thread', label: 'This conversation' },
            ]}
          />
          <ErrorBox error={setThread.error} />
        </div>
      </Dialog>
    </>
  );
}

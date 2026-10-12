import type { ExplainField } from '@aom/shared';
import {
  addRoute,
  type BuilderModel,
  type BuilderRoute,
  type BuilderStep,
  nextIndex,
  otherRoutes,
  removeRoute,
  sendBackIndex,
  setNext,
  setRoute,
  setSendBack,
  updateStep,
  yesNoFields,
} from '../../lib/builder.ts';
import { Button, Select } from '../ui.tsx';

export interface RouteEditorProps {
  step: BuilderStep;
  model: BuilderModel;
  onChange: (m: BuilderModel) => void;
  readOnly?: boolean;
  /** The id of the issue list of this step when an issue is about `field`, so the input can point at it. */
  describedBy: (field: ExplainField) => string | undefined;
}

/** "When finished, go to", "If not good enough, send back to", "Only when ...", and the extra routes (advanced). */
export function RouteEditor({ step, model, onChange, readOnly, describedBy }: RouteEditorProps) {
  const others = model.steps.filter((s) => s.uid !== step.uid);
  const n = nextIndex(step);
  const b = sendBackIndex(step);
  const next = n === -1 ? '' : (step.routes[n] as BuilderRoute).to;
  const back = b === -1 ? '' : (step.routes[b] as BuilderRoute).to;
  const yesNo = yesNoFields(model);
  const stepLabel = (uid: string) => {
    const i = model.steps.findIndex((s) => s.uid === uid);
    const s = model.steps[i];
    return s ? `${i + 1}. ${s.label || 'Untitled step'}` : 'A step that no longer exists';
  };
  const options = (current: string) => (
    <>
      {others.map((s) => (
        <option key={s.uid} value={s.uid}>
          {stepLabel(s.uid)}
        </option>
      ))}
      {current && !others.some((s) => s.uid === current) && (
        <option value={current}>{stepLabel(current)}</option>
      )}
    </>
  );
  const when = step.when;
  const isStart = step.kind === 'manual';
  const finalStep = step.kind === 'terminal';
  return (
    <div className="flex flex-col gap-3" data-testid={`routes-${step.uid}`}>
      {!finalStep && (
        <>
          <Select
            label={isStart ? 'When it is ready, go to' : 'When finished, go to'}
            value={next}
            disabled={readOnly}
            aria-describedby={describedBy('route')}
            aria-invalid={describedBy('route') ? true : undefined}
            onChange={(e) => onChange(setNext(model, step.uid, e.target.value))}
          >
            {next === '' && <option value="">Choose the next step</option>}
            {options(next)}
          </Select>
          {!isStart && (
            <Select
              label="If it is not good enough, send back to"
              value={back}
              disabled={readOnly}
              hint="Optional. The card goes back to that step for another round."
              onChange={(e) => onChange(setSendBack(model, step.uid, e.target.value || null))}
            >
              <option value="">Nowhere (this step cannot send work back)</option>
              {options(back)}
            </Select>
          )}
        </>
      )}
      {!isStart && !finalStep && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Select
            label="Only when this answer applies"
            value={when?.field ?? ''}
            disabled={readOnly || yesNo.length === 0}
            hint={
              yesNo.length === 0
                ? 'Add a yes-or-no piece of information to the card to skip this step for some cards.'
                : 'Skip this step unless the card says so.'
            }
            aria-describedby={describedBy('when')}
            onChange={(e) =>
              onChange(
                updateStep(model, step.uid, {
                  when: e.target.value ? { field: e.target.value, equals: true } : undefined,
                }),
              )
            }
          >
            <option value="">Always do this step</option>
            {yesNo.map((f) => (
              <option key={f.uid} value={f.uid}>
                {f.label || f.key || 'Unnamed information'}
              </option>
            ))}
          </Select>
          {when && (
            <Select
              label="is"
              value={when.equals === false ? 'no' : 'yes'}
              disabled={readOnly}
              onChange={(e) =>
                onChange(
                  updateStep(model, step.uid, {
                    when: { field: when.field, equals: e.target.value === 'yes' },
                  }),
                )
              }
            >
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          )}
        </div>
      )}
      {!finalStep && (
        <details open={otherRoutes(step).length > 0} className="text-sm">
          <summary className="cursor-pointer font-medium text-muted">
            Other routes (advanced){otherRoutes(step).length > 0 ? ` (${otherRoutes(step).length})` : ''}
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {otherRoutes(step).length === 0 && (
              <p className="text-xs text-subtle">
                A step normally has one way forward and, if it checks work, one way back.
              </p>
            )}
            {otherRoutes(step).map(({ route, index }) => (
              <div
                key={`${index}-${route.id}`}
                className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                data-testid={`extra-route-${step.uid}-${route.id}`}
              >
                <Select
                  label={`Route "${route.label}" goes to`}
                  value={route.to}
                  disabled={readOnly}
                  onChange={(e) => onChange(setRoute(model, step.uid, index, { to: e.target.value }))}
                >
                  {options(route.to)}
                </Select>
                <Select
                  label={`Route "${route.label}" applies`}
                  value={
                    route.when ? `${route.when.field}|${route.when.equals === false ? 'no' : 'yes'}` : ''
                  }
                  disabled={readOnly}
                  onChange={(e) => {
                    const [field, answer] = e.target.value.split('|');
                    onChange(
                      setRoute(model, step.uid, index, {
                        when: field ? { field, equals: answer === 'yes' } : undefined,
                      }),
                    );
                  }}
                >
                  <option value="">Always</option>
                  {route.when && !yesNo.some((f) => f.uid === route.when?.field) && (
                    <option value={`${route.when.field}|${route.when.equals === false ? 'no' : 'yes'}`}>
                      When {route.when.field} is {route.when.equals === false ? 'no' : 'yes'}
                    </option>
                  )}
                  {yesNo.flatMap((f) => [
                    <option key={`${f.uid}|yes`} value={`${f.uid}|yes`}>
                      When {f.label || f.key} is yes
                    </option>,
                    <option key={`${f.uid}|no`} value={`${f.uid}|no`}>
                      When {f.label || f.key} is no
                    </option>,
                  ])}
                </Select>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    aria-label={`Remove route ${route.label} of ${step.label}`}
                    onClick={() => onChange(removeRoute(model, step.uid, index))}
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
            {!readOnly && others.length > 0 && (
              <div>
                <Button
                  aria-label={`Add a route to ${step.label || 'this step'}`}
                  onClick={() => onChange(addRoute(model, step.uid, (others[0] as BuilderStep).uid))}
                >
                  Add a route
                </Button>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

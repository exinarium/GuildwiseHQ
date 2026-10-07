import { ALL_INTEREST_KINDS, type InterestKind, SCHEDULE_PRESETS } from '@aom/shared';
import { cronOf, derivedWindow, type FormErrors, type InterestFormValues } from '../../lib/interests.ts';
import { Select, TextArea, TextInput } from '../ui.tsx';

const KIND_LABEL: Record<InterestKind, string> = {
  article: 'Articles',
  video: 'Videos',
  podcast: 'Podcasts',
};

const PresetOptions = () => (
  <>
    {SCHEDULE_PRESETS.map((p) => (
      <option key={p.id} value={p.id}>
        {p.label}
      </option>
    ))}
    <option value="custom">Custom cron expression</option>
  </>
);

/**
 * The fields of an interest: what it is about, its run schedule (when scans happen), its delivery schedule (when results
 * reach you) and its limits. Used by the "New interest" dialog and the Settings tab.
 */
export function InterestForm({
  v,
  set,
  errors,
  disabled,
  domainLocked,
  subCategories = [],
}: {
  v: InterestFormValues;
  set: <K extends keyof InterestFormValues>(k: K, val: InterestFormValues[K]) => void;
  errors: FormErrors;
  disabled?: boolean;
  domainLocked?: boolean;
  subCategories?: string[];
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="interest-form">
      <TextInput
        label="Name"
        value={v.name}
        error={errors.name}
        disabled={disabled}
        data-testid="interest-name"
        onChange={(e) => set('name', e.target.value)}
      />
      <TextArea
        label="Description"
        hint="Markdown. The angle, what to include or leave out, the level. The agents follow this first."
        rows={4}
        value={v.description}
        disabled={disabled}
        data-testid="interest-description"
        onChange={(e) => set('description', e.target.value)}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Vault"
          hint={
            domainLocked
              ? 'Fixed once the interest has run.'
              : 'Where its notes and files live: your personal or your work vault.'
          }
          value={v.domain}
          disabled={disabled || domainLocked}
          data-testid="interest-domain"
          onChange={(e) => set('domain', e.target.value as 'personal' | 'work')}
        >
          <option value="personal">Personal</option>
          <option value="work">Work</option>
        </Select>
        <TextInput
          label="Sub-category"
          list="interest-subcategories"
          value={v.subCategory}
          disabled={disabled}
          data-testid="interest-sub-category"
          onChange={(e) => set('subCategory', e.target.value)}
        />
        <datalist id="interest-subcategories">
          {subCategories.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      <TextArea
        label="Preferred sites (one per line)"
        rows={2}
        value={v.sites}
        disabled={disabled}
        data-testid="interest-sites"
        onChange={(e) => set('sites', e.target.value)}
      />

      <fieldset className="flex flex-col gap-2 rounded-card border border-line p-3">
        <legend className="px-1 text-sm font-medium text-fg">What to collect</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2" role="group" aria-label="Kinds of item">
          {ALL_INTEREST_KINDS.map((k) => (
            <label
              key={k}
              className="flex min-h-9 items-center gap-2 text-sm [@media(pointer:coarse)]:min-h-11"
            >
              <input
                type="checkbox"
                checked={v.kinds[k]}
                disabled={disabled}
                data-testid={`interest-kind-${k}`}
                onChange={(e) => set('kinds', { ...v.kinds, [k]: e.target.checked })}
              />
              {KIND_LABEL[k]}
            </label>
          ))}
        </div>
        {errors.kinds && (
          <p role="alert" className="text-sm font-medium text-danger">
            {errors.kinds}
          </p>
        )}
        <TextInput
          label="Max total items per run"
          hint="The best N across articles, videos and podcasts together."
          inputMode="numeric"
          value={v.maxItems}
          error={errors.maxItems}
          disabled={disabled}
          data-testid="interest-max-items"
          onChange={(e) => set('maxItems', e.target.value)}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded-card border border-line p-3">
        <legend className="px-1 text-sm font-medium text-fg">Run schedule: when it scans</legend>
        <label className="flex min-h-9 items-center gap-2 text-sm [@media(pointer:coarse)]:min-h-11">
          <input
            type="checkbox"
            checked={v.manual}
            disabled={disabled}
            data-testid="interest-manual"
            onChange={(e) => set('manual', e.target.checked)}
          />
          Only when I press Run now
        </label>
        {!v.manual && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label="When"
                value={v.preset}
                disabled={disabled}
                data-testid="interest-preset"
                onChange={(e) => set('preset', e.target.value)}
              >
                <PresetOptions />
              </Select>
              <TextInput
                label="Time zone"
                hint="IANA name, e.g. Africa/Johannesburg"
                value={v.timezone}
                disabled={disabled}
                data-testid="interest-timezone"
                onChange={(e) => set('timezone', e.target.value)}
              />
            </div>
            {v.preset === 'custom' && (
              <TextInput
                label="Cron expression"
                hint="minute hour day month weekday"
                value={v.cron}
                error={errors.cron}
                disabled={disabled}
                data-testid="interest-cron"
                onChange={(e) => set('cron', e.target.value)}
              />
            )}
            <TextInput
              label="Look back (hours)"
              hint={`Empty: ${derivedWindow(cronOf(v))} hours, from the schedule.`}
              inputMode="numeric"
              placeholder={String(derivedWindow(cronOf(v)))}
              value={v.windowHours}
              error={errors.windowHours}
              disabled={disabled}
              data-testid="interest-window"
              onChange={(e) => set('windowHours', e.target.value)}
            />
          </>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded-card border border-line p-3">
        <legend className="px-1 text-sm font-medium text-fg">
          Delivery schedule: when results reach you
        </legend>
        <p className="text-xs text-subtle">
          Runs can happen ahead of delivery. New items wait and arrive as one digest on your desk; nothing is
          pushed in between. The organization's daily quiet cap applies.
        </p>
        <Select
          label="Deliver"
          value={v.deliveryMode}
          disabled={disabled}
          data-testid="interest-delivery-mode"
          onChange={(e) => set('deliveryMode', e.target.value as 'immediate' | 'scheduled')}
        >
          <option value="scheduled">As one digest at set times</option>
          <option value="immediate">As soon as a run finishes</option>
        </Select>
        {v.deliveryMode === 'scheduled' && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label="Delivery time"
                value={v.deliveryPreset}
                disabled={disabled}
                data-testid="interest-delivery-preset"
                onChange={(e) => set('deliveryPreset', e.target.value)}
              >
                <PresetOptions />
              </Select>
              <TextInput
                label="Time zone"
                value={v.deliveryTimezone}
                disabled={disabled}
                data-testid="interest-delivery-timezone"
                onChange={(e) => set('deliveryTimezone', e.target.value)}
              />
            </div>
            {v.deliveryPreset === 'custom' && (
              <TextInput
                label="Cron expression"
                hint="minute hour day month weekday"
                value={v.deliveryCron}
                error={errors.deliveryCron}
                disabled={disabled}
                data-testid="interest-delivery-cron"
                onChange={(e) => set('deliveryCron', e.target.value)}
              />
            )}
          </>
        )}
      </fieldset>
    </div>
  );
}

import {
  type CreateInterestRequest,
  type InterestDto,
  type PatchInterestRequest,
  SCHEDULE_PRESETS,
  suggestProjectKey,
} from '@aom/shared';
import * as RadixDialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useState } from 'react';
import {
  useCreateInterest,
  useDeleteInterest,
  useInterest,
  usePatchInterest,
  useSaveInterestTaste,
} from '../../api/queries/interests.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { defaultTimezone, parseSites } from '../../lib/feeds.ts';
import {
  cronOf,
  derivedWindow,
  emptyValues,
  type InterestFormValues,
  validateInterest,
  valuesFromInterest,
} from '../../lib/interests.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Button, Dialog, ErrorBox, Select, TextArea, TextInput } from '../ui.tsx';
import { TasteRulesEditor } from './TasteRulesEditor.tsx';

const NONE = '';

/**
 * Create or edit an interest: a right-hand panel on wide screens, a full-screen sheet on phones, with a sticky footer
 * (docs/design/interests.md section 8.3). Everything the interest says lives here: intent, projects, scan, taste rules.
 */
export function InterestDrawer({ interest, onClose }: { interest: InterestDto | null; onClose: () => void }) {
  const projects = useProjects();
  const detail = useInterest(interest?.id);
  const create = useCreateInterest();
  const patch = usePatchInterest();
  const del = useDeleteInterest();
  const saveTaste = useSaveInterestTaste();
  const zone = defaultTimezone();
  const [v, setV] = useState<InterestFormValues>(() =>
    interest ? valuesFromInterest(interest, zone) : emptyValues(zone),
  );
  const [rules, setRules] = useState<string[] | null>(null);
  const [errors, setErrors] = useState<ReturnType<typeof validateInterest>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [keepSchedule, setKeepSchedule] = useState(false);
  const set = <K extends keyof InterestFormValues>(k: K, val: InterestFormValues[K]) =>
    setV((cur) => ({ ...cur, [k]: val }));

  // The drawer refetches the interest on open; its taste rules arrive with the detail.
  useEffect(() => {
    if (detail.data && rules === null) setRules(detail.data.taste.rules);
  }, [detail.data, rules]);

  const feedProjects = (projects.data ?? []).filter((p) => p.workflowKey === 'feed');
  const researchProjects = (projects.data ?? []).filter((p) => p.workflowKey === 'research');
  const readOnly = interest ? !interest.canManage : false;
  const hasFeed = v.newFeed || !!v.feedProjectId;
  const subCategories = useMemo(() => {
    const p = (projects.data ?? []).find((x) => x.id === (v.researchProjectId || v.feedProjectId));
    return p?.subCategories ?? [];
  }, [projects.data, v.researchProjectId, v.feedProjectId]);
  const cron = cronOf(v);
  const placeholderWindow = derivedWindow(cron);
  const pending = create.isPending || patch.isPending || saveTaste.isPending;
  const error = create.error ?? patch.error ?? saveTaste.error;

  const scanBody = () => ({
    cron,
    timezone: v.timezone.trim() || 'UTC',
    ...(v.windowHours.trim() ? { windowHours: Number.parseInt(v.windowHours, 10) } : {}),
    maxItems: Number.parseInt(v.maxItems, 10) || 10,
    manual: v.manual,
  });

  const submit = () => {
    const found = validateInterest(v);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const sites = parseSites(v.sites);
    const done = async (id: string) => {
      if (
        rules !== null &&
        hasFeed &&
        JSON.stringify(rules) !== JSON.stringify(detail.data?.taste.rules ?? [])
      )
        await saveTaste.mutateAsync({ id, rules });
      onClose();
    };
    if (!interest) {
      const body: CreateInterestRequest = {
        name: v.name.trim(),
        description: v.description,
        preferredSites: sites,
        status: v.status,
        ...(v.newFeed
          ? { newFeedProject: { key: v.newFeedKey, name: v.newFeedName.trim(), domain: v.newFeedDomain } }
          : v.feedProjectId
            ? { feedProjectId: v.feedProjectId }
            : {}),
        ...(v.researchProjectId ? { researchProjectId: v.researchProjectId } : {}),
        ...(v.subCategory.trim() ? { subCategory: v.subCategory.trim() } : {}),
        ...(hasFeed ? { scan: scanBody() } : {}),
      };
      create.mutate(body, { onSuccess: (r) => void done(r.id) });
      return;
    }
    const body: PatchInterestRequest = {
      name: v.name.trim(),
      description: v.description,
      feedProjectId: v.feedProjectId || null,
      researchProjectId: v.researchProjectId || null,
      subCategory: v.subCategory.trim() || null,
      preferredSites: sites,
      status: v.status,
      ...(v.feedProjectId ? { scan: scanBody() } : {}),
    };
    patch.mutate({ id: interest.id, body }, { onSuccess: () => void done(interest.id) });
  };

  const nextRun =
    interest?.schedule?.enabled && interest.schedule.nextFireAt
      ? formatDateTime(interest.schedule.nextFireAt)
      : v.manual
        ? 'manual only'
        : 'not scheduled';

  return (
    <>
      <RadixDialog.Root open onOpenChange={(o) => !o && onClose()}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <RadixDialog.Content
            data-testid="interest-drawer"
            className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-white shadow-xl sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[480px] sm:border-l sm:border-zinc-200 dark:bg-zinc-900 dark:sm:border-zinc-700"
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <div className="min-w-0">
                <RadixDialog.Title className="truncate text-base font-semibold">
                  {interest ? `Edit interest: ${interest.name}` : 'New interest'}
                </RadixDialog.Title>
                <RadixDialog.Description className="sr-only">
                  What you care about: the topic, where it is scanned, how often, and your taste rules.
                </RadixDialog.Description>
              </div>
              <RadixDialog.Close asChild>
                <Button variant="ghost" aria-label="Close" className="min-h-11 sm:min-h-8">
                  Close
                </Button>
              </RadixDialog.Close>
            </div>

            <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
              {readOnly && (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  You are not a member of every project this interest links to, so you cannot edit it.
                </p>
              )}
              <TextInput
                label="Name"
                value={v.name}
                error={errors.name}
                disabled={readOnly}
                data-testid="interest-name"
                onChange={(e) => set('name', e.target.value)}
              />
              <TextArea
                label="Description"
                hint="Markdown. The angle, what to include or leave out, the level. The agents follow this first."
                rows={5}
                value={v.description}
                disabled={readOnly}
                data-testid="interest-description"
                onChange={(e) => set('description', e.target.value)}
              />

              <Select
                label="Feed project"
                value={v.newFeed ? '__new' : v.feedProjectId}
                disabled={readOnly}
                data-testid="interest-feed-project"
                onChange={(e) => {
                  if (e.target.value === '__new')
                    setV((cur) => ({
                      ...cur,
                      newFeed: true,
                      feedProjectId: NONE,
                      newFeedName: cur.newFeedName || cur.name,
                      newFeedKey: cur.newFeedKey || suggestProjectKey(cur.name || 'Feed'),
                    }));
                  else setV((cur) => ({ ...cur, newFeed: false, feedProjectId: e.target.value }));
                }}
              >
                <option value={NONE}>None (research only)</option>
                {feedProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key} {p.name}
                  </option>
                ))}
                {!interest && <option value="__new">+ New feed project</option>}
              </Select>
              {v.newFeed && (
                <fieldset className="grid gap-2 rounded-md border border-zinc-200 p-2 sm:grid-cols-3 dark:border-zinc-800">
                  <legend className="px-1 text-xs text-zinc-500">New feed project</legend>
                  <TextInput
                    label="Key"
                    value={v.newFeedKey}
                    data-testid="new-feed-key"
                    onChange={(e) => set('newFeedKey', e.target.value.toUpperCase())}
                  />
                  <TextInput
                    label="Name"
                    value={v.newFeedName}
                    data-testid="new-feed-name"
                    onChange={(e) => set('newFeedName', e.target.value)}
                  />
                  <Select
                    label="Domain"
                    value={v.newFeedDomain}
                    onChange={(e) => set('newFeedDomain', e.target.value as 'personal' | 'work')}
                  >
                    <option value="personal">personal</option>
                    <option value="work">work</option>
                  </Select>
                  {errors.newFeed && (
                    <p role="alert" className="text-xs font-medium text-red-600 sm:col-span-3">
                      {errors.newFeed}
                    </p>
                  )}
                </fieldset>
              )}
              <Select
                label="Research project"
                value={v.researchProjectId}
                disabled={readOnly}
                data-testid="interest-research-project"
                error={errors.project}
                onChange={(e) => set('researchProjectId', e.target.value)}
              >
                <option value={NONE}>None</option>
                {researchProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key} {p.name}
                  </option>
                ))}
              </Select>
              <TextInput
                label="Sub-category"
                list="interest-subcategories"
                value={v.subCategory}
                disabled={readOnly}
                onChange={(e) => set('subCategory', e.target.value)}
              />
              <datalist id="interest-subcategories">
                {subCategories.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <TextArea
                label="Preferred sites (one per line)"
                rows={2}
                value={v.sites}
                disabled={readOnly}
                onChange={(e) => set('sites', e.target.value)}
              />

              {hasFeed && (
                <fieldset className="flex flex-col gap-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
                  <legend className="px-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">Scan</legend>
                  <Select
                    label="When"
                    value={v.preset}
                    disabled={readOnly}
                    data-testid="interest-preset"
                    onChange={(e) => set('preset', e.target.value)}
                  >
                    {SCHEDULE_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                    <option value="custom">Custom cron expression</option>
                  </Select>
                  {v.preset === 'custom' && (
                    <TextInput
                      label="Cron expression"
                      hint="minute hour day month weekday"
                      value={v.cron}
                      error={errors.cron}
                      disabled={readOnly}
                      data-testid="interest-cron"
                      onChange={(e) => set('cron', e.target.value)}
                    />
                  )}
                  <TextInput
                    label="Time zone"
                    hint="IANA name, e.g. Africa/Johannesburg"
                    value={v.timezone}
                    disabled={readOnly}
                    onChange={(e) => set('timezone', e.target.value)}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <TextInput
                      label="Window (hours)"
                      inputMode="numeric"
                      placeholder={String(placeholderWindow)}
                      value={v.windowHours}
                      error={errors.windowHours}
                      disabled={readOnly}
                      data-testid="interest-window"
                      onChange={(e) => set('windowHours', e.target.value)}
                    />
                    <TextInput
                      label="Max items"
                      inputMode="numeric"
                      value={v.maxItems}
                      error={errors.maxItems}
                      disabled={readOnly}
                      data-testid="interest-max-items"
                      onChange={(e) => set('maxItems', e.target.value)}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={v.manual}
                      disabled={readOnly}
                      data-testid="interest-manual"
                      onChange={(e) => set('manual', e.target.checked)}
                    />
                    Manual only (use Run now)
                  </label>
                  <p className="text-xs text-zinc-500" data-testid="interest-next-run">
                    Next run: {nextRun}
                  </p>
                </fieldset>
              )}

              {hasFeed && (
                <fieldset className="flex flex-col gap-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
                  <legend className="px-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    Taste rules for this interest
                  </legend>
                  {interest && rules === null ? (
                    <p className="text-xs text-zinc-500">Loading rules...</p>
                  ) : (
                    <TasteRulesEditor rules={rules ?? []} onChange={setRules} disabled={readOnly} />
                  )}
                  {interest && detail.data && (
                    <p className="text-xs text-zinc-500" data-testid="taste-mirror-status">
                      {detail.data.taste.hasVault
                        ? `Mirrored to taste.md (rules version ${detail.data.taste.version}).`
                        : 'This project has no vault: the rules reach the curators through their brief only.'}
                    </p>
                  )}
                </fieldset>
              )}

              <fieldset className="flex items-center gap-4 text-sm">
                <legend className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">Status</legend>
                {(['active', 'paused'] as const).map((s) => (
                  <label key={s} className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="interest-status"
                      value={s}
                      checked={v.status === s}
                      disabled={readOnly}
                      onChange={() => set('status', s)}
                    />
                    {s === 'active' ? 'Active' : 'Paused'}
                  </label>
                ))}
              </fieldset>
              <ErrorBox error={error} />
            </div>

            <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div>
                {interest && !readOnly && (
                  <Button
                    variant="danger"
                    className="min-h-11 sm:min-h-8"
                    data-testid="interest-delete"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete...
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button className="min-h-11 sm:min-h-8" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  className="min-h-11 sm:min-h-8"
                  data-testid="interest-save"
                  disabled={pending || readOnly}
                  onClick={submit}
                >
                  {interest ? 'Save' : 'Create'}
                </Button>
              </div>
            </div>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>

      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${interest?.name ?? ''}"?`}
        description="Its feed schedule is deleted with it. Scans, items and notes that already exist stay."
      >
        <div className="flex flex-col gap-3" data-testid="interest-delete-dialog">
          {interest?.scheduleId && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={keepSchedule}
                data-testid="interest-keep-schedule"
                onChange={(e) => setKeepSchedule(e.target.checked)}
              />
              Keep the schedule as a plain schedule
            </label>
          )}
          <ErrorBox error={del.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              data-testid="interest-delete-confirm"
              disabled={del.isPending}
              onClick={() =>
                interest && del.mutate({ id: interest.id, keepSchedule }, { onSuccess: () => onClose() })
              }
            >
              Delete interest
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

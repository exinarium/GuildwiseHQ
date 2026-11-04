import {
  FIELD_TYPE_META,
  type FormDefinition,
  type FormDefinitionIssue,
  type FormField,
  type FormFieldType,
  formLogoUrl,
  newFormDefinition,
  newFormField,
  validateFormDefinition,
} from '@aom/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, errorMessage } from '../api/client.ts';
import { useMe } from '../api/queries/auth.ts';
import { usePublication } from '../api/queries/public-forms.ts';
import {
  useCreateForm,
  useForm,
  useFormVersion,
  useSaveForm,
  useStorageConnections,
} from '../api/queries/forms.ts';
import { FieldPalette } from '../components/forms/FieldPalette.tsx';
import { FieldProperties } from '../components/forms/FieldProperties.tsx';
import { FormCanvas } from '../components/forms/FormCanvas.tsx';
import { FormRenderer } from '../components/forms/FormRenderer.tsx';
import { ClientLinksPanel } from '../components/forms/ClientLinksPanel.tsx';
import { FormSettingsPanel } from '../components/forms/FormSettingsPanel.tsx';
import { PublishPanel } from '../components/forms/PublishPanel.tsx';
import { SubmissionsList } from '../components/forms/SubmissionsList.tsx';
import { LargerScreenNote } from '../components/ui/LargerScreenNote.tsx';
import { panelId, tabId } from '../components/ui/Tabs.tsx';
import {
  Button,
  Callout,
  ErrorBox,
  Menu,
  MenuItem,
  PageHeader,
  Panel,
  Spinner,
  Tabs,
  useToast,
} from '../components/ui.tsx';
import {
  duplicateField,
  insertField,
  moveField,
  newFieldId,
  removeField,
  updateField,
} from '../lib/formBuilder.ts';

const NEW = 'new';

/** Design a form (Build tab) and check it as a client sees it (Preview tab). Every save is a new version. */
export function FormBuilderPage() {
  const { id = NEW } = useParams();
  const [params] = useSearchParams();
  const isNew = id === NEW;
  const viewVersion = Number(params.get('version')) || undefined;
  const me = useMe();
  const role = me.data?.activeOrg?.role;
  const canEdit = role === 'owner' || role === 'admin';
  const toast = useToast();
  const navigate = useNavigate();

  const formQ = useForm(isNew ? undefined : id);
  const versionQ = useFormVersion(isNew ? undefined : id, viewVersion);
  const connections = useStorageConnections();
  const publication = usePublication(isNew ? undefined : id);
  const create = useCreateForm();
  const save = useSaveForm(id);

  const [draft, setDraft] = useState<FormDefinition | null>(
    isNew ? newFormDefinition('Untitled form') : null,
  );
  const [baseVersion, setBaseVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'build' | 'preview' | 'share'>('build');
  const [announce, setAnnounce] = useState('');
  const [phoneWidth, setPhoneWidth] = useState(false);

  const readOnly = !canEdit || (!isNew && !!viewVersion && viewVersion !== formQ.data?.latestVersion);
  const loaded = viewVersion ? versionQ.data?.definition : formQ.data?.definition;

  // Take the server's definition when it arrives (or a newer one after a save/reload), unless there are unsaved edits.
  const serverKey = isNew ? null : `${id}:${viewVersion ?? 'latest'}:${formQ.data?.latestVersion ?? ''}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the server copy changes
  useEffect(() => {
    if (isNew || !loaded) return;
    if (dirty && !viewVersion) return;
    setDraft(structuredClone(loaded));
    if (!viewVersion && formQ.data) setBaseVersion(formQ.data.latestVersion);
    setDirty(false);
    setSelectedId(null);
  }, [serverKey, !!loaded]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const check = useMemo(() => (draft ? validateFormDefinition(draft) : null), [draft]);
  const issues: FormDefinitionIssue[] = check && !check.ok ? check.issues : [];
  const edit = useCallback((fn: (d: FormDefinition) => FormDefinition) => {
    setDraft((d) => (d ? fn(d) : d));
    setDirty(true);
  }, []);

  const addAt = (type: FormFieldType, at?: number) => {
    if (!draft || readOnly) return;
    const taken = draft.fields.map((f) => f.id);
    const field = newFormField(type, newFieldId(taken));
    const sel = draft.fields.findIndex((f) => f.id === selectedId);
    const index = at ?? (sel >= 0 ? sel + 1 : draft.fields.length);
    edit((d) => ({ ...d, fields: insertField(d.fields, field, index) }));
    setSelectedId(field.id);
    setAnnounce(
      `${FIELD_TYPE_META[type].label} added at position ${index + 1} of ${draft.fields.length + 1}`,
    );
  };

  const move = (fid: string, to: number) => {
    if (!draft) return;
    const f = draft.fields.find((x) => x.id === fid);
    edit((d) => ({ ...d, fields: moveField(d.fields, fid, to) }));
    if (f) setAnnounce(`${f.label} moved to position ${to + 1} of ${draft.fields.length}`);
  };

  const remove = (fid: string) => {
    if (!draft) return;
    const before = draft;
    const f = before.fields.find((x) => x.id === fid);
    edit((d) => ({ ...d, fields: removeField(d.fields, fid) }));
    if (selectedId === fid) setSelectedId(null);
    setAnnounce(`${f?.label ?? 'Field'} deleted`);
    toast.info(`${f?.label ?? 'Field'} deleted.`, {
      label: 'Undo',
      onClick: () => {
        setDraft(before);
        setDirty(true);
      },
    });
  };

  const duplicate = (fid: string) => {
    if (!draft) return;
    const nid = newFieldId(draft.fields.map((f) => f.id));
    edit((d) => ({ ...d, fields: duplicateField(d.fields, fid, nid) }));
    setSelectedId(nid);
    setAnnounce('Field duplicated');
  };

  const reload = () => {
    setDirty(false);
    void formQ.refetch().then((r) => {
      if (r.data) {
        setDraft(structuredClone(r.data.definition));
        setBaseVersion(r.data.latestVersion);
      }
    });
  };

  const doSave = () => {
    if (!draft || !check?.ok) return;
    if (isNew) {
      create.mutate(draft, {
        onSuccess: (f) => {
          setDirty(false);
          toast.success('Form saved.');
          navigate(`/forms/${f.id}`, { replace: true });
        },
        onError: (e) => toast.error(errorMessage(e)),
      });
      return;
    }
    save.mutate(
      { baseVersion, definition: draft },
      {
        onSuccess: (r) => {
          setDirty(false);
          setBaseVersion(r.form.latestVersion);
          toast.success(r.created ? `Saved as version ${r.form.latestVersion}.` : 'Nothing changed.');
        },
        onError: (e) => {
          if (e instanceof ApiError && e.status === 409)
            toast.info(e.message, { label: 'Reload', onClick: reload });
          else toast.error(errorMessage(e));
        },
      },
    );
  };

  if (!isNew && (formQ.isPending || (viewVersion && versionQ.isPending)))
    return (
      <div className="mx-auto max-w-3xl">
        <Spinner />
      </div>
    );
  if (!isNew && (formQ.error || versionQ.error))
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorBox error={formQ.error ?? versionQ.error} />
      </div>
    );
  if (!draft) return null;
  if (isNew && me.data && !canEdit)
    return (
      <div className="mx-auto max-w-3xl">
        <Callout tone="info">Only Owners and Admins can design forms.</Callout>
      </div>
    );

  const selected: FormField | undefined = draft.fields.find((f) => f.id === selectedId);
  const latest = formQ.data?.latestVersion;
  const saving = create.isPending || save.isPending;
  const conns = connections.data ?? [];
  const settingsIssues = issues.filter((i) => !i.fieldId);

  return (
    <div className="mx-auto max-w-7xl" data-testid="form-builder">
      <PageHeader
        title={draft.settings.title || 'Untitled form'}
        back={{ to: '/forms', label: 'Forms' }}
        sub={
          isNew ? (
            'New form, not saved yet'
          ) : (
            <span data-testid="form-version">
              Version {viewVersion ?? latest}
              {dirty ? ' · unsaved changes' : ''}
              {publication.data?.status === 'published' ? ' · Published' : ''}
            </span>
          )
        }
        actions={
          <>
            {!isNew && formQ.data && formQ.data.versions.length > 0 && (
              <Menu label="Versions" trigger={<span className="px-3 text-sm font-medium">Versions</span>}>
                {formQ.data.versions.map((v) => (
                  <MenuItem
                    key={v.version}
                    onSelect={() =>
                      navigate(v.version === latest ? `/forms/${id}` : `/forms/${id}?version=${v.version}`)
                    }
                  >
                    Version {v.version} — {new Date(v.savedAt).toLocaleDateString()}
                    {v.savedByName ? `, ${v.savedByName}` : ''}
                  </MenuItem>
                ))}
              </Menu>
            )}
            {canEdit && !readOnly && (
              <Button
                variant="primary"
                onClick={doSave}
                loading={saving}
                disabled={!dirty || !check?.ok}
                data-testid="save-form"
              >
                Save
              </Button>
            )}
          </>
        }
      />
      {viewVersion && readOnly && latest && (
        <Callout tone="info" className="mb-4" data-testid="version-banner">
          You are looking at version {viewVersion}. The latest is version {latest}.{' '}
          <Link to={`/forms/${id}`} className="underline">
            Open the latest
          </Link>
        </Callout>
      )}
      {canEdit && <LargerScreenNote />}
      {!canEdit && (
        <Callout tone="info" className="mb-4">
          Only Owners and Admins can change forms. You can look at the preview.
        </Callout>
      )}
      <Tabs
        label="Form"
        prefix="builder"
        value={tab}
        onChange={(v) => setTab(v as 'build' | 'preview' | 'share')}
        tabs={[
          { id: 'build', label: 'Build', testId: 'tab-build' },
          { id: 'preview', label: 'Preview', testId: 'tab-preview' },
          ...(isNew ? [] : [{ id: 'share', label: 'Share', testId: 'tab-share' }]),
        ]}
        className="mb-4"
      />
      <div role="tabpanel" id={panelId('builder', tab)} aria-labelledby={tabId('builder', tab)}>
        {tab === 'build' ? (
          <div className="grid gap-4 xl:grid-cols-[14rem_minmax(0,1fr)_22rem]">
            <Panel>
              <FieldPalette onAdd={(t) => addAt(t)} disabled={readOnly} />
            </Panel>
            <Panel>
              <FormCanvas
                fields={draft.fields}
                selectedId={selectedId}
                editable={!readOnly}
                onSelect={setSelectedId}
                onMove={move}
                onAddAt={addAt}
                onDuplicate={duplicate}
                onDelete={remove}
                announcement={announce}
              />
            </Panel>
            <Panel>
              {selected ? (
                <FieldProperties
                  field={selected}
                  disabled={readOnly}
                  connections={conns}
                  issues={issues.filter((i) => i.fieldId === selected.id)}
                  onChange={(f) => edit((d) => ({ ...d, fields: updateField(d.fields, f) }))}
                />
              ) : (
                <FormSettingsPanel
                  settings={draft.settings}
                  disabled={readOnly}
                  connections={conns}
                  issues={settingsIssues}
                  onChange={(s) => edit((d) => ({ ...d, settings: s }))}
                />
              )}
              {selected && (
                <Button size="sm" variant="link" className="mt-4" onClick={() => setSelectedId(null)}>
                  Form settings
                </Button>
              )}
            </Panel>
          </div>
        ) : tab === 'share' && !isNew ? (
          <div className="mx-auto flex max-w-3xl flex-col gap-8" data-testid="share-tab">
            {dirty && (
              <Callout tone="info">You have unsaved changes. Save them before publishing.</Callout>
            )}
            {publication.isPending && <Spinner />}
            {publication.error && <ErrorBox error={publication.error} />}
            {publication.data && (
              <PublishPanel formId={id} publication={publication.data} canEdit={canEdit} />
            )}
            <ClientLinksPanel
              formId={id}
              canEdit={canEdit}
              published={publication.data?.status === 'published'}
            />
            <SubmissionsList formId={id} />
          </div>
        ) : (
          <div>
            <div className="mb-3 flex gap-2" role="group" aria-label="Preview width">
              <Button
                size="sm"
                variant={phoneWidth ? 'secondary' : 'primary'}
                aria-pressed={!phoneWidth}
                onClick={() => setPhoneWidth(false)}
              >
                Desktop
              </Button>
              <Button
                size="sm"
                variant={phoneWidth ? 'primary' : 'secondary'}
                aria-pressed={phoneWidth}
                onClick={() => setPhoneWidth(true)}
              >
                Phone
              </Button>
            </div>
            <div
              className="mx-auto"
              style={{ maxWidth: phoneWidth ? 390 : undefined }}
              data-testid="preview-frame"
            >
              <FormRenderer
                definition={draft}
                logoUrl={draft.settings.logo ? formLogoUrl(draft.settings.logo.imageId) : undefined}
                mode="preview"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import type { FormStatus } from '@aom/shared';
import { ClipboardList, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { errorMessage } from '../api/client.ts';
import { useMe } from '../api/queries/auth.ts';
import { useArchiveForm, useForms } from '../api/queries/forms.ts';
import { Button, EmptyState, ErrorBox, ListSkeleton, Menu, MenuItem, PageHeader, Tabs, useToast } from '../components/ui.tsx';
import { panelId, tabId } from '../components/ui/Tabs.tsx';
import { ageLabel } from '../lib/time.ts';

/** The forms of the organization. Owners and Admins create and archive them; every member can open one. */
export function Forms() {
  const me = useMe();
  const canEdit = me.data?.activeOrg?.role === 'owner' || me.data?.activeOrg?.role === 'admin';
  const [status, setStatus] = useState<FormStatus>('active');
  const forms = useForms(status);
  const archive = useArchiveForm();
  const toast = useToast();
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Forms"
        sub="Design the forms your clients fill in."
        actions={
          canEdit && (
            <Button variant="primary" onClick={() => navigate('/forms/new')} data-testid="new-form">
              <Plus aria-hidden="true" className="size-4" />
              New form
            </Button>
          )
        }
      />
      <Tabs
        label="Forms"
        prefix="forms"
        value={status}
        onChange={(v) => setStatus(v as FormStatus)}
        tabs={[
          { id: 'active', label: 'Active' },
          { id: 'archived', label: 'Archived' },
        ]}
        className="mb-4"
      />
      <div role="tabpanel" id={panelId('forms', status)} aria-labelledby={tabId('forms', status)}>
        {forms.isPending && <ListSkeleton rows={3} />}
        <ErrorBox error={forms.error} onRetry={() => void forms.refetch()} />
        {forms.data && forms.data.length === 0 && (
          <EmptyState
            icon={ClipboardList}
            tone="neutral"
            title={status === 'active' ? 'No forms yet' : 'No archived forms'}
            description={
              status === 'active'
                ? canEdit
                  ? 'Start a form, drag in the fields you need and preview it as a client will see it.'
                  : 'An Owner or Admin can design forms here.'
                : 'Forms you archive are listed here. They can be brought back at any time.'
            }
            action={
              status === 'active' && canEdit ? (
                <Button variant="primary" onClick={() => navigate('/forms/new')}>
                  New form
                </Button>
              ) : undefined
            }
          />
        )}
        {forms.data && forms.data.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label="Forms" data-testid="forms-list">
            {forms.data.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-2 rounded-card border border-line bg-surface p-3"
                data-testid={`form-row-${f.id}`}
              >
                <Link to={`/forms/${f.id}`} className="min-w-0 flex-1 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25">
                  <span className="block font-medium text-fg [overflow-wrap:anywhere]">{f.title}</span>
                  <span className="block text-sm text-muted">
                    {f.fieldCount} {f.fieldCount === 1 ? 'field' : 'fields'} · version {f.latestVersion} · updated{' '}
                    {ageLabel(f.updatedAt)}
                    {f.updatedByName ? ` by ${f.updatedByName}` : ''}
                  </span>
                </Link>
                {canEdit && (
                  <Menu label={`Actions for ${f.title}`}>
                    <MenuItem
                      onSelect={() =>
                        archive.mutate(
                          { id: f.id, archive: status === 'active' },
                          {
                            onSuccess: () => toast.success(status === 'active' ? 'Form archived.' : 'Form restored.'),
                            onError: (e) => toast.error(errorMessage(e)),
                          },
                        )
                      }
                    >
                      {status === 'active' ? 'Archive' : 'Unarchive'}
                    </MenuItem>
                  </Menu>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

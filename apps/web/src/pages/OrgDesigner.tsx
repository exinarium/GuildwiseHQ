import {
  type DefinitionIssue,
  describeDiff,
  diffDefinitions,
  type OrgCatalogueResponse,
  type RoleDraftInput,
} from '@aom/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAgents } from '../api/queries/agents.ts';
import { useMe } from '../api/queries/auth.ts';
import { useCreateChat } from '../api/queries/chats.ts';
import { useMcpServers } from '../api/queries/mcp.ts';
import {
  useCreateDepartment,
  useDiscardDraft,
  useExtendRole,
  useOrgCatalogue,
  useSaveRoleDraft,
  useSubmitDraft,
} from '../api/queries/org.ts';
import { useProjects } from '../api/queries/projects.ts';
import { RoleBuilder } from '../components/builder/RoleBuilder.tsx';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { WorkflowGraph } from '../components/org/WorkflowGraph.tsx';
import { LargerScreenNote } from '../components/ui/LargerScreenNote.tsx';
import { panelId, tabId } from '../components/ui/Tabs.tsx';
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Dialog,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  Select,
  Tabs,
  TextArea,
  TextInput,
} from '../components/ui.tsx';
import { blankRole, errorCount, roleToInput, splitList } from '../lib/designer.ts';
import { claimableWorkflows } from '../lib/role-builder.ts';

type Tab = 'roles' | 'workflows' | 'departments' | 'design';
const TABS: Array<[Tab, string]> = [
  ['roles', 'Roles'],
  ['workflows', 'Workflows'],
  ['departments', 'Departments'],
  ['design', 'Design with the BA'],
];

const STATUS_TONE = {
  active: 'green',
  pending_approval: 'amber',
  draft: 'blue',
  superseded: 'neutral',
  rejected: 'red',
} as const;
const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  pending_approval: 'Waiting for your approval',
  draft: 'Draft',
  superseded: 'Replaced by a newer version',
  rejected: 'Rejected',
};

/**
 * The organization page (docs/SPEC.md "Expanding the organization"): the role catalogue, custom workflows with a
 * stage editor and graph preview, departments, and the chat where the BA designs with you. Only the organization's
 * owner changes it; additional managers of a shared project read the owner's catalogue.
 */
export function OrgDesigner() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab | null) ?? 'roles';
  const projects = useProjects();
  const me = useMe();
  const shared = (projects.data ?? []).filter((p) => p.orgId !== me.data?.user.id);
  const ctxProject = params.get('project') ?? '';
  const cat = useOrgCatalogue(ctxProject || undefined);
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Organization"
        sub="Roles, workflows and departments. Definitions are versioned and approved on the desk before they are available."
      />
      {shared.length > 0 && (
        <div className="mb-3 max-w-sm">
          <Select
            label="Organization"
            value={ctxProject}
            onChange={(e) => setParam('project', e.target.value)}
          >
            <option value="">My organization</option>
            {shared.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key}: the owner's organization
              </option>
            ))}
          </Select>
        </div>
      )}
      <LargerScreenNote />
      {cat.data && !cat.data.canEdit && (
        <Callout tone="info" role="note" data-testid="read-only-note" className="mb-4">
          You are an additional manager here: this is the owner's catalogue. Their roles, workflows and
          standing orders apply to the shared project's cards, and only the owner can change them.
        </Callout>
      )}
      <Tabs
        label="Organization sections"
        prefix="org"
        value={tab}
        onChange={(id) => setParam('tab', id === 'roles' ? '' : id)}
        tabs={TABS.map(([id, label]) => ({ id, label }))}
      />
      {cat.isPending && <ListSkeleton label="Loading the organization" rows={3} />}
      {cat.isError && <ErrorBox error={cat.error} onRetry={() => cat.refetch()} />}
      <div role="tabpanel" id={panelId('org', tab)} aria-labelledby={tabId('org', tab)}>
        {cat.data && tab === 'roles' && <RolesTab cat={cat.data} projectId={ctxProject || undefined} />}
        {cat.data && tab === 'workflows' && (
          <WorkflowsTab cat={cat.data} projectId={ctxProject || undefined} />
        )}
        {cat.data && tab === 'departments' && (
          <DepartmentsTab cat={cat.data} projectId={ctxProject || undefined} />
        )}
        {cat.data && tab === 'design' && <DesignTab cat={cat.data} />}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------- shared bits

function VersionRow({
  version,
  status,
  deskItemId,
  vaultPath,
  draftedByAgent,
  extra,
  actions,
}: {
  version: number;
  status: string;
  deskItemId: string | null;
  vaultPath: string | null;
  draftedByAgent: boolean;
  extra?: string;
  actions?: React.ReactNode;
}) {
  return (
    <li
      className="flex flex-wrap items-center gap-2 text-sm"
      data-testid={`version-${version}`}
      data-status={status}
    >
      <span className="font-mono text-xs">v{version}</span>
      <Badge tone={STATUS_TONE[status as keyof typeof STATUS_TONE] ?? 'neutral'}>
        {STATUS_LABEL[status] ?? status}
      </Badge>
      {draftedByAgent && <Badge tone="violet">Drafted by the BA</Badge>}
      {extra && <span className="text-xs text-subtle">{extra}</span>}
      {status === 'pending_approval' && deskItemId && (
        <Link to="/desk" className="text-xs underline">
          Open the desk
        </Link>
      )}
      {vaultPath && (
        <span className="text-xs text-subtle" title="Stored in your vault">
          {vaultPath}
        </span>
      )}
      {/* the actions wrap inside the row: a draft has four buttons, more than half a card is wide */}
      <span className="ml-auto flex max-w-full flex-wrap justify-end gap-1" data-testid="version-actions">
        {actions}
      </span>
    </li>
  );
}

// -------------------------------------------------------------------------------------------- roles

type RoleEdit = { id?: string; input: RoleDraftInput; issues?: DefinitionIssue[]; keyLocked?: boolean };

function RolesTab({ cat, projectId }: { cat: OrgCatalogueResponse; projectId?: string }) {
  const [edit, setEdit] = useState<RoleEdit | null>(null);
  const [extending, setExtending] = useState<string | null>(null);
  const submit = useSubmitDraft();
  const discard = useDiscardDraft();
  const departments = cat.departments.map((d) => d.name);
  const builtIn = cat.roles.filter((r) => r.builtIn);
  const custom = cat.roles.filter((r) => !r.builtIn);
  const ext = cat.roles.find((r) => r.key === extending);

  return (
    <div className="flex flex-col gap-4">
      {cat.canEdit && !edit && (
        <div>
          <Button variant="primary" onClick={() => setEdit({ input: blankRole() })}>
            New custom role
          </Button>
        </div>
      )}
      {edit && (
        <RoleEditPanel
          edit={edit}
          setEdit={setEdit}
          departments={departments}
          cat={cat}
          projectId={projectId}
          onClose={() => setEdit(null)}
        />
      )}
      <ErrorBox error={submit.error ?? discard.error} />
      <section aria-label="Custom roles">
        <h2 className="mb-3 text-lg font-semibold text-fg">Custom roles</h2>
        {custom.length === 0 && <p className="text-sm text-subtle">No custom roles yet.</p>}
        <ul className="grid gap-3 md:grid-cols-2" data-testid="custom-roles">
          {custom.map((r) => {
            const latest = r.versions[0]?.definition;
            return (
              <li key={r.key} data-testid={`role-${r.key}`}>
                <Panel>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{latest?.name}</h3>
                    <span className="font-mono text-xs text-subtle">{r.key}</span>
                    {latest?.department && <Badge>{latest.department}</Badge>}
                  </div>
                  <p className="text-sm text-muted">{latest?.purpose}</p>
                  <ul className="mt-2 flex flex-col gap-1">
                    {r.versions.map((v) => (
                      <VersionRow
                        key={v.id}
                        {...v}
                        actions={
                          cat.canEdit && (
                            <>
                              {(v.status === 'draft' || v.status === 'active' || v.status === 'rejected') && (
                                <Button
                                  aria-label={`${v.status === 'draft' ? 'Edit' : 'New version of'} ${r.key} v${v.version}`}
                                  onClick={() =>
                                    setEdit({
                                      id: v.status === 'draft' ? v.id : undefined,
                                      input: roleToInput(v.definition),
                                      keyLocked: true,
                                    })
                                  }
                                >
                                  {v.status === 'draft' ? 'Edit' : 'New version'}
                                </Button>
                              )}
                              {v.status === 'draft' && (
                                <Button
                                  variant="primary"
                                  aria-label={`Submit ${r.key} v${v.version}`}
                                  disabled={submit.isPending}
                                  onClick={() => submit.mutate({ kind: 'roles', id: v.id, projectId })}
                                >
                                  Submit for approval
                                </Button>
                              )}
                              {(v.status === 'draft' || v.status === 'rejected') && (
                                <Button
                                  variant="ghost"
                                  aria-label={`Discard ${r.key} v${v.version}`}
                                  onClick={() => discard.mutate({ kind: 'roles', id: v.id, projectId })}
                                >
                                  Discard
                                </Button>
                              )}
                            </>
                          )
                        }
                      />
                    ))}
                  </ul>
                  {latest && (
                    <p className="mt-2 text-xs text-subtle">
                      May claim:{' '}
                      {latest.claimableStages.map((c) => `${c.workflowKey}.${c.stageId}`).join(', ')}
                    </p>
                  )}
                </Panel>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-label="Built-in roles">
        <h2 className="mb-3 text-lg font-semibold text-fg">Built-in roles</h2>
        <p className="mb-2 text-xs text-subtle">
          They ship with the app and can never be removed. The owner can extend them with extra instructions,
          skills and standing orders; their core rules (test ownership, review gates) cannot be changed.
        </p>
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="builtin-roles">
          {builtIn.map((r) => {
            const d = (r.versions.find((v) => v.status === 'active') ?? r.versions[0])?.definition;
            return (
              <li key={r.key} data-testid={`role-${r.key}`}>
                <Panel>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{d?.name}</h3>
                    <Badge tone="blue">Built in</Badge>
                    {d?.department && <Badge>{d.department}</Badge>}
                    <span className="text-xs text-subtle">v{d?.version}</span>
                  </div>
                  <p className="text-sm text-muted">{d?.purpose}</p>
                  {r.extensions && (
                    <p className="mt-1 text-xs" data-testid={`extended-${r.key}`}>
                      <Badge tone="violet">Extended</Badge>{' '}
                      {r.extensions.skills.length +
                        r.extensions.standingOrders.length +
                        (r.extensions.instructions ? 1 : 0)}{' '}
                      addition(s), written against v{r.extensions.baseVersion}
                    </p>
                  )}
                  {cat.canEdit && r.key !== 'devops' && (
                    <div className="mt-2">
                      <Button aria-label={`Extend ${r.key}`} onClick={() => setExtending(r.key)}>
                        Extend
                      </Button>
                    </div>
                  )}
                </Panel>
              </li>
            );
          })}
        </ul>
      </section>
      {ext && <ExtendDialog role={ext} projectId={projectId} onClose={() => setExtending(null)} />}
    </div>
  );
}

function RoleEditPanel({
  edit,
  setEdit,
  departments,
  cat,
  projectId,
  onClose,
}: {
  edit: RoleEdit;
  setEdit: (e: RoleEdit) => void;
  departments: string[];
  cat: OrgCatalogueResponse;
  projectId?: string;
  onClose: () => void;
}) {
  const save = useSaveRoleDraft();
  const submit = useSubmitDraft();
  const me = useMe();
  const mcpServers = useMcpServers();
  // Only the Owner of the organization switches on wide access; in a shared project's organization we are never it.
  const isOwner = !projectId && me.data?.activeOrg?.role === 'owner';
  const workflows = useMemo(() => claimableWorkflows(cat.workflows), [cat.workflows]);
  const knownSkills = useMemo(
    () => [...new Set(cat.roles.flatMap((r) => r.versions[0]?.definition.skills ?? []))].sort(),
    [cat.roles],
  );
  const run = async (andSubmit: boolean) => {
    try {
      const r = await save.mutateAsync({ id: edit.id, input: edit.input, projectId });
      setEdit({ ...edit, id: r.id, issues: r.issues });
      if (andSubmit && errorCount(r.issues) === 0) {
        await submit.mutateAsync({ kind: 'roles', id: r.id, projectId });
        onClose();
      }
    } catch {
      /* shown below */
    }
  };
  return (
    <Panel>
      <h2 className="mb-3 text-lg font-semibold text-fg">
        {edit.id ? 'Edit role draft' : 'New custom role'}
      </h2>
      <RoleBuilder
        value={edit.input}
        onChange={(input) => setEdit({ ...edit, input, issues: undefined })}
        departments={departments}
        workflows={workflows}
        knownSkills={knownSkills}
        knownMcpServers={mcpServers.data ?? []}
        isOwner={isOwner}
        keyLocked={edit.keyLocked || !!edit.id}
        serverIssues={edit.issues}
        projectId={projectId}
      />
      <ErrorBox error={save.error ?? submit.error} />
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button disabled={save.isPending} onClick={() => run(false)}>
          Save draft
        </Button>
        <Button variant="primary" disabled={save.isPending || submit.isPending} onClick={() => run(true)}>
          Save and submit for approval
        </Button>
      </div>
    </Panel>
  );
}

function ExtendDialog({
  role,
  projectId,
  onClose,
}: {
  role: OrgCatalogueResponse['roles'][number];
  projectId?: string;
  onClose: () => void;
}) {
  const extend = useExtendRole();
  const def = (role.versions.find((v) => v.status === 'active') ?? role.versions[0])?.definition;
  const [instructions, setInstructions] = useState(role.extensions?.instructions ?? '');
  const [skills, setSkills] = useState((role.extensions?.skills ?? []).join(', '));
  const [orders, setOrders] = useState((role.extensions?.standingOrders ?? []).join('\n'));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    extend.mutate(
      {
        roleKey: role.key,
        projectId,
        body: {
          instructions,
          skills: splitList(skills),
          standingOrders: orders
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
        },
      },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Extend ${def?.name ?? role.key}`}
      description="Your additions are added to the role's instructions for every agent in this role, in every project of your organization."
    >
      <form onSubmit={submit} className="flex flex-col gap-3" aria-label={`Extend ${role.key}`}>
        <div className="rounded-control bg-sunken p-2 text-xs" data-testid="core-rules">
          <p className="font-medium">Core rules (cannot be changed)</p>
          <ul className="list-disc pl-4">
            {(def?.coreRules ?? []).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
        <TextArea
          label="Extra instructions"
          rows={4}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <TextInput
          label="Extra skills (comma separated)"
          value={skills}
          onChange={(e) => setSkills(e.target.value)}
        />
        <TextArea
          label="Standing orders (one per line)"
          rows={3}
          value={orders}
          onChange={(e) => setOrders(e.target.value)}
        />
        <ErrorBox error={extend.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={extend.isPending}>
            Save extensions
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------- workflows

function WorkflowsTab({ cat, projectId }: { cat: OrgCatalogueResponse; projectId?: string }) {
  const submit = useSubmitDraft();
  const discard = useDiscardDraft();
  const [viewing, setViewing] = useState<string | null>(null);
  const [comparing, setComparing] = useState<string | null>(null);
  const proj = projectId ? `?project=${projectId}` : '';
  const projAnd = projectId ? `&project=${projectId}` : '';
  return (
    <div className="flex flex-col gap-4">
      {cat.canEdit && (
        <div>
          <ButtonLink variant="primary" to={`/org/workflows/new${proj}`}>
            New custom workflow
          </ButtonLink>
        </div>
      )}
      <ErrorBox error={submit.error ?? discard.error} />
      <ul className="grid gap-3 lg:grid-cols-2" data-testid="workflows">
        {cat.workflows.map((w) => {
          const latest = (w.versions.find((v) => v.status === 'active') ?? w.versions[0])?.definition;
          return (
            <li key={w.key} data-testid={`workflow-${w.key}`}>
              <Panel>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{latest?.name}</h3>
                  <span className="font-mono text-xs text-subtle">{w.key}</span>
                  {w.builtIn ? <Badge tone="blue">Built in</Badge> : <Badge tone="violet">Custom</Badge>}
                  {latest?.department && <Badge>{latest.department}</Badge>}
                </div>
                <ul className="mt-2 flex flex-col gap-1">
                  {w.versions.map((v, i) => {
                    const prev = w.versions[i + 1];
                    return (
                      <div key={v.id} className="contents">
                        <VersionRow
                          {...v}
                          extra={
                            v.cardsInFlight > 0
                              ? `${v.cardsInFlight} card(s) in flight on this version`
                              : undefined
                          }
                          actions={
                            <>
                              <Button
                                aria-label={`View ${w.key} v${v.version}`}
                                onClick={() => setViewing(viewing === v.id ? null : v.id)}
                              >
                                {viewing === v.id ? 'Hide' : 'View'}
                              </Button>
                              {prev && (
                                <Button
                                  aria-label={`Compare ${w.key} v${v.version} with previous`}
                                  aria-expanded={comparing === v.id}
                                  onClick={() => setComparing(comparing === v.id ? null : v.id)}
                                >
                                  Compare with previous
                                </Button>
                              )}
                              {cat.canEdit && !w.builtIn && (
                                <>
                                  {(v.status === 'draft' ||
                                    v.status === 'active' ||
                                    v.status === 'rejected') && (
                                    <ButtonLink
                                      aria-label={`${v.status === 'draft' ? 'Edit' : 'New version of'} ${w.key} v${v.version}`}
                                      to={
                                        v.status === 'draft'
                                          ? `/org/workflows/${v.id}${proj}`
                                          : `/org/workflows/new?from=${v.id}${projAnd}`
                                      }
                                    >
                                      {v.status === 'draft' ? 'Edit' : 'New version'}
                                    </ButtonLink>
                                  )}
                                  {v.status === 'draft' && (
                                    <Button
                                      variant="primary"
                                      aria-label={`Submit ${w.key} v${v.version}`}
                                      disabled={submit.isPending}
                                      onClick={() =>
                                        submit.mutate({ kind: 'workflows', id: v.id, projectId })
                                      }
                                    >
                                      Submit for approval
                                    </Button>
                                  )}
                                  {(v.status === 'draft' || v.status === 'rejected') && (
                                    <Button
                                      variant="ghost"
                                      aria-label={`Discard ${w.key} v${v.version}`}
                                      onClick={() =>
                                        discard.mutate({ kind: 'workflows', id: v.id, projectId })
                                      }
                                    >
                                      Discard
                                    </Button>
                                  )}
                                </>
                              )}
                            </>
                          }
                        />
                        {prev && comparing === v.id && (
                          <li className="pl-4" data-testid={`compare-${w.key}-v${v.version}`}>
                            {(() => {
                              const lines = describeDiff(diffDefinitions(prev.definition, v.definition));
                              return lines.length === 0 ? (
                                <p className="text-xs text-subtle">No difference from v{prev.version}.</p>
                              ) : (
                                <ul className="list-disc pl-5 text-xs text-muted">
                                  {lines.map((l) => (
                                    <li key={l}>{l}</li>
                                  ))}
                                </ul>
                              );
                            })()}
                          </li>
                        )}
                      </div>
                    );
                  })}
                </ul>
                {w.versions
                  .filter((v) => v.id === viewing)
                  .map((v) => (
                    <div key={v.id} className="mt-2" data-testid={`view-${w.key}-v${v.version}`}>
                      <WorkflowGraph def={v.definition} />
                      <ol className="mt-2 list-decimal pl-5 text-xs text-muted">
                        {v.definition.stages.map((s) => (
                          <li key={s.id}>
                            <span className="font-medium">{s.label}</span>
                            {s.kind === 'agent'
                              ? ` (${s.claimRole}${s.seniorOnly ? ', senior' : ''})`
                              : ` (${s.kind})`}
                            {s.requiredFields.length > 0 && `, needs ${s.requiredFields.join(', ')}`}
                            {s.doneCriteria && `: ${s.doneCriteria}`}
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
              </Panel>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------------------------- departments

function DepartmentsTab({ cat, projectId }: { cat: OrgCatalogueResponse; projectId?: string }) {
  const create = useCreateDepartment();
  const [name, setName] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate({ body: { name: name.trim() }, projectId }, { onSuccess: () => setName('') });
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        A department groups the roles and workflows of one function, so the HR board and the boards can be
        filtered by it.
      </p>
      {cat.canEdit && (
        <form onSubmit={submit} aria-label="New department" className="flex max-w-md items-end gap-2">
          <div className="flex-1">
            <TextInput label="New department" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Create department
          </Button>
        </form>
      )}
      <ErrorBox error={create.error} />
      <ul className="grid gap-3 md:grid-cols-2" data-testid="departments">
        {cat.departments.map((d) => (
          <li key={d.name} data-testid={`department-${d.name}`}>
            <Panel>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{d.name}</h3>
                {d.builtIn && <Badge tone="blue">Built in</Badge>}
              </div>
              <p className="mt-1 text-xs text-subtle">Roles: {d.roleKeys.join(', ') || 'none'}</p>
              <p className="text-xs text-subtle">Workflows: {d.workflowKeys.join(', ') || 'none'}</p>
            </Panel>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------- BA design

function DesignTab({ cat }: { cat: OrgCatalogueResponse }) {
  const agents = useAgents();
  const create = useCreateChat();
  const [threadId, setThreadId] = useState<string | null>(null);
  const bas = (agents.data ?? []).filter(
    (a) => a.roleKey === 'ba' && a.status === 'active' && a.allowedProjectIds === null,
  );
  const [agentId, setAgentId] = useState('');
  const chosen = agentId || bas[0]?.id || '';
  if (!cat.canEdit)
    return <p className="text-sm text-subtle">Only the organization owner designs with the BA.</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Describe the role or workflow you need. The BA drafts it, asks what is unclear, validates it and puts
        it on your desk; it is available only after you approve it.
      </p>
      {bas.length === 0 ? (
        <p className="text-sm text-subtle" data-testid="no-ba">
          Hire a business analyst on the{' '}
          <Link to="/agents?hire=ba" className="underline">
            HR board
          </Link>{' '}
          first.
        </p>
      ) : !threadId ? (
        <div className="flex max-w-md items-end gap-2">
          <div className="flex-1">
            <Select label="Business analyst" value={chosen} onChange={(e) => setAgentId(e.target.value)}>
              {bas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="primary"
            disabled={create.isPending || !chosen}
            onClick={() => create.mutate({ agentId: chosen }, { onSuccess: (c) => setThreadId(c.threadId) })}
          >
            Start a design chat
          </Button>
        </div>
      ) : (
        <div className="flex h-[60dvh] flex-col" data-testid="design-chat">
          <ChatPanel threadId={threadId} />
        </div>
      )}
      <ErrorBox error={create.error} />
    </div>
  );
}

import { useState } from 'react';
import { useMe } from '../../api/queries/auth.ts';
import { useHireFromPack, usePackPersonas } from '../../api/queries/my-capabilities.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import { type Access, ProjectAccessEditor } from '../agents/ProjectAccess.tsx';
import { ModelSelect, unionExtras, unionProviders } from '../ModelSelect.tsx';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  ErrorBox,
  ListSkeleton,
  Select,
  TextInput,
  useToast,
} from '../ui.tsx';

const toolsText = (tools: readonly string[]): string => (tools.length ? tools.join(', ') : 'read');

/**
 * Hire from a pack: a persona becomes a role (its text the instructions, its declared tool profile the permissions, read only
 * when it declares none, never wider than you may grant) and an agent with a tag that says where it came from. "Add all agents"
 * picks every persona; the review list below shows what each hire would get before anything is confirmed.
 */
export function HirePackDialog({
  packId,
  packName,
  onClose,
}: {
  packId: string;
  packName: string;
  onClose: () => void;
}) {
  const q = usePackPersonas(packId);
  const stations = useWorkstations();
  const me = useMe();
  const hire = useHireFromPack();
  const projects = useProjects();
  const isManager = me.data?.activeOrg?.role === 'owner' || me.data?.activeOrg?.role === 'admin';
  // A member hires within their existing permissions: for projects they are on (the normal hire rule). Owners and Admins as before.
  const [access, setAccess] = useState<Access | null>(null);
  const defaultProject =
    projects.data?.find((p) => p.orgId === me.data?.activeOrg?.id)?.id ?? projects.data?.[0]?.id;
  const effectiveAccess: Access = access ?? { allowed: defaultProject ? [defaultProject] : [], focus: [] };
  const toast = useToast();
  const mine = (stations.data ?? []).filter((w) => w.userId === me.data?.user.id && w.status === 'active');
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [workstationId, setWorkstationId] = useState('');
  const [model, setModel] = useState('');
  const station = mine.find((w) => w.id === (workstationId || mine[0]?.id));
  const personas = q.data?.personas ?? [];
  const chosen = personas.filter((p) => p.key in picked);
  const toggle = (key: string, name: string) =>
    setPicked((cur) => {
      const { [key]: gone, ...rest } = cur;
      return gone !== undefined ? rest : { ...cur, [key]: name };
    });
  const submit = () => {
    if (!station) return;
    const [runtime, ...m] = model.split('/');
    hire.mutate(
      {
        packId,
        body: {
          items: chosen.map((p) => ({ key: p.key, name: (picked[p.key] ?? p.name).trim() })),
          workstationId: station.id,
          ...(model && runtime && m.length ? { runtime, model: m.join('/') } : {}),
          capacity: 1,
          ...(isManager ? {} : { allowedProjectIds: effectiveAccess.allowed ?? [] }),
        },
      },
      {
        onSuccess: (r) => {
          toast.success(
            `${r.agents.length} agent${r.agents.length === 1 ? '' : 's'} hired from ${packName}.`,
          );
          onClose();
        },
      },
    );
  };
  const accessOk = isManager || (effectiveAccess.allowed?.length ?? 0) > 0;
  const ready =
    chosen.length > 0 && chosen.every((p) => (picked[p.key] ?? '').trim()) && !!station && accessOk;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Hire from ${packName}`}
      description="Pick the personas to turn into agents. You review what each would get before you confirm."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={hire.isPending}
            onClick={submit}
            data-testid="confirm-hire"
          >
            {chosen.length > 1 ? `Hire ${chosen.length} agents` : 'Hire'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="hire-pack-dialog">
        {q.isPending && <ListSkeleton label="Loading the personas" rows={2} />}
        {q.isError && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
        {q.data && !q.data.trusted && (
          <Callout tone="warning">This pack is not approved yet. Approve it before hiring from it.</Callout>
        )}
        {q.data?.trusted && !q.data.readableNow && (
          <Callout tone="warning" data-testid="hire-offline">
            No workstation that holds this pack is online. The persona text is read from it, so start your
            runner first.
          </Callout>
        )}
        {q.data?.trusted && personas.length === 0 && (
          <p className="text-sm text-muted">This pack has no personas.</p>
        )}
        {personas.length > 0 && (
          <div>
            <Button
              size="sm"
              onClick={() => setPicked(Object.fromEntries(personas.map((p) => [p.key, p.name])))}
              data-testid="add-all"
            >
              Add all agents from this pack
            </Button>
          </div>
        )}
        <ul className="flex flex-col gap-2">
          {personas.map((p) => (
            <li key={p.key} className="rounded-card border border-line p-3" data-testid={`persona-${p.key}`}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={p.key in picked}
                  onChange={() => toggle(p.key, p.name)}
                  aria-label={`Hire ${p.name}`}
                />
                {p.icon && <span aria-hidden="true">{p.icon}</span>}
                <span className="font-medium">{p.name}</span>
                <Badge tone="violet">{p.provenanceLabel}</Badge>
                {p.hiredAgentIds.length > 0 && <Badge>{p.hiredAgentIds.length} hired</Badge>}
              </label>
              <p className="mt-1 text-sm text-muted">{p.description}</p>
              {p.key in picked && (
                <div className="mt-2 flex flex-col gap-2">
                  <TextInput
                    label={`Agent name for ${p.name}`}
                    value={picked[p.key] ?? ''}
                    onChange={(e) => setPicked({ ...picked, [p.key]: e.target.value })}
                  />
                  <p className="text-xs text-muted" data-testid={`permissions-${p.key}`}>
                    Tools it would get: <strong>{toolsText(p.permissions.allowedTools)}</strong>. It cannot
                    commit, use a browser or read every repository.
                    {p.withheld.length > 0 && (
                      <> Withheld, because you may not grant it: {p.withheld.join(', ')}.</>
                    )}
                    {p.role &&
                      !p.role.upToDate &&
                      ' The role made from an older version of this persona is kept until you accept the update.'}
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
        {chosen.length > 0 && (
          <div className="flex flex-col gap-3 border-t border-line pt-3">
            <Select
              label="Workstation"
              value={station?.id ?? ''}
              onChange={(e) => setWorkstationId(e.target.value)}
              hint="One of yours. The agent runs there."
            >
              {mine.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.connected ? '' : ' (offline)'}
                </option>
              ))}
            </Select>
            <ModelSelect
              label="Model"
              value={model}
              onChange={setModel}
              runtimes={(station?.runtimes ?? []).filter((r) => r.available).map((r) => r.id)}
              providers={unionProviders(station ? [station] : [])}
              extras={unionExtras(station ? [station] : [])}
              defaultLabel="The role's default"
            />
            {!isManager && (
              <div data-testid="hire-access">
                <ProjectAccessEditor
                  value={effectiveAccess}
                  onChange={setAccess}
                  projects={projects.data ?? []}
                  canAny={false}
                  idPrefix="packhire"
                />
                {!accessOk && (
                  <p role="alert" className="mt-1 text-sm font-medium text-danger">
                    Pick at least one project you are on.
                  </p>
                )}
              </div>
            )}
            <div data-testid="hire-review">
              <p className="text-sm font-medium">Review</p>
              <ul className="list-disc pl-5 text-sm text-muted">
                {chosen.map((p) => (
                  <li key={p.key}>
                    {(picked[p.key] ?? p.name).trim() || p.name}: role <code>{p.roleKey}</code>
                    {p.role ? ` (version ${p.role.version} exists)` : ' (new)'}, tools{' '}
                    {toolsText(p.permissions.allowedTools)}, tagged {p.provenanceLabel}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <ErrorBox error={hire.error} />
      </div>
    </Dialog>
  );
}

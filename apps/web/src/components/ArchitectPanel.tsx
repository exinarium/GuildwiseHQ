import { isValidReportPath, type ProjectDetailResponse } from '@aom/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAgents } from '../api/queries/agents.ts';
import { useSetArchitectSettings } from '../api/queries/projects.ts';
import { useOrgTerms } from '../lib/terms.ts';
import { Badge, Button, Callout, ErrorBox, Panel, Select, TextInput, useToast } from './ui.tsx';

type Project = ProjectDetailResponse['project'];

/**
 * The architect settings of a project: whether new cards investigate and design before they are built (off unless the
 * project opts in; each card can still say otherwise), whether the latest main branch is merged first, and where the
 * architect's reports go (a folder in the repository, or the project's knowledge vault).
 */
export function ArchitectPanel({
  projectId,
  project,
  canChange,
}: {
  projectId: string;
  project: Project;
  canChange: boolean;
}) {
  const t = useOrgTerms();
  const set = useSetArchitectSettings(projectId);
  const toast = useToast();
  const agents = useAgents();
  const [designStep, setDesignStep] = useState(project.designStep ?? false);
  const [mergeMainFirst, setMergeMainFirst] = useState(project.mergeMainFirst ?? true);
  const [location, setLocation] = useState<'repo' | 'vault'>(project.investigationLocation ?? 'repo');
  const [path, setPath] = useState(project.investigationPath ?? 'docs/investigations');
  useEffect(() => {
    setDesignStep(project.designStep ?? false);
    setMergeMainFirst(project.mergeMainFirst ?? true);
    setLocation(project.investigationLocation ?? 'repo');
    setPath(project.investigationPath ?? 'docs/investigations');
  }, [project.designStep, project.mergeMainFirst, project.investigationLocation, project.investigationPath]);

  const pathError =
    isValidReportPath(path.trim()) && !path.trim().startsWith('vault:')
      ? undefined
      : 'Use a relative folder such as docs/investigations (no .. and no leading /)';
  const dirty =
    designStep !== (project.designStep ?? false) ||
    mergeMainFirst !== (project.mergeMainFirst ?? true) ||
    location !== (project.investigationLocation ?? 'repo') ||
    path.trim() !== (project.investigationPath ?? 'docs/investigations');
  const noVault = project.hasVault === false;
  const hasArchitect = (agents.data ?? []).some((a) => a.roleKey === 'architect' && a.status === 'active');

  return (
    <Panel>
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold text-fg">
        Architect
        <Badge tone={project.designStep ? 'brand' : 'neutral'}>
          <span data-testid="architect-state">
            {project.designStep ? 'Investigate & design is on' : 'Investigate & design is off'}
          </span>
        </Badge>
      </h2>
      <p className="mb-3 text-sm text-muted">
        An architect investigates a card and writes a design before the builder starts. It is off unless you
        turn it on here; every card can still switch it on or off, and a card can be an investigation only.
      </p>
      <div className="flex flex-col gap-3">
        <label className="flex items-start gap-2 text-sm text-fg">
          <input
            type="checkbox"
            className="mt-1"
            checked={designStep}
            disabled={!canChange}
            data-testid="design-step-toggle"
            onChange={(e) => setDesignStep(e.target.checked)}
          />
          <span>Investigate &amp; design before build on new cards</span>
        </label>
        {designStep && !hasArchitect && !agents.isPending && (
          <Callout tone="warning" role="status" data-testid="no-architect">
            No architect is hired. Cards would wait in the design stage.{' '}
            <Link className="font-medium underline" to="/agents">
              Hire a senior Architect
            </Link>{' '}
            first, or leave this off.
          </Callout>
        )}
        <label className="flex items-start gap-2 text-sm text-fg">
          <input
            type="checkbox"
            className="mt-1"
            checked={mergeMainFirst}
            disabled={!canChange}
            data-testid="merge-main-toggle"
            onChange={(e) => setMergeMainFirst(e.target.checked)}
          />
          <span>
            Merge the latest main branch first
            <span className="block text-xs text-subtle">
              Before work on a card starts, the runner merges the main branch into the working branch (the
              card branch takes the merge when the working branch is protected or the merge conflicts). Only
              when the repository has a separate main and working branch.
            </span>
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
          <Select
            label="Reports go to"
            value={location}
            disabled={!canChange}
            data-testid="investigation-location"
            onChange={(e) => setLocation(e.target.value as 'repo' | 'vault')}
          >
            <option value="repo">The repository (merged with the card)</option>
            <option value="vault" disabled={noVault}>
              {t.reword(`The knowledge vault${noVault ? ' (this project has no vault)' : ''}`)}
            </option>
          </Select>
          <TextInput
            label={location === 'repo' ? 'Folder in the repository' : t.reword('Folder in the project vault')}
            value={path}
            disabled={!canChange}
            error={pathError}
            data-testid="investigation-path"
            onChange={(e) => setPath(e.target.value)}
            hint={
              noVault
                ? t.reword(
                    'This project has no knowledge vault, so reports go in the repository until a vault is registered. A report is named <card ref>-<title>.md.',
                  )
                : 'A report is named <card ref>-<title>.md. A card can name its own report path.'
            }
          />
        </div>
      </div>
      {canChange ? (
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="primary"
            data-testid="architect-save"
            disabled={!dirty || !!pathError || set.isPending}
            loading={set.isPending}
            onClick={() =>
              set.mutate(
                {
                  designStep,
                  mergeMainFirst,
                  investigationPath: path.trim(),
                  investigationLocation: location,
                },
                { onSuccess: () => toast.success('Architect settings saved') },
              )
            }
          >
            Save
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-sm text-subtle" data-testid="architect-readonly">
          Only the project Owner and the organization's Owners and Admins can change these settings.
        </p>
      )}
      <ErrorBox error={set.error} />
    </Panel>
  );
}

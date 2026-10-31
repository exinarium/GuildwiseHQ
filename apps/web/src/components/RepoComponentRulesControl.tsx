import {
  type ComponentRule,
  type ComponentRuleProblem,
  componentRuleProblems,
  type ProjectRepoDto,
} from '@aom/shared';
import { useEffect, useRef, useState } from 'react';
import { useSetRepoComponentRules } from '../api/queries/forges.ts';
import { Button, ErrorBox, TextArea, TextInput } from './ui.tsx';

interface Draft {
  name: string;
  /** One glob per line. */
  paths: string;
  versionFile: string;
  pattern: string;
}

const toDraft = (r: ComponentRule): Draft => ({
  name: r.name,
  paths: r.paths.join('\n'),
  versionFile: r.versionFile,
  pattern: r.pattern,
});
const toRule = (d: Draft): ComponentRule => ({
  name: d.name,
  paths: d.paths.split('\n'),
  versionFile: d.versionFile,
  pattern: d.pattern,
});

const NO_AUTO = {
  autoCapitalize: 'off',
  autoCorrect: 'off',
  spellCheck: false,
  inputMode: 'text',
} as const;

/**
 * The component version rules of one repository (expert mode): which files make a component's version file bump on a
 * release. The owner edits the whole list and saves it at once; mistakes are shown next to the fields before anything
 * is sent.
 */
export function RepoComponentRulesControl({
  projectId,
  repo,
  isOwner,
}: {
  projectId: string;
  repo: ProjectRepoDto;
  isOwner: boolean;
}) {
  const set = useSetRepoComponentRules(projectId);
  const rules = repo.componentRules ?? [];
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [problems, setProblems] = useState<ComponentRuleProblem[]>([]);
  const focusLast = useRef(false);
  const nameRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (focusLast.current) {
      focusLast.current = false;
      nameRefs.current[drafts.length - 1]?.focus();
    }
  }, [drafts.length]);

  const open = () => {
    setDrafts(rules.map(toDraft));
    setProblems([]);
    setEditing(true);
  };
  const change = (i: number, patch: Partial<Draft>) =>
    setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const add = () => {
    focusLast.current = true;
    setDrafts((d) => [...d, { name: '', paths: '', versionFile: '', pattern: '' }]);
  };
  const save = () => {
    const list = drafts.map(toRule);
    const found = componentRuleProblems(list);
    setProblems(found);
    if (found.length > 0) return;
    set.mutate({ repoId: repo.id, rules: list }, { onSuccess: () => setEditing(false) });
  };
  const err = (i: number, field: ComponentRuleProblem['field']) =>
    problems.find((p) => p.index === i && p.field === field)?.message;

  return (
    <div className="mt-2 flex flex-col gap-2" data-testid={`repo-rules-${repo.name}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg">Component version rules</span>
        {rules.length === 0 && <span className="text-subtle">none</span>}
        {isOwner && !editing && (
          <Button
            variant="ghost"
            className="min-h-11"
            aria-label={`Edit component version rules of ${repo.name}`}
            onClick={open}
          >
            Edit
          </Button>
        )}
      </div>
      {!editing &&
        rules.map((r) => (
          <p key={r.name} className="break-all font-mono text-xs text-subtle">
            {r.name}: {r.paths.join(', ')} → {r.versionFile}
          </p>
        ))}
      <p className="text-xs text-subtle">
        A release bumps the version file of a rule when a file matching one of its paths changed since the
        last release. Without rules a release only gets the release version.
      </p>
      {editing && (
        <form
          aria-label={`Component version rules of ${repo.name}`}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="flex flex-col gap-3"
        >
          {drafts.map((d, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the draft list has no stable id; rules are edited in place
            <fieldset key={i} className="flex flex-col gap-2 rounded-control border border-border p-3">
              <legend className="px-1 text-sm font-medium text-fg">Rule {i + 1}</legend>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="w-full sm:w-48">
                  <TextInput
                    ref={(el) => {
                      nameRefs.current[i] = el;
                    }}
                    label="Name"
                    value={d.name}
                    error={err(i, 'name')}
                    onChange={(e) => change(i, { name: e.target.value })}
                  />
                </div>
                <div className="w-full sm:flex-1">
                  <TextInput
                    label="Version file"
                    hint="Path in the repository, like apps/runner/src/version.ts"
                    value={d.versionFile}
                    error={err(i, 'versionFile')}
                    onChange={(e) => change(i, { versionFile: e.target.value })}
                    {...NO_AUTO}
                  />
                </div>
              </div>
              <TextArea
                label="Path globs"
                hint="One per line (* ? and **), like apps/runner/**"
                value={d.paths}
                error={err(i, 'paths')}
                onChange={(e) => change(i, { paths: e.target.value })}
                {...NO_AUTO}
              />
              <TextInput
                label="Pattern"
                hint="The version inside one ( ), like RUNNER_VERSION = '(.*)'"
                value={d.pattern}
                error={err(i, 'pattern')}
                onChange={(e) => change(i, { pattern: e.target.value })}
                {...NO_AUTO}
              />
              <div>
                <Button
                  className="min-h-11"
                  aria-label={`Remove rule ${d.name.trim() || i + 1}`}
                  onClick={() => setDrafts((x) => x.filter((_, j) => j !== i))}
                >
                  Remove rule
                </Button>
              </div>
            </fieldset>
          ))}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="min-h-11" onClick={add}>
              Add rule
            </Button>
            <Button type="submit" variant="primary" className="min-h-11" disabled={set.isPending}>
              Save rules
            </Button>
            <Button className="min-h-11" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <ErrorBox error={set.error} />
    </div>
  );
}

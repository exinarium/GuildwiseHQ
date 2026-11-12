import {
  duplicateRiskPatterns,
  type FeatureStatus,
  normaliseRiskPattern,
  type ProjectDetailResponse,
  RISK_CLASSES,
  type RiskClass,
  reviewSettingsStatus,
  riskPatternProblem,
  SIZE_BUDGET_MAX,
  SIZE_UNIT_LABELS,
  SIZE_UNITS,
  type SizeUnit,
} from '@aom/shared';
import { useEffect, useRef, useState } from 'react';
import { useSetReviewSettings } from '../api/queries/projects.ts';
import { Badge, Button, Callout, ErrorBox, Panel, Select, TextInput } from './ui.tsx';

interface Row {
  key: number;
  pattern: string;
  risk: RiskClass | '';
}

const RISK_LABELS: Record<RiskClass, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const BUDGET_ERROR = 'A whole number of 1 or more';

function budgetProblem(text: string): string | null {
  const t = text.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return BUDGET_ERROR;
  const n = Number(t);
  if (n < 1) return BUDGET_ERROR;
  if (n > SIZE_BUDGET_MAX) return `At most ${SIZE_BUDGET_MAX.toLocaleString('en')}`;
  return null;
}

function rowProblems(rows: readonly Row[]): Record<number, { pattern?: string; risk?: string }> {
  const out: Record<number, { pattern?: string; risk?: string }> = {};
  const dupes = new Set(duplicateRiskPatterns(rows));
  rows.forEach((r, i) => {
    const e: { pattern?: string; risk?: string } = {};
    const p = riskPatternProblem(r.pattern);
    if (p) e.pattern = p.charAt(0).toUpperCase() + p.slice(1);
    else if (dupes.has(i)) e.pattern = 'This path is already in the list';
    if (r.risk === '') e.risk = 'Choose a class';
    if (e.pattern || e.risk) out[r.key] = e;
  });
  return out;
}

function StatusLine({ label, status, testId }: { label: string; status: FeatureStatus; testId: string }) {
  return (
    <li data-testid={testId}>
      {label}: {status.active ? 'active' : status.reasons.join('; ')}
    </li>
  );
}

/**
 * The project's review settings: the size budget, the unit it is measured in and the path-to-risk map. Nothing is set
 * by default, and the checks that need a value say which one is missing. Only the project owner can change them.
 */
export function ReviewSettingsPanel({
  projectId,
  project,
  canChange,
}: {
  projectId: string;
  project: ProjectDetailResponse['project'];
  canChange: boolean;
}) {
  const saved = project.reviewSettings ?? { sizeBudget: null, sizeUnit: null, riskMap: null };
  const status = project.reviewSettings?.status ?? reviewSettingsStatus(null);
  const set = useSetReviewSettings(projectId);
  const nextKey = useRef(0);
  const [budget, setBudget] = useState(saved.sizeBudget == null ? '' : String(saved.sizeBudget));
  const [unit, setUnit] = useState<SizeUnit | ''>(saved.sizeUnit ?? '');
  const [rows, setRows] = useState<Row[]>(() =>
    (saved.riskMap ?? []).map((e) => ({ key: nextKey.current++, pattern: e.pattern, risk: e.risk })),
  );
  const [tried, setTried] = useState(false);
  const [focusKey, setFocusKey] = useState<number | null>(null);
  const inputs = useRef(new Map<number, HTMLInputElement>());

  useEffect(() => {
    if (focusKey == null) return;
    const el = inputs.current.get(focusKey);
    if (el) {
      el.focus();
      el.scrollIntoView?.({ block: 'center' });
    }
    setFocusKey(null);
  }, [focusKey]);

  const budgetErr = tried ? budgetProblem(budget) : null;
  const problems = tried ? rowProblems(rows) : {};

  const addRow = () => {
    const key = nextKey.current++;
    setRows((rs) => [...rs, { key, pattern: '', risk: '' }]);
    setFocusKey(key);
  };
  const updateRow = (key: number, change: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const removeRow = (key: number) => setRows((rs) => rs.filter((r) => r.key !== key));

  const save = () => {
    setTried(true);
    if (budgetProblem(budget) || Object.keys(rowProblems(rows)).length > 0) return;
    const b = budget.trim();
    set.mutate({
      sizeBudget: b === '' ? null : Number(b),
      sizeUnit: unit === '' ? null : unit,
      riskMap:
        rows.length === 0
          ? null
          : rows.map((r) => ({ pattern: normaliseRiskPattern(r.pattern), risk: r.risk as RiskClass })),
    });
  };

  const allActive = status.size.active && status.risk.active;
  return (
    <Panel>
      <h2 className="mb-3 flex flex-wrap items-center gap-2 text-lg font-semibold text-fg">
        Review settings
        <Badge tone={allActive ? 'success' : 'neutral'}>
          <span data-testid="review-settings-state">{allActive ? 'Set' : 'Incomplete'}</span>
        </Badge>
      </h2>
      <p className="mb-3 text-sm text-muted">
        The size budget a change is measured against, the unit it is measured in, and which paths make a
        change low, medium or high risk. Nothing is set by default: a check that needs a value stays inactive
        until it is set.
      </p>
      <Callout tone={allActive ? 'success' : 'warning'} className="mb-4" role="status">
        <ul className="flex flex-col gap-1" data-testid="review-settings-status">
          <StatusLine label="Size checks" status={status.size} testId="review-settings-status-size" />
          <StatusLine label="Risk from paths" status={status.risk} testId="review-settings-status-risk" />
        </ul>
      </Callout>

      {!canChange ? (
        <div className="flex flex-col gap-2 text-sm text-fg" data-testid="review-settings-readonly">
          <p>
            Size budget:{' '}
            <span data-testid="review-settings-budget-value">
              {saved.sizeBudget == null ? 'Not set' : saved.sizeBudget.toLocaleString('en')}
            </span>
          </p>
          <p>
            Size unit:{' '}
            <span data-testid="review-settings-unit-value">
              {saved.sizeUnit == null ? 'Not set' : SIZE_UNIT_LABELS[saved.sizeUnit]}
            </span>
          </p>
          <div>
            Path-to-risk map:{' '}
            {saved.riskMap == null ? (
              <span data-testid="review-settings-map-value">Not set</span>
            ) : (
              <ul className="mt-1 flex flex-col gap-1" data-testid="review-settings-map-value">
                {saved.riskMap.map((e) => (
                  <li key={e.pattern}>
                    <code className="font-mono">{e.pattern}</code>: {RISK_LABELS[e.risk]}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-subtle">Only the project owner can change these settings.</p>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput
              label="Size budget"
              name="sizeBudget"
              inputMode="numeric"
              pattern="[0-9]*"
              enterKeyHint="next"
              autoComplete="off"
              placeholder="Not set"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              error={budgetErr ?? undefined}
              hint="Leave empty for no budget."
              data-testid="review-settings-budget"
            />
            <Select
              label="Size unit"
              name="sizeUnit"
              value={unit}
              onChange={(e) => setUnit(e.target.value as SizeUnit | '')}
              data-testid="review-settings-unit"
            >
              <option value="">Not set</option>
              {SIZE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {SIZE_UNIT_LABELS[u]}
                </option>
              ))}
            </Select>
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-medium text-fg">Path-to-risk map</legend>
            <p className="text-xs text-subtle">
              A folder such as <code className="font-mono">apps/server/src/auth</code> covers everything under
              it; <code className="font-mono">*</code> and <code className="font-mono">**</code> work as in
              .gitignore. The highest class of any touched path wins.
            </p>
            {rows.length === 0 && (
              <p className="text-sm text-muted" data-testid="review-settings-map-empty">
                No paths yet: risk from paths stays inactive.
              </p>
            )}
            {rows.map((r, i) => (
              <div
                key={r.key}
                className="flex flex-col gap-2 rounded-control border border-control p-3 sm:flex-row sm:items-start sm:border-0 sm:p-0"
                data-testid="review-settings-row"
              >
                <div className="flex-1">
                  <TextInput
                    label={`Path ${i + 1}`}
                    ref={(el) => {
                      if (el) inputs.current.set(r.key, el);
                      else inputs.current.delete(r.key);
                    }}
                    value={r.pattern}
                    placeholder="apps/server/src/auth/**"
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    enterKeyHint="next"
                    onChange={(e) => updateRow(r.key, { pattern: e.target.value })}
                    error={problems[r.key]?.pattern}
                    data-testid="review-settings-pattern"
                  />
                </div>
                <div className="sm:w-40">
                  <Select
                    label={`Risk ${i + 1}`}
                    value={r.risk}
                    onChange={(e) => updateRow(r.key, { risk: e.target.value as RiskClass | '' })}
                    error={problems[r.key]?.risk}
                    data-testid="review-settings-risk"
                  >
                    <option value="">Choose</option>
                    {RISK_CLASSES.map((c) => (
                      <option key={c} value={c}>
                        {RISK_LABELS[c]}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button
                  variant="danger-ghost"
                  className="min-h-11 self-start sm:mt-7"
                  onClick={() => removeRow(r.key)}
                  aria-label={`Remove path ${i + 1}`}
                  data-testid="review-settings-remove"
                >
                  Remove
                </Button>
              </div>
            ))}
            <div>
              <Button className="min-h-11" onClick={addRow} data-testid="review-settings-add">
                Add path
              </Button>
            </div>
          </fieldset>

          <ErrorBox error={set.error} />
          <div>
            <Button
              type="submit"
              variant="primary"
              className="min-h-11"
              loading={set.isPending}
              data-testid="review-settings-save"
            >
              Save review settings
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

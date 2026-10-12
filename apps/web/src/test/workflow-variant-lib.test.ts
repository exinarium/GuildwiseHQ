import { BUILTIN_ROLES, codeWorkflowV1 } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  canMoveInserted,
  checkVariant,
  type EditorInsertion,
  materialise,
  moveInsertion,
  removeInsertion,
  updateInsertion,
  variantRows,
} from '../lib/workflowVariant.ts';

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const stage = (id: string, extra: object = {}) => ({
  id,
  label: id.toUpperCase(),
  claimRole: 'reviewer',
  doneCriteria: 'done',
  ...extra,
});
const spec = (insertions: EditorInsertion[]) => ({
  key: 'code-toy',
  name: 'Code (TOY)',
  projectId: PROJECT,
  insertions,
});
const ids = (insertions: EditorInsertion[]) =>
  variantRows(codeWorkflowV1, materialise(codeWorkflowV1, spec(insertions)), insertions).map((r) => r.id);

describe('variant editing on insertions', () => {
  const base = codeWorkflowV1.stages.map((s) => s.id);
  const at = base.indexOf('build');

  it('without insertions the rows are the base steps, none inserted', () => {
    const rows = variantRows(codeWorkflowV1, materialise(codeWorkflowV1, spec([])), []);
    expect(rows.map((r) => r.id)).toEqual(base);
    expect(rows.some((r) => r.inserted)).toBe(false);
  });

  it('places an insertion after the step it names and marks it inserted', () => {
    const ins: EditorInsertion[] = [{ after: 'build', stage: stage('sec') }];
    const rows = variantRows(codeWorkflowV1, materialise(codeWorkflowV1, spec(ins)), ins);
    expect(rows[at + 1]).toMatchObject({ id: 'sec', inserted: true });
    expect(rows.filter((r) => r.inserted)).toHaveLength(1);
  });

  it('falls back to a list when an insertion cannot be placed', () => {
    const ins: EditorInsertion[] = [{ after: 'nowhere', stage: stage('sec') }];
    expect(materialise(codeWorkflowV1, spec(ins))).toBeNull();
    expect(variantRows(codeWorkflowV1, null, ins).map((r) => r.id)).toEqual(base);
  });

  it('removing a step re-hangs the steps inserted after it', () => {
    const ins: EditorInsertion[] = [
      { after: 'build', stage: stage('a') },
      { after: 'a', stage: stage('b') },
    ];
    expect(removeInsertion(ins, 'a')).toEqual([{ after: 'build', stage: stage('b'), redirect: undefined }]);
    expect(ids(removeInsertion(ins, 'a'))[at + 1]).toBe('b');
  });

  it('renaming keeps the id', () => {
    const ins: EditorInsertion[] = [{ after: 'build', stage: stage('a') }];
    expect(updateInsertion(ins, 'a', { label: 'New name' })[0]?.stage).toMatchObject({
      id: 'a',
      label: 'New name',
    });
  });

  it('moves a step down and up, anchoring every inserted step on the step before it', () => {
    const ins: EditorInsertion[] = [{ after: 'build', stage: stage('a') }];
    const rows = variantRows(codeWorkflowV1, materialise(codeWorkflowV1, spec(ins)), ins);
    const next = rows[at + 2]?.id as string;
    const down = moveInsertion(ins, rows, 'a', 1);
    expect(down[0]?.after).toBe(next);
    expect(ids(down).slice(at, at + 3)).toEqual(['build', next, 'a']);
    const rows2 = variantRows(codeWorkflowV1, materialise(codeWorkflowV1, spec(down)), down);
    const up = moveInsertion(down, rows2, 'a', -1);
    expect(ids(up).slice(at, at + 3)).toEqual(['build', 'a', next]);
  });

  it('a step cannot move before the first step or past the final one', () => {
    const rows = variantRows(codeWorkflowV1, codeWorkflowV1, []);
    expect(canMoveInserted(rows, 1, -1)).toBe(false);
    expect(canMoveInserted(rows, rows.length - 2, 1)).toBe(false);
  });
});

describe('checkVariant', () => {
  it('is clean without insertions and words an unclaimable role in plain language', () => {
    expect(checkVariant(codeWorkflowV1, spec([]), BUILTIN_ROLES).errors).toBe(0);
    const bad = checkVariant(
      codeWorkflowV1,
      spec([{ after: 'docs', stage: stage('docs_check', { claimRole: 'writer' }) }]),
      BUILTIN_ROLES,
    );
    expect(bad.errors).toBe(1);
    expect(bad.byStage.get('docs_check')?.[0]?.text).toMatch(/role/i);
  });

  it('server issues replace the local ones', () => {
    const r = checkVariant(codeWorkflowV1, spec([{ after: 'build', stage: stage('a') }]), BUILTIN_ROLES, [
      { severity: 'error', code: 'role_cannot_claim_stage', message: 'x', stageId: 'a' },
    ]);
    expect(r.byStage.get('a')).toHaveLength(1);
  });
});

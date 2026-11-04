import { describe, expect, it } from 'vitest';
import {
  canTransitionRun,
  canTransitionStep,
  enabledReleaseDocsPrepSteps,
  isReleaseDocsPrepStep,
  nextReleaseDocsPrepAction,
  type ReleaseDocsPrepGateInput,
  type RunSnapshot,
  releaseDocsPrepGate,
  releaseDocsPrepSteps,
} from '../src/index.ts';

describe('release docs prep step registry', () => {
  it('lists analyse first and commit last', () => {
    const ids = releaseDocsPrepSteps().map((s) => s.id);
    expect(ids[0]).toBe('analyse');
    expect(ids[ids.length - 1]).toBe('commit');
  });
  it('knows only registered steps', () => {
    expect(isReleaseDocsPrepStep('analyse')).toBe(true);
    expect(isReleaseDocsPrepStep('videos')).toBe(false);
  });
  it('enables steps by default and honours the checklist', () => {
    expect(enabledReleaseDocsPrepSteps({ steps: {} }).map((s) => s.id)).toEqual(['analyse', 'commit']);
    expect(enabledReleaseDocsPrepSteps({ steps: { analyse: false } }).map((s) => s.id)).toEqual(['commit']);
  });
});

describe('release docs prep state machine', () => {
  it('moves a step forward only', () => {
    expect(canTransitionStep('pending', 'running')).toBe(true);
    expect(canTransitionStep('running', 'passed')).toBe(true);
    expect(canTransitionStep('running', 'failed')).toBe(true);
    expect(canTransitionStep('passed', 'running')).toBe(false);
    expect(canTransitionStep('pending', 'passed')).toBe(false);
  });
  it('moves a run not run -> running -> passed/failed/skipped, and failed -> skipped', () => {
    expect(canTransitionRun('not_run', 'running')).toBe(true);
    expect(canTransitionRun('not_run', 'skipped')).toBe(true);
    expect(canTransitionRun('running', 'passed')).toBe(true);
    expect(canTransitionRun('running', 'failed')).toBe(true);
    expect(canTransitionRun('running', 'skipped')).toBe(true);
    expect(canTransitionRun('failed', 'skipped')).toBe(true);
    expect(canTransitionRun('failed', 'running')).toBe(false);
    expect(canTransitionRun('passed', 'skipped')).toBe(false);
    expect(canTransitionRun('skipped', 'skipped')).toBe(false);
  });
});

const repo = (
  repoId: string,
  steps: RunSnapshot['repos'][number]['steps'] = [],
  state: RunSnapshot['repos'][number]['state'] = 'running',
) => ({ repoId, state, steps });

describe('nextReleaseDocsPrepAction', () => {
  const steps = ['analyse', 'commit'];
  it('dispatches the first step to every repo', () => {
    expect(nextReleaseDocsPrepAction({ status: 'running', steps, repos: [repo('a'), repo('b')] })).toEqual({
      kind: 'dispatch',
      step: 'analyse',
      repoIds: ['a', 'b'],
    });
  });
  it('waits while a repo is still running the step', () => {
    const r = nextReleaseDocsPrepAction({
      status: 'running',
      steps,
      repos: [
        repo('a', [{ step: 'analyse', state: 'passed' }]),
        repo('b', [{ step: 'analyse', state: 'running' }]),
      ],
    });
    expect(r).toEqual({ kind: 'wait' });
  });
  it('runs commit prepare everywhere, then push everywhere, then passes', () => {
    const done = { step: 'analyse', state: 'passed' as const };
    const prepared = (id: string) => repo(id, [done, { step: 'commit', phase: 'prepare', state: 'passed' }]);
    expect(
      nextReleaseDocsPrepAction({ status: 'running', steps, repos: [repo('a', [done]), repo('b', [done])] }),
    ).toEqual({ kind: 'dispatch', step: 'commit', phase: 'prepare', repoIds: ['a', 'b'] });
    expect(
      nextReleaseDocsPrepAction({ status: 'running', steps, repos: [prepared('a'), prepared('b')] }),
    ).toEqual({ kind: 'dispatch', step: 'commit', phase: 'push', repoIds: ['a', 'b'] });
    const pushed = (id: string) =>
      repo(id, [
        done,
        { step: 'commit', phase: 'prepare', state: 'passed' },
        { step: 'commit', phase: 'push', state: 'passed' },
      ]);
    expect(
      nextReleaseDocsPrepAction({ status: 'running', steps, repos: [pushed('a'), pushed('b')] }),
    ).toEqual({
      kind: 'finish',
      status: 'passed',
    });
  });
  it('fails the run on any failed repo and never reaches commit', () => {
    const r = nextReleaseDocsPrepAction({
      status: 'running',
      steps,
      repos: [
        repo('a', [{ step: 'analyse', state: 'passed' }]),
        repo('b', [{ step: 'analyse', state: 'failed', error: 'boom' }]),
      ],
    });
    expect(r).toEqual({ kind: 'finish', status: 'failed', step: 'analyse', repoId: 'b', error: 'boom' });
  });
  it('ignores a repo that was skipped (no release branch on origin)', () => {
    const r = nextReleaseDocsPrepAction({
      status: 'running',
      steps,
      repos: [repo('a', [{ step: 'analyse', state: 'passed' }]), repo('b', [], 'skipped')],
    });
    expect(r).toEqual({ kind: 'dispatch', step: 'commit', phase: 'prepare', repoIds: ['a'] });
  });
  it('does nothing for a run that is not running', () => {
    expect(nextReleaseDocsPrepAction({ status: 'skipped', steps, repos: [repo('a')] })).toEqual({
      kind: 'wait',
    });
  });
});

describe('releaseDocsPrepGate', () => {
  const base: ReleaseDocsPrepGateInput = {
    enabled: true,
    releaseBranch: 'release/1.5.0',
    run: { id: 'r1', status: 'passed', startedAt: '2026-11-04T10:00:00Z' },
    repo: { inRun: true, baseTag: 'v1.4.0', commitSha: null },
    lastPublishedAt: null,
    proposalLastTag: 'v1.4.0',
    facts: null,
  };
  const g = (over: Partial<ReleaseDocsPrepGateInput>) => releaseDocsPrepGate({ ...base, ...over });

  it('is a no-op when off, whatever the run says', () => {
    expect(g({ enabled: false, run: null })).toEqual({ allowed: true });
    expect(
      g({ enabled: false, run: { id: 'r', status: 'failed', startedAt: '2026-11-04T10:00:00Z' } }),
    ).toEqual({
      allowed: true,
    });
  });
  it('refuses with no run, naming release prep and the branch', () => {
    const r = g({ run: null });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('release_docs_prep_required');
      expect(r.message).toContain('Release prep (docs and videos)');
      expect(r.message).toContain('release/1.5.0');
    }
  });
  it('refuses while running and after a failure', () => {
    expect(g({ run: { id: 'r', status: 'running', startedAt: '2026-11-04T10:00:00Z' } }).allowed).toBe(false);
    const f = g({
      run: {
        id: 'r',
        status: 'failed',
        startedAt: '2026-11-04T10:00:00Z',
        failedStep: 'analyse',
        failedRepoName: 'cloud',
      },
    });
    expect(f.allowed).toBe(false);
    if (!f.allowed) expect(f.message).toContain('analyse in cloud');
  });
  it('allows after skip and after a passed run', () => {
    expect(g({ run: { id: 'r', status: 'skipped', startedAt: '2026-11-04T10:00:00Z' } }).allowed).toBe(true);
    expect(g({}).allowed).toBe(true);
  });
  it('refuses a run older than the last published ship', () => {
    expect(g({ lastPublishedAt: '2026-11-04T11:00:00Z' }).allowed).toBe(false);
    expect(g({ lastPublishedAt: '2026-11-04T09:00:00Z' }).allowed).toBe(true);
  });
  it('refuses a passed run of an earlier release or without the repo', () => {
    expect(g({ proposalLastTag: 'v1.5.0' }).allowed).toBe(false);
    // analyse unticked: no base tag was recorded, so it is not compared
    expect(
      g({ proposalLastTag: 'v1.5.0', repo: { inRun: true, baseTag: null, commitSha: null, analysed: false } })
        .allowed,
    ).toBe(true);
    expect(g({ repo: { inRun: false, baseTag: null, commitSha: null } }).allowed).toBe(false);
  });
  it('wants the prep commit in the facts read', () => {
    const repo = { inRun: true, baseTag: 'v1.4.0', commitSha: 'abc' };
    expect(g({ repo, facts: null }).allowed).toBe(false);
    expect(g({ repo, facts: { headSha: 'zzz', commitShas: ['q'], truncated: false } }).allowed).toBe(false);
    expect(g({ repo, facts: { headSha: 'abc', commitShas: [], truncated: false } }).allowed).toBe(true);
    expect(g({ repo, facts: { headSha: 'zzz', commitShas: ['abc'], truncated: false } }).allowed).toBe(true);
    expect(g({ repo, facts: { headSha: 'zzz', commitShas: [], truncated: true } }).allowed).toBe(true);
  });
});

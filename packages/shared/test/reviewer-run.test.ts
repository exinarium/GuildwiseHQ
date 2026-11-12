import { describe, expect, it } from 'vitest';
import {
  ProjectRepoDtoSchema,
  RepoReportSchema,
  ReviewerRunSpecSchema,
  ReviewerTokenFactSchema,
  ReviewFindingSchema,
} from '../src/index.ts';

const UUID = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const spec = {
  runId: UUID,
  projectId: UUID,
  projectRepoId: UUID,
  remoteUrlNormalized: 'github.com/acme/toy',
  prNumber: 7,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  baseRef: 'main',
};

describe('AC3: reviewer payloads carry no credential', () => {
  it('ReviewerRunSpec accepts the run and rejects a token key or a bad sha', () => {
    expect(ReviewerRunSpecSchema.safeParse(spec).success).toBe(true);
    expect(ReviewerRunSpecSchema.safeParse({ ...spec, token: 'github_pat_X' }).success).toBe(false);
    expect(ReviewerRunSpecSchema.safeParse({ ...spec, headSha: 'main' }).success).toBe(false);
    expect(ReviewerRunSpecSchema.safeParse({ ...spec, baseRef: '--upload-pack=x' }).success).toBe(false);
  });

  it('ReviewerTokenFact is a flag with an optional reason and refuses a token key', () => {
    expect(ReviewerTokenFactSchema.safeParse({ present: true }).success).toBe(true);
    expect(ReviewerTokenFactSchema.safeParse({ present: false, problem: 'unreadable' }).success).toBe(true);
    expect(ReviewerTokenFactSchema.safeParse({ present: true, token: 'github_pat_X' }).success).toBe(false);
    expect(ReviewerTokenFactSchema.safeParse({ present: false, problem: 'secret text' }).success).toBe(false);
  });

  it('RepoReport and the repository DTO take the flag as an optional, additive field', () => {
    const rep = { remoteUrl: 'https://github.com/acme/toy.git', localPath: '/x', headBranch: 'main' };
    expect(RepoReportSchema.safeParse(rep).success).toBe(true);
    expect(RepoReportSchema.parse({ ...rep, reviewerToken: { present: true } }).reviewerToken).toEqual({
      present: true,
    });
    const dto = {
      id: UUID,
      projectId: UUID,
      name: 'toy',
      remoteUrl: rep.remoteUrl,
      remoteUrlNormalized: 'github.com/acme/toy',
      workingBranch: null,
      removedAt: null,
    };
    expect(ProjectRepoDtoSchema.safeParse(dto).success).toBe(true);
    for (const v of ['present', 'missing', null])
      expect(ProjectRepoDtoSchema.parse({ ...dto, reviewerToken: v }).reviewerToken).toBe(v);
    expect(ProjectRepoDtoSchema.safeParse({ ...dto, reviewerToken: 'github_pat_X' }).success).toBe(false);
  });

  it('a finding needs a title and a body and takes no extra keys', () => {
    expect(ReviewFindingSchema.safeParse({ title: 't', body: 'b', path: 'a.ts', line: 3 }).success).toBe(
      true,
    );
    expect(ReviewFindingSchema.safeParse({ title: 't' }).success).toBe(false);
    expect(ReviewFindingSchema.safeParse({ title: 't', body: 'b', event: 'APPROVE' }).success).toBe(false);
  });
});

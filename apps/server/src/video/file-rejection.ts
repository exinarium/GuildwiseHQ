import type { ReelsCheck, VideoFileRejection } from '@aom/shared';
import { VIDEO_FILE_REJECTIONS } from '@aom/shared';

/** Which file Instagram refused. A re-render rewrites the render row, so `finishedAt` changes and a new file never matches. */
export interface ArtifactFingerprint {
  renderId: string;
  finishedAt: string | null;
  bytes: number;
}

/** `social_shares.detail.fileRejection` of the Instagram share: the file was refused while Instagram processed it. */
export interface FileRejection {
  kind: VideoFileRejection;
  artifact: ArtifactFingerprint;
  /** ProcessingFailedError answers for this artifact (0: the new file failed the check before it was sent). */
  rejections: number;
  at: string;
  error: string;
  check: ReelsCheck | null;
}

export const isoOrNull = (d: unknown): string | null =>
  d instanceof Date ? d.toISOString() : typeof d === 'string' ? new Date(d).toISOString() : null;

/** The record out of the jsonb, or undefined when there is none (old rows) or it is not shaped like one. */
export function readFileRejection(detail: unknown): FileRejection | undefined {
  const r = (detail as { fileRejection?: Partial<FileRejection> } | null | undefined)?.fileRejection;
  if (!r || typeof r !== 'object') return undefined;
  if (!VIDEO_FILE_REJECTIONS.includes(r.kind as VideoFileRejection)) return undefined;
  const a = r.artifact;
  if (!a || typeof a.renderId !== 'string' || typeof a.bytes !== 'number') return undefined;
  return {
    kind: r.kind as VideoFileRejection,
    artifact: { renderId: a.renderId, finishedAt: a.finishedAt ?? null, bytes: a.bytes },
    rejections: typeof r.rejections === 'number' ? r.rejections : 1,
    at: String(r.at ?? ''),
    error: String(r.error ?? ''),
    check: r.check ?? null,
  };
}

export function sameArtifact(a: ArtifactFingerprint, b: ArtifactFingerprint): boolean {
  return !!a.finishedAt && a.renderId === b.renderId && a.finishedAt === b.finishedAt && a.bytes === b.bytes;
}

/** "edit list present (vide); moov not at start" */
export function rejectionReasons(r: FileRejection): string {
  const failed = r.check?.failed ?? [];
  return failed.length > 0 ? failed.map((f) => f.message).join('; ') : r.error;
}

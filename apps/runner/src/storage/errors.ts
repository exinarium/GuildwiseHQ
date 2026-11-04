import type { StorageKind } from '@aom/shared';
import { StorageError } from './types.ts';

/** Maps an HTTP answer of a storage API to a typed error (docs/investigations/GWP-63 section 4.3). */
export function fromHttp(kind: StorageKind, status: number, code?: string): StorageError {
  const c = (code ?? '').toLowerCase();
  const has = (...names: string[]) => names.some((n) => c === n.toLowerCase());
  if (status === 401) return new StorageError('auth_expired', 'The sign-in expired: reconnect this storage.');
  if (status === 413) return new StorageError('too_large', 'The file is too large for this storage.');
  if (
    status === 507 ||
    has(
      'quotaLimitReached',
      'insufficientStorage',
      'storageQuotaExceeded',
      'quotaExceeded',
      'QuotaExceeded',
      'XMinioStorageFull',
    )
  )
    return new StorageError('quota', 'The storage is full.');
  if (has('EntityTooLarge')) return new StorageError('too_large', 'The file is too large for this storage.');
  if (kind === 's3' && status === 403) {
    if (has('InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'InvalidToken'))
      return new StorageError('auth_expired', 'The access key was refused: enter the keys again.');
    return new StorageError('permission', 'The storage refused access to the bucket.');
  }
  if (has('NoSuchBucket') || (status === 404 && kind !== 'google_drive' && kind !== 'onedrive'))
    return new StorageError('not_found', 'The bucket or folder was not found.');
  if (status === 404) return new StorageError('not_found', 'The drive or site was not found.');
  if (
    has('userRateLimitExceeded', 'rateLimitExceeded', 'SlowDown', 'locked') ||
    status === 429 ||
    status === 423 ||
    status >= 500
  )
    return new StorageError('unavailable', 'The storage is busy or unavailable: try again.');
  if (status === 403 || (status === 400 && has('accessDenied')))
    return new StorageError('permission', 'The storage refused this action.');
  return new StorageError('unavailable', `The storage answered with an unexpected status ${status}.`);
}

/** Maps a Node file-system or network error to a typed error. Never includes the path. */
export function fromNodeError(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  const code = (err as { code?: string } | null)?.code ?? '';
  const name = (err as { name?: string } | null)?.name ?? '';
  if (['EACCES', 'EPERM', 'EROFS'].includes(code))
    return new StorageError('permission', 'This workstation may not write to the folder.');
  if (['ENOSPC', 'EDQUOT'].includes(code)) return new StorageError('quota', 'The disk is full.');
  if (code === 'EFBIG') return new StorageError('too_large', 'The file is too large for this storage.');
  if (code === 'ENOENT')
    return new StorageError('not_found', 'The folder was not found on this workstation.');
  if (name === 'AbortError' || name === 'TimeoutError')
    return new StorageError('timeout', 'The storage did not answer in time.');
  return new StorageError('unavailable', 'The storage could not be reached.');
}

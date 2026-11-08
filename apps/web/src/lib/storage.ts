import type { StorageConnectionDto, StorageErrorCode, StorageKind } from '@aom/shared';

export const STORAGE_KIND_LABEL: Record<StorageKind, string> = {
  onedrive: 'OneDrive / SharePoint',
  google_drive: 'Google Drive',
  s3: 'S3-compatible storage',
  local: 'Local folder or NAS',
  vault: 'Knowledge vault folder',
};

export const STORAGE_KIND_HELP: Record<StorageKind, string> = {
  onedrive:
    'You sign in on your workstation with a code. Files go to a folder in your OneDrive, or in a SharePoint site if you enter its address.',
  google_drive:
    'You sign in on your workstation with a code. Guildwise can only see the folder it creates; you can move or share that folder afterwards.',
  s3: 'Keys are sealed in your browser for your workstation and never stored on the Guildwise server.',
  local: 'A folder (or network share) that your workstation can write to.',
  vault:
    'A folder inside one of your knowledge vaults. Files stay in the vault history even after they are deleted.',
};

export type StorageTone = 'success' | 'warning' | 'danger' | 'neutral';

/** The label and tone of a connection's state. */
export function storageStateLabel(c: StorageConnectionDto): { label: string; tone: StorageTone } {
  switch (c.health.state) {
    case 'connected':
      return { label: 'Connected', tone: 'success' };
    case 'needs_reauth':
      return { label: 'Needs re-authentication', tone: 'warning' };
    case 'runner_offline':
      return { label: 'Workstation offline', tone: 'warning' };
    case 'unavailable':
      return { label: 'Unavailable', tone: 'danger' };
    case 'permission':
      return { label: 'No permission', tone: 'danger' };
    case 'quota':
      return { label: 'Storage full', tone: 'danger' };
    case 'not_on_workstation':
      return { label: `Not set up on ${c.workstation.name}`, tone: 'warning' };
    default:
      return { label: 'Not connected yet', tone: 'neutral' };
  }
}

const ERROR_TEXT: Record<StorageErrorCode, string> = {
  auth_expired: 'The sign-in expired. Reconnect this storage.',
  unavailable: 'The storage could not be reached. Try again in a moment.',
  quota: 'The storage is full.',
  permission: 'The storage refused access. Check the permissions of the folder.',
  not_found: 'The folder or bucket was not found.',
  invalid: 'The details are not valid.',
  too_large: 'The file is too large for this storage.',
  conflict: 'A file with this name already exists.',
  runner_offline: 'The workstation is offline.',
  timeout: 'The storage did not answer in time.',
  malware_detected: 'A file was refused by the malware scan.',
  scan_unavailable: 'The malware scan (clamd) on the workstation is not reachable.',
};

export const storageErrorText = (code: StorageErrorCode | null, message: string | null): string =>
  message ?? (code ? ERROR_TEXT[code] : 'Something went wrong');

/** Whether the Connect (first sign-in) or Reconnect action applies. */
export function storageConnectAction(c: StorageConnectionDto): 'connect' | 'reconnect' | null {
  if (!c.canConnect) return null;
  if (c.health.state === 'pending') return 'connect';
  if (c.health.state === 'needs_reauth') return 'reconnect';
  return null;
}

export const isOAuthKind = (k: StorageKind): boolean => k === 'onedrive' || k === 'google_drive';

/** Keeps the page up to date while something is in progress. */
export const storageNeedsPolling = (list: StorageConnectionDto[] | undefined): boolean =>
  !!list?.some((c) => c.health.state === 'pending' || c.health.state === 'runner_offline');

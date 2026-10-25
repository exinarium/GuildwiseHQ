import extension from '@aom/web-extension';
import type { WebExtension } from './types.ts';

/** The web extension of this build (an empty one for the open-source app). */
export const ext: WebExtension = extension;
export type { WebExtension } from './types.ts';

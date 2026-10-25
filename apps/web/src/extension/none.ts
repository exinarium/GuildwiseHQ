import type { WebExtension } from './types.ts';

/** The open-source build: no extension. The build swaps this module for the hosted extension (see vite.config.ts). */
const none: WebExtension = {};
export default none;

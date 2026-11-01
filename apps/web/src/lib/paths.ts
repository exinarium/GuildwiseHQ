/**
 * The app's Releases page. It is not at `/releases`: the server owns that address (the public release blog,
 * `/releases` and `/releases/<version>`), so a reload or a shared link of it would never reach the app.
 * `/releases` and `/deploys` stay as client-side redirects for old in-app links.
 */
export const RELEASES_PATH = '/delivery/releases';
